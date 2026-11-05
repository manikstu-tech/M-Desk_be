import { Action, RoleName, type Prisma } from "@prisma/client";
import { db } from "./db";
import { authorize, type AuthSession } from "./authorize";
import { writeAudit, type Tx } from "./audit";
import { activeGrant } from "./documents";
import { isDeptMember } from "./tasks";
import { ApiError } from "./validation";
import { HR_SLUG } from "./hr-catalogue";

// HR module access (spec §2): Super Admin sees everything; HR department members
// may view; every write needs an explicit grant on the HR department — EDIT for
// HR Admin work, APPROVE for approvals, UPLOAD for documents, EXPORT for reports.
// Checks run server-side here; UI visibility (hrCan) is a convenience only.

export type HrDept = { id: string; name: string };

export async function hrDept(): Promise<HrDept> {
  const dept = await db.department.findUnique({
    where: { slug: HR_SLUG },
    select: { id: true, name: true, active: true },
  });
  if (!dept || !dept.active) throw new ApiError(404, "NOT_FOUND", "HR department is not configured");
  return { id: dept.id, name: dept.name };
}

function isSuper(session: AuthSession) {
  return session.user.role.name === RoleName.SUPER_ADMIN;
}

/** API gate: VIEW lets HR members in; anything else needs a grant (denials audited). */
export async function requireHr(session: AuthSession, action: Action): Promise<HrDept> {
  const dept = await hrDept();
  if (isSuper(session)) return dept;
  if (action === Action.VIEW && (await isDeptMember(session.user.id, dept.id))) return dept;
  await authorize(session, { departmentId: dept.id, action });
  return dept;
}

/** Page gate: same rule as requireHr(VIEW), returning null instead of throwing. */
export async function hrWorkspace(session: AuthSession): Promise<HrDept | null> {
  try {
    return await requireHr(session, Action.VIEW);
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
}

/** Whether to show a control. Never a substitute for requireHr on the server. */
export async function hrCan(session: AuthSession, action: Action): Promise<boolean> {
  if (isSuper(session)) return true;
  const dept = await hrDept();
  const grant = await db.delegationGrant.findFirst({
    where: { userId: session.user.id, departmentId: dept.id, action, ...activeGrant() },
    select: { id: true },
  });
  return grant !== null;
}

/** People who act on HR alerts: Super Admins plus holders of an HR EDIT grant. */
export async function hrAdminIds(): Promise<string[]> {
  const dept = await hrDept();
  const [supers, grants] = await Promise.all([
    db.user.findMany({ where: { role: { name: RoleName.SUPER_ADMIN }, status: "ACTIVE" }, select: { id: true } }),
    db.delegationGrant.findMany({
      where: { departmentId: dept.id, action: Action.EDIT, ...activeGrant() },
      select: { userId: true },
    }),
  ]);
  return [...new Set([...supers.map((u) => u.id), ...grants.map((g) => g.userId)])];
}

/** HR audit entry (§9): actor, action, object, safe change summary — never document contents. */
export async function hrAudit(
  tx: Tx,
  session: AuthSession | null,
  deptId: string,
  e: { action: string; targetType: string; targetId?: string | null; detail?: Prisma.InputJsonValue },
) {
  await writeAudit(tx, {
    actorId: session?.user.id ?? null,
    actorEmail: session?.user.email ?? "system",
    departmentId: deptId,
    ...e,
  });
}

// ───────────── feed helpers ─────────────

// Never surface denials in the general activity feed.
export function isFeedSafe(action: string): boolean {
  return !action.startsWith("DENIED_");
}

/** "HR_LETTER_APPROVED" → "Letter approved". */
export function activityLabel(action: string): string {
  const words = action.toLowerCase().split("_").filter(Boolean);
  if (words[0] === "hr") words.shift();
  if (words[0] === "wf") words[0] = "workflow";
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function timeAgo(then: Date, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - then.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function fmtDate(d: Date | null | undefined): string {
  return d ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}

/** Audit timeline for one HR object (employee, letter, email, document…). */
export async function timelineFor(targetIds: string[]) {
  if (targetIds.length === 0) return [];
  return db.auditEvent.findMany({
    where: { targetId: { in: targetIds } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      action: true,
      outcome: true,
      detail: true,
      createdAt: true,
      actorEmail: true,
      actor: { select: { name: true } },
    },
  });
}
