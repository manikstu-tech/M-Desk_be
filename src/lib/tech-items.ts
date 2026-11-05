import type { Confidentiality, Prisma, TechItemType, TechPriority } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import type { Tx } from "./audit";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import {
  canAssign,
  canSeeItem,
  isRequester,
  requireAgent,
  techAccess,
  techAgents,
  techAssignerIds,
  techAudit,
  techDept,
  techHeadIds,
  techLeadIds,
  visibleItemsWhere,
  type TechAccess,
} from "./tech";
import {
  ALL_TERMINAL,
  AUTO_CLOSE_WORKDAYS,
  addWorkingDays,
  CATEGORIES,
  CHANGE_RISK,
  flowOf,
  hasSla,
  isTerminal,
  itemHref,
  KEY_PREFIX,
  PAUSE_STATUSES,
  portalHref,
  priorityFor,
  RENEWAL_ALERT_DAYS,
  REOPEN_DAYS,
  RESOLVED_STATUSES,
  slaState,
  slaTargets,
  slaUsed,
  statusLabel,
  transitionFor,
  TYPE_META,
  type ActorKind,
  type ChangeRisk,
  type Need,
  type SlaItem,
  type Transition,
} from "./tech-catalogue";
import { DETAILS_SCHEMA, type ItemFilters } from "./tech-validation";
import type { z } from "zod";
import type { commentSchema, createItemSchema, csatSchema, linkSchema, transitionSchema, updateItemSchema } from "./tech-validation";

const DAY = 24 * 60 * 60 * 1000;

const person = { select: { id: true, name: true, email: true } } as const;

export const itemInclude = {
  reporter: person,
  requestedFor: person,
  assignee: person,
  assignedBy: person,
  parent: { select: { key: true, title: true } },
  watchers: { select: { userId: true } },
} satisfies Prisma.TechItemInclude;

export type TechItemRow = Prisma.TechItemGetPayload<{ include: typeof itemInclude }>;

type Details = Record<string, unknown>;

function detailsOf(item: { details: Prisma.JsonValue }): Details {
  const d = item.details;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Details) : {};
}

