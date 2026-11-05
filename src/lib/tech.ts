import { Action, RoleName, type Confidentiality, type Prisma } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { writeAudit, type Tx } from "./audit";
import { activeGrant } from "./documents";
import { ApiError } from "./validation";
import { TECH_SLUG } from "./tech-catalogue";

// Technology & MIS access (blueprint §11). Roles come from the existing RoleName
// enum and department membership — no new roles. Grants on the department add
// to them: EDIT makes someone an agent, APPROVE a lead, a named L4 VIEW grant
// opens security incidents. UI visibility is a convenience; every API path
// re-checks here.

export type TechDept = { id: string; name: string };

export type TechAccess = {
  dept: TechDept;
  userId: string;
  role: RoleName;
  isSuper: boolean;
  /** Member of technology-mis (or Super Admin): may open the workspace. */
  member: boolean;
  /** Works items: edits, comments internally, transitions. */
  agent: boolean;
  /** Team lead: assigns anyone, approves minor changes, closes. */
  lead: boolean;
  /** Tech & MIS Head: approves major changes, configures. */
  head: boolean;
  seesL3: boolean;
  seesL4: boolean;
  /** CSV exports (§11): leads, auditors, compliance or an EXPORT grant. */
  exporter: boolean;
};

export async function techDept(): Promise<TechDept> {
  const dept = await db.department.findUnique({
    where: { slug: TECH_SLUG },
    select: { id: true, name: true, active: true },
  });
  if (!dept || !dept.active) throw new ApiError(404, "NOT_FOUND", "Technology & MIS department is not configured");
  return { id: dept.id, name: dept.name };
}

const AGENT_ROLES: RoleName[] = [RoleName.ADMIN, RoleName.MANAGER, RoleName.OFFICER];
const LEAD_ROLES: RoleName[] = [RoleName.ADMIN, RoleName.MANAGER];
const AUDIT_ROLES: RoleName[] = [RoleName.DEPT_AUDITOR, RoleName.SYSTEM_DATA_COMPLIANCE];
const L3_READERS: RoleName[] = [RoleName.ADMIN, RoleName.MANAGER, RoleName.DEPT_AUDITOR, RoleName.SYSTEM_DATA_COMPLIANCE];

export async function techAccess(session: AuthSession): Promise<TechAccess> {
  const dept = await techDept();
  const role = session.user.role.name;
  const userId = session.user.id;
  if (role === RoleName.SUPER_ADMIN) {
    return { dept, userId, role, isSuper: true, member: true, agent: true, lead: true, head: true, seesL3: true, seesL4: true, exporter: true };
  }
  const [membership, grants] = await Promise.all([
    db.departmentMembership.findUnique({ where: { userId_departmentId: { userId, departmentId: dept.id } } }),
    db.delegationGrant.findMany({
      where: { userId, departmentId: dept.id, ...activeGrant() },
      select: { action: true, confidentiality: true },
    }),
  ]);
  const member = membership !== null;
  const has = (a: Action) => grants.some((g) => g.action === a);
  const head = member && role === RoleName.ADMIN;
  const lead = (member && LEAD_ROLES.includes(role)) || has(Action.APPROVE);
  const agent = (member && AGENT_ROLES.includes(role)) || has(Action.EDIT) || lead;
  return {
    dept,
    userId,
    role,
    isSuper: false,
    member,
    agent,
    lead,
    head,
    seesL3: member && (L3_READERS.includes(role) || has(Action.VIEW)),
    seesL4:
      head ||
      (member && role === RoleName.SYSTEM_DATA_COMPLIANCE) ||
      grants.some((g) => g.action === Action.VIEW && g.confidentiality === "L4"),
    exporter: lead || has(Action.EXPORT) || (member && AUDIT_ROLES.includes(role)),
  };
}

/**
 * Who decides assignments: the Super Admin and the Tech & MIS Head. They pick the
 * person, the part of the work (lane) and give instructions; nobody else assigns
 * work to someone else or takes an existing item.
 */
export function canAssign(access: TechAccess): boolean {
  return access.head;
}