function str(d: Details, k: string): string | undefined {
  const v = d[k];
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function changeRisk(item: { details: Prisma.JsonValue }): ChangeRisk {
  const r = str(detailsOf(item), "risk");
  return r && r in CHANGE_RISK ? (r as ChangeRisk) : "MINOR";
}

/** zod-validates type-specific details and merges them over what is stored. */
function mergeDetails(type: TechItemType, current: Details, patch: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  const schema = DETAILS_SCHEMA[type];
  if (!schema) return Object.keys(current).length ? (current as Prisma.InputJsonValue) : undefined;
  const parsed = schema.parse({ ...current, ...(patch ?? {}) }) as Details;
  // Dates go to JSON as ISO strings; drop empty keys
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

const LEVEL: Record<Confidentiality, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function atLeast(min: Confidentiality, wanted: Confidentiality | undefined): Confidentiality {
  return wanted && LEVEL[wanted] > LEVEL[min] ? wanted : min;
}

async function nextKey(tx: Tx): Promise<string> {
  const seq = await tx.techSequence.upsert({
    where: { prefix: KEY_PREFIX },
    create: { prefix: KEY_PREFIX, next: 2 },
    update: { next: { increment: 1 } },
  });
  return `${KEY_PREFIX}-${seq.next - 1}`;
}

function others(ids: (string | null | undefined)[], except: string | null): string[] {
  return [...new Set(ids.filter((id): id is string => !!id && id !== except))];
}

// ───────────── read ─────────────

/** Loads an item the session may see; 404 otherwise, with the denial audited (§11). */
export async function requireItem(session: AuthSession, key: string): Promise<{ item: TechItemRow; access: TechAccess }> {
  const access = await techAccess(session);
  const item = await db.techItem.findUnique({ where: { key }, include: itemInclude });
  if (!item) throw new ApiError(404, "NOT_FOUND", "Item not found");
  if (!canSeeItem(access, item, item.watchers.map((w) => w.userId))) {
    await db.$transaction((tx) =>
      techAudit(tx, session, access.dept.id, {
        action: "DENIED_TECH_VIEW",
        targetType: "TechItem",
        targetId: item.id,
        outcome: "DENIED",
        detail: { key },
      }),
    );
    throw new ApiError(404, "NOT_FOUND", "Item not found");
  }
  return { item, access };
}

export function itemFilterWhere(filters: ItemFilters, userId: string, now = new Date()): Prisma.TechItemWhereInput {
  const and: Prisma.TechItemWhereInput[] = [];
  if (filters.types?.length) and.push({ type: { in: filters.types } });
  if (filters.status !== "all") {
    and.push(filters.status === "closed" ? { status: { in: ALL_TERMINAL } } : { status: { notIn: ALL_TERMINAL } });
  }
  if (filters.priority) and.push({ priority: filters.priority });
  if (filters.lane) and.push({ component: filters.lane });
  if (filters.assignee === "me") and.push({ assigneeId: userId });
  if (filters.assignee === "unassigned") and.push({ assigneeId: null });
  if (filters.sla) and.push({ resolvedAt: null, slaPausedAt: null, resolveDueAt: { not: null } });
  if (filters.sla === "breached") and.push({ resolveDueAt: { lt: now } });
  if (filters.days) and.push({ createdAt: { gte: new Date(now.getTime() - filters.days * DAY) } });
  if (filters.q) {
    const q = filters.q;
    and.push({
      OR: [
        { key: { equals: q.toUpperCase() } },
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  return { AND: and };
}

export async function listItems(access: TechAccess, filters: ItemFilters, take = 500): Promise<TechItemRow[]> {
  const now = new Date();
  const rows = await db.techItem.findMany({
    where: { AND: [visibleItemsWhere(access), itemFilterWhere(filters, access.userId, now)] },
    include: itemInclude,
    orderBy: [{ priority: "asc" }, { resolveDueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take,
  });
  // "at risk" is a share of each item's own window, so it is filtered after the query
  return filters.sla === "at_risk" ? rows.filter((r) => (slaUsed(r, now) ?? 0) >= 0.75 && (slaUsed(r, now) ?? 0) < 1) : rows;
}

/** My Queue: my own work for everyone; for whoever assigns (canAssign) also the pool to assign and all assigned work. */
export async function myQueue(access: TechAccess) {
  const visible = visibleItemsWhere(access);
  const open = { status: { notIn: ALL_TERMINAL } };
  const order: Prisma.TechItemOrderByWithRelationInput[] = [{ resolveDueAt: { sort: "asc", nulls: "last" } }, { priority: "asc" }, { createdAt: "asc" }];
  const assigner = canAssign(access);
  const [mine, unassigned, assigned, raised] = await Promise.all([
    db.techItem.findMany({ where: { assigneeId: access.userId, ...open }, include: itemInclude, orderBy: order }),
    assigner
      ? db.techItem.findMany({ where: { AND: [visible, { assigneeId: null, ...open }] }, include: itemInclude, orderBy: [{ priority: "asc" }, ...order], take: 100 })
      : Promise.resolve([]),
    assigner
      ? db.techItem.findMany({ where: { AND: [visible, { assigneeId: { not: null }, ...open }] }, include: itemInclude, orderBy: order, take: 500 })
      : Promise.resolve([]),
    db.techItem.findMany({
      where: { OR: [{ reporterId: access.userId }, { requestedForId: access.userId }], ...open },
      include: itemInclude,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return { mine, unassigned, assigned, raised };
}

export type Workload = { id: string; name: string; open: number; urgent: number; atRisk: number; breached: number };

/** Open work per staff member — what the assigner looks at to decide who has room. */
export function workloadOf(
  agents: { id: string; name: string }[],
  items: (SlaItem & { assigneeId: string | null; priority: TechPriority })[],
  now = new Date(),
): Workload[] {
  const rows = new Map(agents.map((a) => [a.id, { id: a.id, name: a.name, open: 0, urgent: 0, atRisk: 0, breached: 0 }]));
  for (const i of items) {
    const w = i.assigneeId ? rows.get(i.assigneeId) : undefined;
    if (!w) continue;
    w.open++;
    if (i.priority === "P1" || i.priority === "P2") w.urgent++;
    const state = slaState(i, now);
    if (state === "breached") w.breached++;
    else if (state === "at_risk") w.atRisk++;
  }
  return [...rows.values()].sort((a, b) => a.open - b.open || a.name.localeCompare(b.name));
}

/** Everything the detail page shows; internal notes only for department members. */
export async function itemDetail(session: AuthSession, key: string) {
  const { item, access } = await requireItem(session, key);
  const staffView = access.member;
  const [comments, linksFrom, linksTo, children, timeline, transitions, agents] = await Promise.all([
    db.techComment.findMany({
      where: { itemId: item.id, ...(staffView ? {} : { internal: false }) },
      orderBy: { createdAt: "asc" },
      include: { author: { select: { id: true, name: true } } },
    }),
    db.techLink.findMany({ where: { fromId: item.id }, include: { to: { select: { key: true, title: true, status: true, type: true } } } }),
    db.techLink.findMany({ where: { toId: item.id }, include: { from: { select: { key: true, title: true, status: true, type: true } } } }),
    db.techItem.findMany({ where: { parentId: item.id }, select: { key: true, title: true, status: true, type: true }, orderBy: { createdAt: "asc" } }),
    staffView
      ? db.auditEvent.findMany({
          where: { targetId: item.id },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: { id: true, action: true, outcome: true, createdAt: true, actorEmail: true, actor: { select: { name: true } } },
        })
      : Promise.resolve([]),
    Promise.resolve(nextTransitions(access, item)),
    access.agent ? techAgents(access.dept.id) : Promise.resolve([]),
  ]);
  return { item, access, comments, linksFrom, linksTo, children, timeline, transitions, agents, details: detailsOf(item) };
}

// ───────────── create (WF-TM-01 log + triage) ─────────────

export async function createItem(session: AuthSession, input: z.infer<typeof createItemSchema>) {
  const access = await techAccess(session);
  const meta = TYPE_META[input.type];
  if (!meta.creatable) {
    throw new ApiError(422, "VALIDATION", "Access requests run on the IT access approval chain — raise one under Workflows & Approvals");
  }
  const staff = access.agent;
  if (!staff && !meta.portal) throw new ApiError(403, "FORBIDDEN", `Only Technology & MIS staff can raise a ${meta.label.toLowerCase()}`);

  const category = CATEGORIES.find((c) => c.name === input.category);
  if (!category) throw new ApiError(422, "VALIDATION", "Pick a category from the list");
  if (input.subcategory && !category.subs.includes(input.subcategory)) {
    throw new ApiError(422, "VALIDATION", `"${input.subcategory}" is not a sub-category of ${category.name}`);
  }

  const computed = priorityFor(input.impact, input.urgency);
  let priority: TechPriority = computed;
  if (staff && input.priority && input.priority !== computed) {
    if (!input.priorityReason) throw new ApiError(422, "VALIDATION", "Overriding the calculated priority needs a reason");
    priority = input.priority;
  }

  const lane = (staff && input.component) || (meta.lane === "SD" ? category.lane : meta.lane);
  const confidentiality = atLeast(meta.confidentiality, staff ? input.confidentiality : undefined);

  if (input.requestedForId) {
    const u = await db.user.findFirst({ where: { id: input.requestedForId, status: "ACTIVE" }, select: { id: true } });
    if (!u) throw new ApiError(422, "VALIDATION", "The person this is for was not found");
  }

  const agents = await techAgents(access.dept.id);
  let assigneeId: string | null = null;
  if (staff && input.assigneeId) {
    if (!agents.some((a) => a.id === input.assigneeId)) throw new ApiError(422, "VALIDATION", "Assignee must be Technology & MIS staff");
    // staff may log their own work for themselves; giving it to anyone else is the assigner's call
    if (input.assigneeId !== session.user.id && !canAssign(access)) {
      throw new ApiError(403, "FORBIDDEN", "Only the Super Admin or the Tech & MIS Head assigns work to someone else");
    }
    assigneeId = input.assigneeId;
  }

  let parentId: string | null = null;
  if (staff && input.parentKey) {
    const { item: parent } = await requireItem(session, input.parentKey.toUpperCase());
    parentId = parent.id;
  }
  if (input.type === "SUBTASK" && !parentId) throw new ApiError(422, "VALIDATION", "A sub-task needs a parent item");

  const now = new Date();
  const dup = await db.techItem.findFirst({
    where: { reporterId: session.user.id, category: category.name, createdAt: { gte: new Date(now.getTime() - DAY) }, status: { notIn: ALL_TERMINAL } },
    select: { key: true },
  });

  // A1: nothing is auto-assigned — an item with no owner waits in My Queue for the
  // Super Admin / Tech Head, who decide who handles it and which part

  const labels = [...new Set([...(staff ? (input.labels ?? []) : []), ...(dup ? ["possible-duplicate"] : [])])];
  const sla = hasSla(input.type) ? slaTargets(priority, now) : null;
  const details = mergeDetails(input.type, {}, input.details);
  const [heads, leads, assigners] = await Promise.all([
    techHeadIds(access.dept.id),
    techLeadIds(access.dept.id),
    assigneeId ? Promise.resolve([]) : techAssignerIds(access.dept.id),
  ]);
  const alert = priority === "P1" || priority === "P2" || input.type === "SECURITY_INCIDENT";
  const tag = input.type === "SECURITY_INCIDENT" ? "Security report" : priority;

  const item = await db.$transaction(async (tx) => {
    const key = await nextKey(tx);
    const row = await tx.techItem.create({
      data: {
        key,
        type: input.type,
        title: input.title,
        description: input.description,
        status: flowOf(input.type).initial,
        priority,
        impact: input.impact,
        urgency: input.urgency,
        component: lane,
        category: category.name,
        subcategory: input.subcategory,
        confidentiality,
        reporterId: session.user.id,
        requestedForId: input.requestedForId ?? null,
        assigneeId,
        assignedById: assigneeId ? session.user.id : null,
        assignedAt: assigneeId ? now : null,
        parentId,
        details,
        labels,
        storyPoints: staff ? input.storyPoints : undefined,
        dueAt: staff ? input.dueAt : undefined,
        responseDueAt: sla?.responseDueAt,
        resolveDueAt: sla?.resolveDueAt,
        source: (staff && input.source) || "PORTAL",
        watchers: { create: others([session.user.id, input.requestedForId], null).map((userId) => ({ userId })) },
      },
    });
    await techAudit(tx, session, access.dept.id, {
      action: "TECH_ITEM_CREATED",
      targetType: "TechItem",
      targetId: row.id,
      detail: {
        key,
        type: input.type,
        priority,
        computedPriority: computed,
        priorityReason: priority !== computed ? (input.priorityReason ?? null) : null,
        lane,
        confidentiality,
        assigneeId,
        possibleDuplicateOf: dup?.key ?? null,
      },
    });
    await notifyUsers(tx, others([session.user.id, input.requestedForId], null), {
      title: `Received ${key}: ${input.title}`,
      body: `${meta.label} logged — we'll keep you posted here`,
      link: portalHref(key),
    });
    if (assigneeId) {
      await notifyUsers(tx, others([assigneeId], session.user.id), { title: `Assigned ${key}: ${input.title}`, body: `${priority} · ${meta.label}`, link: itemHref(key) });
    } else {
      await notifyUsers(tx, others(assigners, session.user.id), {
        title: `To assign — ${alert ? `${tag} ` : ""}${key}: ${input.title}`,
        body: `${meta.label} raised by ${session.user.name}: choose who handles it and which part`,
        link: itemHref(key),
      });
    }
    // A2 + notifications matrix: P1/P2 to leads, P1 and security reports to the Head
    // (an assigner already told above gets one notice, not two)
    if (alert) {
      const to = priority === "P1" || input.type === "SECURITY_INCIDENT" ? [...leads, ...heads] : leads;
      await notifyUsers(tx, others(to.filter((id) => !assigners.includes(id)), session.user.id), {
        title: `${tag} ${key}: ${input.title}`,
        body: `${meta.label} raised by ${session.user.name}`,
        link: itemHref(key),
      });
    }
    return row;
  });
  return item;
}

// ───────────── transitions (§4.5 + guard rails) ─────────────

function actorKinds(access: TechAccess, item: TechItemRow): ActorKind[] {
  const kinds: ActorKind[] = [];
  if (access.agent) kinds.push("AGENT");
  if (access.lead) kinds.push("LEAD");
  if (access.head) kinds.push("HEAD");
  if (isRequester(access.userId, item)) kinds.push("REQUESTER");
  return kinds;
}

const PROMPTS: Need[] = ["reason", "resolution", "outcome", "pir"];

type Block = { status: 403 | 409; code: string; message: string };

const forbid = (message: string): Block => ({ status: 403, code: "FORBIDDEN", message });
const conflict = (message: string): Block => ({ status: 409, code: "GUARD", message });

/** Why a transition is not available to this user right now, or null when it is. */
function blocker(access: TechAccess, item: TechItemRow, t: Transition, now: Date): Block | null {
  const kinds = actorKinds(access, item);
  if (!t.as.some((k) => kinds.includes(k))) return forbid("You cannot perform this transition");
  for (const need of t.needs ?? []) {
    if (need === "p1" && item.priority !== "P1") return conflict("Major-incident mode is for P1 incidents only");
    if (need === "reviewer" && item.assigneeId === access.userId) return forbid("The reviewer must be someone other than the assignee");
    if (need === "reopenWindow" && (!item.resolvedAt || now.getTime() - item.resolvedAt.getTime() > REOPEN_DAYS * DAY)) {
      return conflict(`Items can be reopened within ${REOPEN_DAYS} days of being resolved`);
    }
    if (need === "approver") {
      const risk = changeRisk(item);
      const level = CHANGE_RISK[risk].approver;
      if (isRequester(access.userId, item)) return forbid("The requester never approves their own change");
      if (level === "LEAD" && !access.lead) return forbid("A minor change needs a team lead's approval");
      if (level === "HEAD" && !access.head) return forbid(`A ${risk.toLowerCase()} change needs the Tech & MIS Head's approval`);
    }
  }
  return null;
}

/** Prompts the UI must collect for this transition on this item. */
function promptsFor(item: TechItemRow, t: Transition): Need[] {
  return (t.needs ?? []).filter((n) => {
    if (!PROMPTS.includes(n)) return false;
    if (n === "pir") return item.type === "INCIDENT" && item.priority === "P1" && !str(detailsOf(item), "pir");
    return true;
  });
}

export function nextTransitions(access: TechAccess, item: TechItemRow, now = new Date()) {
  const list = flowOf(item.type).transitions[item.status] ?? [];
  return list.filter((t) => blocker(access, item, t, now) === null).map((t) => ({ to: t.to, label: t.label, prompts: promptsFor(item, t) }));
}

/** SLA clock resume: the paused span pushes the due dates out (§4.4). */
function resumeData(item: TechItemRow, now: Date): Prisma.TechItemUpdateInput {
  if (!item.slaPausedAt) return {};
  const paused = now.getTime() - item.slaPausedAt.getTime();
  return {
    slaPausedAt: null,
    slaPausedMs: item.slaPausedMs + paused,
    resolveDueAt: item.resolveDueAt ? new Date(item.resolveDueAt.getTime() + paused) : null,
    responseDueAt: item.responseDueAt && !item.respondedAt ? new Date(item.responseDueAt.getTime() + paused) : item.responseDueAt,
  };
}

// The requester sees reasons for these; other reasons stay internal notes.
const PUBLIC_REASON = ["WAITING_ON_REQUESTER", "REJECTED", "DUPLICATE", "REOPENED"];
const REQUESTER_STATES = ["WAITING_ON_REQUESTER", "RESOLVED", "CLOSED", "REJECTED", "DUPLICATE", "IN_PROGRESS"];

export async function transitionItem(session: AuthSession, key: string, input: z.infer<typeof transitionSchema>) {
  const { item, access } = await requireItem(session, key);
  const now = new Date();
  const deny = async (status: 403 | 409, code: string, message: string): Promise<never> => {
    await db.$transaction((tx) =>
      techAudit(tx, session, access.dept.id, {
        action: "DENIED_TECH_TRANSITION",
        targetType: "TechItem",
        targetId: item.id,
        outcome: "DENIED",
        detail: { key, from: item.status, to: input.to, why: message },
      }),
    );
    throw new ApiError(status, code, message);
  };

  const t = transitionFor(item.type, item.status, input.to);
  if (!t) return deny(409, "INVALID_TRANSITION", `Cannot go from ${statusLabel(item.status)} to ${statusLabel(input.to)}`);
  const block = blocker(access, item, t, now);
  if (block) return deny(block.status, block.code, block.message);

  const details = detailsOf(item);
  const needs = t.needs ?? [];
  if (needs.includes("reason") && !input.reason) throw new ApiError(422, "VALIDATION", "Give a reason for this step");
  if (needs.includes("resolution") && (!input.resolutionCode || !input.resolutionNote)) {
    throw new ApiError(422, "VALIDATION", "Resolving needs a resolution code and a resolution note");
  }
  if (needs.includes("outcome") && !input.outcome) throw new ApiError(422, "VALIDATION", "Record the outcome: successful, partial or rolled back");
  if (needs.includes("plan") && (!str(details, "plan") || !str(details, "rollback"))) {
    throw new ApiError(422, "VALIDATION", "Add a plan and a rollback plan before submitting the change");
  }
  const pir = input.pir ?? str(details, "pir");
  if (needs.includes("pir") && item.type === "INCIDENT" && item.priority === "P1" && !pir) {
    throw new ApiError(422, "VALIDATION", "A P1 incident cannot close without a post-incident review");
  }

  const to = t.to;
  const data: Prisma.TechItemUpdateInput = { status: to };
  if (PAUSE_STATUSES.includes(to)) {
    if (!item.slaPausedAt) data.slaPausedAt = now;
  } else {
    Object.assign(data, resumeData(item, now));
  }
  if (!item.respondedAt && access.agent && !isRequester(access.userId, item)) data.respondedAt = now;
  if (RESOLVED_STATUSES.includes(to)) {
    data.resolvedAt = now;
    if (input.resolutionCode) data.resolutionCode = input.resolutionCode;
    if (input.resolutionNote) data.resolutionNote = input.resolutionNote;
  }
  if (to === "REOPENED") {
    data.resolvedAt = null;
    data.closedAt = null;
  }
  if (isTerminal(item.type, to)) {
    data.closedAt = now;
    if (item.type === "CHANGE" && to === "CLOSED") data.resolvedAt = now;
  }
  const detailPatch: Record<string, unknown> = {};
  if (input.outcome) detailPatch.outcome = input.outcome;
  if (input.pir) detailPatch.pir = input.pir;
  if (Object.keys(detailPatch).length) data.details = mergeDetails(item.type, details, detailPatch);

  const [heads, leads] = await Promise.all([techHeadIds(access.dept.id), techLeadIds(access.dept.id)]);
  const watchers = item.watchers.map((w) => w.userId);
  const security = item.type === "SECURITY_INCIDENT";

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.techItem.update({ where: { id: item.id }, data });
    await techAudit(tx, session, access.dept.id, {
      action: "TECH_ITEM_TRANSITIONED",
      targetType: "TechItem",
      targetId: item.id,
      detail: { key, from: item.status, to, reason: input.reason ?? null, resolutionCode: input.resolutionCode ?? null, outcome: input.outcome ?? null },
    });
    const note = [input.reason, input.resolutionNote].filter(Boolean).join("\n\n");
    if (note) {
      await tx.techComment.create({
        data: {
          itemId: item.id,
          authorId: session.user.id,
          body: `${statusLabel(to)}: ${note}`,
          internal: !(PUBLIC_REASON.includes(to) || RESOLVED_STATUSES.includes(to)) || security,
        },
      });
    }
    // A15: a rolled-back change opens an incident linked as "caused by"
    if (item.type === "CHANGE" && input.outcome === "ROLLED_BACK") {
      const incKey = await nextKey(tx);
      const sla = slaTargets("P2", now);
      const inc = await tx.techItem.create({
        data: {
          key: incKey,
          type: "INCIDENT",
          title: `Rolled-back change ${key}: ${item.title}`.slice(0, 140),
          description: input.reason ?? "Opened automatically when the change was rolled back.",
          status: "NEW",
          priority: "P2",
          component: item.component,
          category: item.category,
          reporterId: session.user.id,
          assigneeId: item.assigneeId,
          responseDueAt: sla.responseDueAt,
          resolveDueAt: sla.resolveDueAt,
          source: "AUTOMATION",
          labels: ["rolled-back-change"],
        },
      });
      await tx.techLink.create({ data: { fromId: inc.id, toId: item.id, kind: "caused_by" } });
      await techAudit(tx, null, access.dept.id, {
        action: "AUTOMATION_RAN",
        targetType: "TechItem",
        targetId: inc.id,
        detail: { rule: "A15", change: key, incident: incKey },
      });
      await notifyUsers(tx, heads, { title: `Change ${key} rolled back — ${incKey} opened`, link: itemHref(incKey) });
    }

    const requesters = others([item.reporterId, item.requestedForId], session.user.id);
    const tellRequester = security ? ["CLOSED", "REJECTED"].includes(to) : REQUESTER_STATES.includes(to);
    if (tellRequester) {
      await notifyUsers(tx, requesters, { title: `${key} ${statusLabel(to).toLowerCase()}: ${item.title}`, link: portalHref(key) });
    }
    const staffIds = others([item.assigneeId, ...watchers.filter((w) => !requesters.includes(w)), ...(to === "ESCALATED" ? [...heads, ...leads] : [])], session.user.id);
    await notifyUsers(tx, staffIds, {
      title: `${key} → ${statusLabel(to)}: ${item.title}`,
      body: `${session.user.name} moved it from ${statusLabel(item.status)}`,
      link: itemHref(key),
    });
    return row;
  });
  return updated;
}

// ───────────── field edits ─────────────

export async function updateItem(session: AuthSession, key: string, patch: z.infer<typeof updateItemSchema>) {
  const { item, access } = await requireItem(session, key);
  requireAgent(access);
  if (isTerminal(item.type, item.status)) throw new ApiError(409, "CLOSED", "Closed items cannot be edited");

  const data: Prisma.TechItemUpdateInput = {};
  const changed: Record<string, unknown> = {};
  const notify: { ids: string[]; title: string; body?: string }[] = [];
  const [heads, leads] = await Promise.all([techHeadIds(access.dept.id), techLeadIds(access.dept.id)]);
  const onlyAssigner = (what: string) => {
    if (!canAssign(access)) throw new ApiError(403, "FORBIDDEN", `Only the Super Admin or the Tech & MIS Head ${what}`);
  };

  if (patch.assigneeId !== undefined && patch.assigneeId !== item.assigneeId) {
    onlyAssigner("assigns work");
    if (patch.assigneeId !== null) {
      const agents = await techAgents(access.dept.id);
      if (!agents.some((a) => a.id === patch.assigneeId)) throw new ApiError(422, "VALIDATION", "Assignee must be Technology & MIS staff");
    }
    data.assignee = patch.assigneeId ? { connect: { id: patch.assigneeId } } : { disconnect: true };
    data.assignedBy = patch.assigneeId ? { connect: { id: session.user.id } } : { disconnect: true };
    data.assignedAt = patch.assigneeId ? new Date() : null;
    // instructions belong to one assignment; a new assignee never inherits the last one's
    data.assignNote = patch.assigneeId ? (patch.assignNote ?? null) : null;
    if (item.assigneeId) data.reassignCount = item.reassignCount + 1;
    changed.assignee = { from: item.assigneeId, to: patch.assigneeId, note: patch.assignNote ?? null };
    if (patch.assigneeId) notify.push({ ids: [patch.assigneeId], title: `Assigned ${key}: ${item.title}`, body: patch.assignNote ?? `By ${session.user.name}` });
  } else if (patch.assignNote !== undefined && patch.assignNote !== item.assignNote) {
    onlyAssigner("gives assignment instructions");
    if (!item.assigneeId) throw new ApiError(422, "VALIDATION", "Choose who handles it before giving instructions");
    data.assignNote = patch.assignNote;
    changed.assignNote = patch.assignNote;
    notify.push({ ids: [item.assigneeId], title: `New instructions on ${key}: ${item.title}`, body: patch.assignNote });
  }

  if (patch.priority && patch.priority !== item.priority) {
    if (!patch.priorityReason) throw new ApiError(422, "VALIDATION", "Changing the priority needs a reason");
    data.priority = patch.priority;
    if (hasSla(item.type)) {
      const t = slaTargets(patch.priority, item.createdAt);
      data.resolveDueAt = new Date(t.resolveDueAt.getTime() + item.slaPausedMs);
      data.responseDueAt = new Date(t.responseDueAt.getTime() + item.slaPausedMs);
      // a new target window starts its reminders again
      data.remindedAt = null;
      data.warnedAt = null;
      data.escalatedAt = null;
    }
    changed.priority = { from: item.priority, to: patch.priority, reason: patch.priorityReason };
    if (patch.priority === "P1") notify.push({ ids: [...heads, ...leads], title: `Raised to P1 — ${key}: ${item.title}` });
  }

  if (patch.component && patch.component !== item.component) {
    data.component = patch.component;
    changed.component = { from: item.component, to: patch.component };
  }
  if (patch.labels) {
    data.labels = [...new Set(patch.labels)];
    changed.labels = patch.labels;
  }
  if (patch.dueAt !== undefined) {
    data.dueAt = patch.dueAt;
    changed.dueAt = patch.dueAt;
  }
  if (patch.storyPoints !== undefined) {
    data.storyPoints = patch.storyPoints;
    changed.storyPoints = patch.storyPoints;
  }
  // the risk class drives who may approve (blocker above) — lock it once the change is moving
  if (patch.details && item.type === "CHANGE" && item.status !== "DRAFT" && patch.details.risk !== undefined && patch.details.risk !== changeRisk(item)) {
    throw new ApiError(409, "GUARD", "Risk class is locked once the change is submitted");
  }
  if (patch.details) {
    data.details = mergeDetails(item.type, detailsOf(item), patch.details);
    changed.details = Object.keys(patch.details);
  }
  if (Object.keys(changed).length === 0) return item;

  return db.$transaction(async (tx) => {
    const row = await tx.techItem.update({ where: { id: item.id }, data });
    await techAudit(tx, session, access.dept.id, {
      action: "TECH_ITEM_UPDATED",
      targetType: "TechItem",
      targetId: item.id,
      detail: { key, ...changed } as Prisma.InputJsonValue,
    });
    for (const n of notify) await notifyUsers(tx, others(n.ids, session.user.id), { title: n.title, body: n.body, link: itemHref(key) });
    return row;
  });
}

// ───────────── comments, watch, links, CSAT ─────────────

export async function addComment(session: AuthSession, key: string, input: z.infer<typeof commentSchema>) {
  const { item, access } = await requireItem(session, key);
  const requester = isRequester(access.userId, item);
  if (!access.agent && !requester) throw new ApiError(403, "FORBIDDEN", "Only the requester and Technology & MIS staff can comment");
  const internal = input.internal === true;
  if (internal && !access.agent) throw new ApiError(403, "FORBIDDEN", "Internal notes are for Technology & MIS staff");
  if (isTerminal(item.type, item.status)) throw new ApiError(409, "CLOSED", "This item is closed");

  const now = new Date();
  const data: Prisma.TechItemUpdateInput = {};
  // A5: the requester answering a "waiting on you" puts the item back in progress
  const resumes = requester && !internal && item.status === "WAITING_ON_REQUESTER";
  if (resumes) Object.assign(data, { status: "IN_PROGRESS" }, resumeData(item, now));
  if (!item.respondedAt && access.agent && !requester && !internal) data.respondedAt = now;

  return db.$transaction(async (tx) => {
    const c = await tx.techComment.create({ data: { itemId: item.id, authorId: session.user.id, body: input.body, internal } });
    if (Object.keys(data).length) await tx.techItem.update({ where: { id: item.id }, data });
    await techAudit(tx, session, access.dept.id, {
      action: "TECH_ITEM_COMMENTED",
      targetType: "TechItem",
      targetId: item.id,
      detail: { key, internal, resumed: resumes },
    });
    if (resumes) {
      await techAudit(tx, null, access.dept.id, {
        action: "AUTOMATION_RAN",
        targetType: "TechItem",
        targetId: item.id,
        detail: { rule: "A5", key, from: item.status, to: "IN_PROGRESS" },
      });
    }
    const requesters = others([item.reporterId, item.requestedForId], session.user.id);
    if (!internal) await notifyUsers(tx, requesters, { title: `New reply on ${key}: ${item.title}`, link: portalHref(key) });
    const staff = internal ? [item.assigneeId] : [item.assigneeId, ...item.watchers.map((w) => w.userId).filter((w) => !requesters.includes(w))];
    await notifyUsers(tx, others(staff, session.user.id), {
      title: `${internal ? "Internal note" : "Comment"} on ${key}: ${item.title}`,
      body: `${session.user.name}: ${input.body.slice(0, 120)}`,
      link: itemHref(key),
    });
    return c;
  });
}

export async function toggleWatch(session: AuthSession, key: string): Promise<boolean> {
  const { item, access } = await requireItem(session, key);
  const watching = item.watchers.some((w) => w.userId === session.user.id);
  await db.$transaction(async (tx) => {
    if (watching) await tx.techWatcher.delete({ where: { itemId_userId: { itemId: item.id, userId: session.user.id } } });
    else await tx.techWatcher.create({ data: { itemId: item.id, userId: session.user.id } });
    await techAudit(tx, session, access.dept.id, {
      action: watching ? "TECH_ITEM_UNWATCHED" : "TECH_ITEM_WATCHED",
      targetType: "TechItem",
      targetId: item.id,
      detail: { key },
    });
  });
  return !watching;
}

export async function addLink(session: AuthSession, key: string, input: z.infer<typeof linkSchema>) {
  const { item, access } = await requireItem(session, key);
  requireAgent(access);
  const toKey = input.toKey.toUpperCase();
  if (toKey === key) throw new ApiError(422, "VALIDATION", "An item cannot link to itself");
  const { item: target } = await requireItem(session, toKey);
  return db.$transaction(async (tx) => {
    const link = await tx.techLink.create({ data: { fromId: item.id, toId: target.id, kind: input.kind } });
    await techAudit(tx, session, access.dept.id, {
      action: "TECH_ITEM_LINKED",
      targetType: "TechItem",
      targetId: item.id,
      detail: { key, kind: input.kind, to: toKey },
    });
    return link;
  });
}

export async function rateItem(session: AuthSession, key: string, input: z.infer<typeof csatSchema>) {
  const { item, access } = await requireItem(session, key);
  if (!isRequester(access.userId, item)) throw new ApiError(403, "FORBIDDEN", "Only the requester rates the service");
  if (!["RESOLVED", "CLOSED"].includes(item.status) || !item.resolvedAt) throw new ApiError(409, "NOT_RESOLVED", "Rate the service once it is resolved");
  if (item.csat !== null) throw new ApiError(409, "ALREADY_RATED", "This item has already been rated");
  const leads = input.csat <= 2 ? await techLeadIds(access.dept.id) : [];
  return db.$transaction(async (tx) => {
    const row = await tx.techItem.update({
      where: { id: item.id },
      data: { csat: input.csat, csatComment: input.comment, ...(input.csat <= 2 ? { labels: [...new Set([...item.labels, "low-csat"])] } : {}) },
    });
    await techAudit(tx, session, access.dept.id, { action: "TECH_ITEM_RATED", targetType: "TechItem", targetId: item.id, detail: { key, csat: input.csat } });
    // A14: unhappy requesters reach a lead
    if (input.csat <= 2) {
      await notifyUsers(tx, leads, { title: `Low CSAT (${input.csat}/5) on ${key}: ${item.title}`, body: input.comment, link: itemHref(key) });
    }
    return row;
  });
}

// ───────────── objective scan (§8 A3, A4, A7) ─────────────

export async function scanTech(now = new Date()) {
  const dept = await techDept();
  const [heads, leads, open, resolved, licences] = await Promise.all([
    techHeadIds(dept.id),
    techLeadIds(dept.id),
    db.techItem.findMany({
      where: {
        resolvedAt: null,
        closedAt: null,
        slaPausedAt: null,
        resolveDueAt: { not: null },
        OR: [{ remindedAt: null }, { warnedAt: null }, { escalatedAt: null }],
      },
      include: itemInclude,
    }),
    db.techItem.findMany({ where: { status: "RESOLVED", resolvedAt: { not: null } }, include: itemInclude }),
    db.licence.findMany({ where: { renewsAt: { gte: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + 60 * DAY) } } }),
  ]);

  let reminded = 0;
  let warned = 0;
  let escalated = 0;
  let autoClosed = 0;
  let renewalAlerts = 0;

  await db.$transaction(async (tx) => {
    for (const item of open) {
      const used = slaUsed(item, now) ?? 0;
      const label = `${item.key}: ${item.title}`;
      if (used >= 1 && !item.escalatedAt) {
        await tx.techItem.update({ where: { id: item.id }, data: { escalatedAt: now, warnedAt: item.warnedAt ?? now, remindedAt: item.remindedAt ?? now } });
        await notifyUsers(tx, others([item.assigneeId, ...leads, ...heads], null), { title: `SLA breached — ${label}`, body: `${item.priority} · was due ${item.resolveDueAt?.toLocaleString("en-GB")}`, link: itemHref(item.key) });
        await techAudit(tx, null, dept.id, { action: "TECH_SLA_ESCALATED", targetType: "TechItem", targetId: item.id, detail: { key: item.key, used } });
        escalated++;
      } else if (used >= 0.75 && used < 1 && !item.warnedAt) {
        await tx.techItem.update({ where: { id: item.id }, data: { warnedAt: now, remindedAt: item.remindedAt ?? now } });
        await notifyUsers(tx, others([item.assigneeId, ...leads], null), { title: `SLA at 75% — ${label}`, link: itemHref(item.key) });
        warned++;
      } else if (used >= 0.5 && used < 0.75 && !item.remindedAt) {
        await tx.techItem.update({ where: { id: item.id }, data: { remindedAt: now } });
        await notifyUsers(tx, item.assigneeId ? [item.assigneeId] : leads, { title: `SLA at 50% — ${label}`, link: itemHref(item.key) });
        reminded++;
      }
    }

    // A4: resolved for 3 working days with no reply closes; a P1 waits for its review
    for (const item of resolved) {
      if (addWorkingDays(item.resolvedAt as Date, AUTO_CLOSE_WORKDAYS) > now) continue;
      if (item.type === "INCIDENT" && item.priority === "P1" && !str(detailsOf(item), "pir")) continue;
      await tx.techItem.update({ where: { id: item.id }, data: { status: "CLOSED", closedAt: now } });
      await techAudit(tx, null, dept.id, {
        action: "TECH_ITEM_TRANSITIONED",
        targetType: "TechItem",
        targetId: item.id,
        detail: { key: item.key, from: "RESOLVED", to: "CLOSED", rule: "A4" },
      });
      await notifyUsers(tx, others([item.reporterId, item.requestedForId], null), { title: `${item.key} closed: ${item.title}`, body: "Closed automatically after 3 working days", link: portalHref(item.key) });
      autoClosed++;
    }

    // A7: renewal alerts at 60 / 30 / 7 days, once per threshold
    for (const l of licences) {
      const daysLeft = Math.ceil((l.renewsAt.getTime() - now.getTime()) / DAY);
      const threshold = [...RENEWAL_ALERT_DAYS].sort((a, b) => a - b).find((t) => daysLeft <= t);
      if (threshold === undefined || (l.alertedDays !== null && l.alertedDays <= threshold)) continue;
      await tx.licence.update({ where: { id: l.id }, data: { alertedDays: threshold } });
      await notifyUsers(tx, others([l.ownerId, ...(threshold <= 7 ? heads : [])], null), {
        title: `Renewal in ${Math.max(daysLeft, 0)} days: ${l.product}`,
        body: `Renews ${l.renewsAt.toLocaleDateString("en-GB")} — decide renew, downsize or cancel`,
        link: "/departments/technology-mis/licences",
      });
      renewalAlerts++;
    }

    await techAudit(tx, null, dept.id, {
      action: "TECH_SCAN",
      targetType: "TechItem",
      detail: { reminded, warned, escalated, autoClosed, renewalAlerts },
    });
  });

  return { reminded, warned, escalated, autoClosed, renewalAlerts };
}