/** Page gate: workspace pages are for department members (§3); others use the portal. */
export async function techWorkspace(session: AuthSession): Promise<TechAccess | null> {
  const access = await techAccess(session);
  return access.member ? access : null;
}

type VisibleItem = {
  confidentiality: Confidentiality;
  reporterId: string;
  requestedForId: string | null;
  assigneeId: string | null;
};

export function isRequester(userId: string, item: Pick<VisibleItem, "reporterId" | "requestedForId">): boolean {
  return item.reporterId === userId || item.requestedForId === userId;
}

/** Visibility ladder for one item (§11): participants always, members by level. */
export function canSeeItem(access: TechAccess, item: VisibleItem, watcherIds: string[] = []): boolean {
  if (access.isSuper) return true;
  if (isRequester(access.userId, item) || item.assigneeId === access.userId || watcherIds.includes(access.userId)) return true;
  if (!access.member) return false;
  if (item.confidentiality === "L4") return access.seesL4;
  if (item.confidentiality === "L3") return access.seesL3;
  return true;
}

/** The same ladder as a Prisma filter, so lists, counts and exports agree with canSeeItem. */
export function visibleItemsWhere(access: TechAccess): Prisma.TechItemWhereInput {
  if (access.isSuper) return {};
  const me = access.userId;
  const participant: Prisma.TechItemWhereInput[] = [
    { reporterId: me },
    { requestedForId: me },
    { assigneeId: me },
    { watchers: { some: { userId: me } } },
  ];
  if (!access.member) return { OR: participant };
  const levels: Confidentiality[] = ["L1", "L2"];
  if (access.seesL3) levels.push("L3");
  if (access.seesL4) levels.push("L4");
  return { OR: [...participant, { confidentiality: { in: levels } }] };
}

/** Tech Head(s) for escalations: ADMIN members of the department, else Super Admins. */
export async function techHeadIds(deptId: string): Promise<string[]> {
  const heads = await db.user.findMany({
    where: { status: "ACTIVE", role: { name: RoleName.ADMIN }, memberships: { some: { departmentId: deptId } } },
    select: { id: true },
  });
  if (heads.length > 0) return heads.map((u) => u.id);
  const supers = await db.user.findMany({
    where: { status: "ACTIVE", role: { name: RoleName.SUPER_ADMIN } },
    select: { id: true },
  });
  return supers.map((u) => u.id);
}

/** People who assign work (canAssign): every active Super Admin plus the Tech Head(s). */
export async function techAssignerIds(deptId: string): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ role: { name: RoleName.SUPER_ADMIN } }, { role: { name: RoleName.ADMIN }, memberships: { some: { departmentId: deptId } } }],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Team leads (MANAGER members); falls back to the Head when none is named yet (TM-D1). */
export async function techLeadIds(deptId: string): Promise<string[]> {
  const leads = await db.user.findMany({
    where: { status: "ACTIVE", role: { name: RoleName.MANAGER }, memberships: { some: { departmentId: deptId } } },
    select: { id: true },
  });
  return leads.length > 0 ? leads.map((u) => u.id) : techHeadIds(deptId);
}

/** Department staff who can be assigned work. */
export async function techAgents(deptId: string) {
  return db.user.findMany({
    where: { status: "ACTIVE", role: { name: { in: AGENT_ROLES } }, memberships: { some: { departmentId: deptId } } },
    select: { id: true, name: true, email: true, role: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
}

export async function techAudit(
  tx: Tx,
  session: AuthSession | null,
  deptId: string,
  e: { action: string; targetType: string; targetId?: string | null; outcome?: "SUCCESS" | "DENIED" | "FAILED"; detail?: Prisma.InputJsonValue },
) {
  await writeAudit(tx, {
    actorId: session?.user.id ?? null,
    actorEmail: session?.user.email ?? "system",
    departmentId: deptId,
    ...e,
  });
}

export function requireAgent(access: TechAccess) {
  if (!access.agent) throw new ApiError(403, "FORBIDDEN", "Only Technology & MIS staff can do this");
}
