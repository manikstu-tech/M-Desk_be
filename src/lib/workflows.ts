import { DocStatus, RoleName, UserStatus, WfStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { writeAudit, type Tx } from "./audit";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { isDeptMember } from "./tasks";
import type { AuthSession } from "./authorize";
import type { WorkflowDefinition, WorkflowInstance } from "@prisma/client";

// B4 wave-1 approvals engine (blueprint §6): definitions are seed data with
// role-per-step approver chains; the DoA step resolves its approver role by
// amount tiers. Values are P-06 placeholders until MD + Finance Head decide.

export type WfStep = {
  name: string;
  role: RoleName;
  dept?: string | null; // undefined/null ⇒ requester's own department
  tiers?: { upTo: number; role: RoleName; dept?: string | null }[]; // amount routing, ascending
};

// requester actions: CANCELLED (withdraw while pending), RESUBMITTED (after RETURNED).
// approver decisions: APPROVED advances / completes, REJECTED denies, RETURNED sends back.
export type WfAction = "APPROVED" | "REJECTED" | "RETURNED" | "CANCELLED" | "RESUBMITTED";

export const WF_TERMINAL: WfStatus[] = [WfStatus.COMPLETED, WfStatus.CANCELLED, WfStatus.REJECTED];

const instanceInclude = {
  definition: true,
  requester: { select: { id: true, name: true, email: true } },
  approvals: {
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { decidedAt: "asc" as const },
  },
} satisfies Prisma.WorkflowInstanceInclude;

export type WfInstanceRow = Prisma.WorkflowInstanceGetPayload<{ include: typeof instanceInclude }>;

export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  while (days > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) days--;
  }
  return d;
}

export function stepsOf(def: Pick<WorkflowDefinition, "key" | "steps">): WfStep[] {
  const s: unknown = def.steps;
  return Array.isArray(s) ? (s as WfStep[]) : [];
}

// DoA routing: the smallest tier whose ceiling covers the amount wins.
export function resolveStep(step: WfStep, amount: number | null): { role: RoleName; dept: string | null } {
  if (step.tiers?.length && amount != null) {
    const tier = step.tiers.find((t) => amount <= t.upTo) ?? step.tiers[step.tiers.length - 1];
    return { role: tier.role, dept: tier.dept ?? null };
  }
  return { role: step.role, dept: step.dept ?? null };
}

export function amountOf(instance: Pick<WorkflowInstance, "amount">): number | null {
  return instance.amount === null ? null : Number(instance.amount.toString());
}

async function resolveDeptId(
  requesterId: string,
  slug: string | null,
  related?: { relatedType?: string | null; relatedId?: string | null },
): Promise<string | null> {
  if (slug) {
    const dept = await db.department.findUnique({ where: { slug }, select: { id: true } });
    return dept?.id ?? null;
  }
  // Document-linked chains anchor to the document's department (its owner's
  // head approves), not the filer's home department
  if (related?.relatedType === "Document" && related.relatedId) {
    const doc = await db.document.findUnique({
      where: { id: related.relatedId },
      select: { departmentId: true },
    });
    return doc?.departmentId ?? null;
  }
  const m = await db.departmentMembership.findFirst({
    where: { userId: requesterId },
    orderBy: { createdAt: "asc" },
    select: { departmentId: true },
  });
  return m?.departmentId ?? null;
}

async function approversFor(role: RoleName, departmentId: string | null) {
  if (!departmentId) return [];
  return db.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      roleId: (await db.role.findUniqueOrThrow({ where: { name: role } })).id,
      memberships: { some: { departmentId } },
    },
    select: { id: true, name: true, email: true },
  });
}

// A user is a candidate at the resolved step when role AND department match;
// super admin can always act. The requester never approves their own request.
async function isStepApprover(session: AuthSession, step: WfStep, instance: WfInstanceRow) {
  if (session.user.id === instance.requesterId) return false;
  if (session.user.role.name === RoleName.SUPER_ADMIN) return true;
  const resolved = resolveStep(step, amountOf(instance));
  if (session.user.role.name !== resolved.role) return false;
  const deptId = await resolveDeptId(instance.requesterId, resolved.dept, instance);
  if (!deptId) return false;
  return isDeptMember(session.user.id, deptId);
}

export function currentStep(instance: {
  currentStep: number;
  definition: Pick<WorkflowDefinition, "key" | "steps">;
}): WfStep | undefined {
  const steps = stepsOf(instance.definition);
  return steps[Math.min(instance.currentStep, steps.length - 1)];
}

// FR-9 posture: 404 either way — exists/invisible or missing.
async function requireVisible(session: AuthSession, instanceId: string): Promise<WfInstanceRow> {
  const instance = await db.workflowInstance.findUnique({
    where: { id: instanceId },
    include: instanceInclude,
  });
  if (!instance) throw new ApiError(404, "NOT_FOUND", "Workflow not found");
  const visible =
    session.user.id === instance.requesterId ||
    session.user.role.name === RoleName.SUPER_ADMIN ||
    (currentStep(instance) !== undefined &&
      (await isStepApprover(session, currentStep(instance) as WfStep, instance))) ||
    // department members of the requester's department see it, like tasks
    (await isDeptMember(
      session.user.id,
      (await resolveDeptId(instance.requesterId, null, instance)) ?? "",
    ));
  if (!visible) throw new ApiError(404, "NOT_FOUND", "Workflow not found");
  return instance;
}

async function deniedAct(session: AuthSession, instance: WfInstanceRow, action: WfAction) {
  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DENIED_WF_ACT",
      targetType: "WorkflowInstance",
      targetId: instance.id,
      outcome: "DENIED",
      detail: { action, status: instance.status, currentStep: instance.currentStep },
    }),
  );
}

function instanceDetail(instance: WfInstanceRow) {
  return {
    key: instance.definition.key,
    title: instance.title,
    amount: amountOf(instance),
    status: instance.status,
    currentStep: instance.currentStep,
    relatedType: instance.relatedType,
    relatedId: instance.relatedId,
  };
}

export async function listWorkflows(session: AuthSession) {
  const open = { status: { notIn: WF_TERMINAL as WfStatus[] } };
  const [startedByMe, openInstances, definitions] = await Promise.all([
    db.workflowInstance.findMany({
      where: { requesterId: session.user.id },
      include: instanceInclude,
      orderBy: { createdAt: "desc" },
    }),
    db.workflowInstance.findMany({
      where: { ...open, requesterId: { not: session.user.id } },
      include: instanceInclude,
      orderBy: { dueAt: "asc" },
      take: 200,
    }),
    db.workflowDefinition.findMany({ orderBy: [{ wave: "asc" }, { name: "asc" }] }),
  ]);

  const awaitingMine = [];
  for (const instance of openInstances) {
    const step = currentStep(instance);
    if (step && (await isStepApprover(session, step, instance))) awaitingMine.push(instance);
  }
  return { startedByMe, awaitingMine, definitions };
}

// UI helper: actions this session may legally perform (buttons only; the POST
// re-enforces everything, same split as tasks.nextTransitions).
export async function nextWfActions(
  session: AuthSession,
  instance: WfInstanceRow,
): Promise<WfAction[]> {
  const isRequester = session.user.id === instance.requesterId;
  const step = currentStep(instance);
  if (instance.status === WfStatus.REVISION_REQUESTED) {
    if (isRequester || session.user.role.name === RoleName.SUPER_ADMIN) return ["RESUBMITTED"];
    return [];
  }
  if (instance.status === WfStatus.IN_PROGRESS) {
    if (step && (await isStepApprover(session, step, instance))) {
      return ["APPROVED", "REJECTED", "RETURNED"];
    }
    if (isRequester || session.user.role.name === RoleName.SUPER_ADMIN) return ["CANCELLED"];
  }
  return [];
}

export async function startWorkflow(
  session: AuthSession,
  input: {
    key: string;
    title: string;
    amount?: number;
    relatedType?: string;
    relatedId?: string;
  },
) {
  const def = await db.workflowDefinition.findUnique({ where: { key: input.key } });
  // unknown key: 404 with no detail — same posture as an inaccessible instance
  if (!def) throw new ApiError(404, "NOT_FOUND", "Workflow not found");
  const steps = stepsOf(def);
  if (steps.length === 0) {
    throw new ApiError(500, "INVALID_WORKFLOW", "Workflow definition has no steps");
  }
  if (steps.some((s) => s.tiers?.length) && input.amount == null) {
    throw new ApiError(400, "VALIDATION", "This workflow needs an amount");
  }
  if (input.amount != null && input.amount <= 0) {
    throw new ApiError(400, "VALIDATION", "Amount must be positive");
  }

  // related-target gate: syncDocumentStatus mutates whatever relatedId points to, so
  // only links the requester may view are allowed. Document is the type the sync
  // bridge implements; document approval starts via startDocumentApproval instead.
  if (input.relatedType != null || input.relatedId != null) {
    if (input.relatedType !== "Document" || !input.relatedId) {
      throw new ApiError(400, "VALIDATION", "Invalid related link");
    }
    const doc = await db.document.findUnique({
      where: { id: input.relatedId },
      select: { id: true, departmentId: true, createdById: true, confidentiality: true },
    });
    // dynamic import: documents.ts already imports this module at top level
    const { canViewDocument } = await import("./documents");
    if (!doc || !(await canViewDocument(session, doc))) {
      throw new ApiError(404, "NOT_FOUND", "Workflow not found");
    }
  }

  // the requester needs a home department before the chain can start
  if (steps.some((s) => !s.dept) && !(await resolveDeptId(session.user.id, null))) {
    throw new ApiError(400, "VALIDATION", "Requester must belong to a department");
  }
  const first = resolveStep(steps[0], input.amount ?? null);
  const firstApprovers = await approversFor(
    first.role,
    await resolveDeptId(session.user.id, first.dept),
  );
  if (firstApprovers.length === 0) {
    throw new ApiError(400, "VALIDATION", `No ${first.role} member available to approve step 1`);
  }

  const now = new Date();
  return db.$transaction(async (tx) => {
    const instance = await tx.workflowInstance.create({
      data: {
        definitionId: def.id,
        requesterId: session.user.id,
        title: input.title,
        amount: input.amount ?? null,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        dueAt: addWorkingDays(now, def.slaDays),
      },
      include: instanceInclude,
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "WF_STARTED",
      targetType: "WorkflowInstance",
      targetId: instance.id,
      detail: instanceDetail(instance),
    });
    await notifyUsers(
      tx,
      firstApprovers.filter((u) => u.id !== session.user.id).map((u) => u.id),
      {
        title: `Approval needed: ${input.title}`,
        body: `${def.name} — step 1 ${steps[0].name}`,
        link: "/workflows",
      },
    );
    return instance;
  });
}

// Blueprint #15: "mark for review" on a document starts this chain instead of
// leaving the doc awaiting a manual status change. Same transaction as the
// status change itself (in documents.ts), so a failed start leaves the doc at
// DRAFT — the caller compensates on error.
export async function startDocumentApproval(
  session: AuthSession,
  doc: { id: string; title: string; departmentId: string },
) {
  const def = await db.workflowDefinition.findUnique({ where: { key: "document_approval" } });
  if (!def) throw new ApiError(500, "INVALID_WORKFLOW", "Document approval workflow is not seeded");
  const live = await db.workflowInstance.findFirst({
    where: {
      relatedType: "Document",
      relatedId: doc.id,
      status: { notIn: WF_TERMINAL },
    },
    select: { id: true },
  });
  if (live) throw new ApiError(409, "CONFLICT", "This document already has a review in progress");

  const steps = stepsOf(def);
  const first = resolveStep(steps[0] ?? { name: "", role: RoleName.MANAGER }, null);
  const firstApprovers = await approversFor(first.role, await resolveDeptId(doc.id, first.dept, {
    relatedType: "Document",
    relatedId: doc.id,
  }));
  if (firstApprovers.length === 0) {
    throw new ApiError(400, "VALIDATION", `No ${first.role} member available to approve step 1`);
  }

  const now = new Date();
  return db.$transaction(async (tx) => {
    const instance = await tx.workflowInstance.create({
      data: {
        definitionId: def.id,
        requesterId: session.user.id,
        title: doc.title,
        relatedType: "Document",
        relatedId: doc.id,
        dueAt: addWorkingDays(now, def.slaDays),
      },
      include: instanceInclude,
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "WF_STARTED",
      targetType: "WorkflowInstance",
      targetId: instance.id,
      detail: { ...instanceDetail(instance), documentId: doc.id },
    });
    await notifyUsers(
      tx,
      firstApprovers.filter((u) => u.id !== session.user.id).map((u) => u.id),
      {
        title: `Approval needed: ${doc.title}`,
        body: `${def.name} — step 1 ${steps[0].name}`,
        link: "/workflows",
      },
    );
    return instance;
  });
}

// keep the linked document in step with the chain's decisions (#15)
async function syncDocumentStatus(
  tx: Tx,
  session: AuthSession,
  instance: WfInstanceRow,
  docTo: DocStatus | null,
) {
  if (instance.relatedType !== "Document" || !instance.relatedId || !docTo) return;
  const before = await tx.document.findUnique({
    where: { id: instance.relatedId },
    select: { status: true },
  });
  await tx.document.update({ where: { id: instance.relatedId }, data: { status: docTo } });
  await writeAudit(tx, {
    actorId: session.user.id,
    actorEmail: session.user.email,
    action: "DOCUMENT_STATUS_CHANGED",
    targetType: "Document",
    targetId: instance.relatedId,
    detail: { from: before?.status ?? null, to: docTo, viaWorkflow: true, instanceId: instance.id },
  });
}

// Objective SLA scan for open chains (blueprint §6, same machine as scanTasks):
// remind whoever the chain is waiting on at 50% of the window, escalate
// past-due chains to approvers + requester. Idempotent per instance via
// remindedAt / escalatedAt stamps — a re-run is a no-op.
export async function scanWorkflows() {
  const now = new Date();
  const open = await db.workflowInstance.findMany({
    where: { status: { notIn: WF_TERMINAL as WfStatus[] } },
    include: instanceInclude,
  });

  const due = open.filter((i) => i.dueAt !== null);
  const overdue = due.filter((i) => i.escalatedAt === null && (i.dueAt as Date).getTime() < now.getTime());
  const toRemind = due.filter((i) => {
    if (i.remindedAt || (i.dueAt as Date).getTime() <= now.getTime()) return false;
    const windowMs = (i.dueAt as Date).getTime() - i.createdAt.getTime();
    return now.getTime() - i.createdAt.getTime() >= windowMs / 2;
  });

  // resolve recipients up front (awaited) — the transaction itself stays sync-free per row
  const recipients = new Map<string, string[]>();
  for (const i of [...toRemind, ...overdue]) {
    const step = currentStep(i);
    let ids: string[];
    if (i.status !== WfStatus.IN_PROGRESS || !step) {
      ids = [i.requesterId];
    } else {
      const resolved = resolveStep(step, amountOf(i));
      const users = await approversFor(resolved.role, (await resolveDeptId(i.requesterId, resolved.dept, i)) ?? "");
      ids = users.map((u) => u.id);
      if (i.escalatedAt === null && overdue.includes(i) && !ids.includes(i.requesterId)) ids.push(i.requesterId);
    }
    recipients.set(i.id, [...new Set(ids.filter(Boolean))]);
  }

  await db.$transaction(async (tx) => {
    for (const i of toRemind) {
      await tx.workflowInstance.update({ where: { id: i.id }, data: { remindedAt: now } });
      await notifyUsers(tx, recipients.get(i.id) ?? [], {
        title: `Reminder: ${i.title}`,
        body: `${i.definition.name} — half the window to ${i.dueAt?.toLocaleDateString("en-GB")} is gone`,
        link: "/workflows",
      });
    }
    for (const i of overdue) {
      await tx.workflowInstance.update({ where: { id: i.id }, data: { escalatedAt: now } });
      await notifyUsers(tx, recipients.get(i.id) ?? [], {
        title: `OVERDUE: ${i.title}`,
        body: `${i.definition.name} — was due ${i.dueAt?.toLocaleDateString("en-GB")}`,
        link: "/workflows",
      });
    }
    await writeAudit(tx, {
      action: "WF_SCAN",
      targetType: "WorkflowInstance",
      detail: { reminded: toRemind.length, escalated: overdue.length },
    });
  });

  return { reminded: toRemind.length, escalated: overdue.length };
}

export async function actOnInstance(
  session: AuthSession,
  instanceId: string,
  action: WfAction,
  input: { comment?: string; amount?: number; title?: string },
) {
  const instance = await requireVisible(session, instanceId);
  const steps = stepsOf(instance.definition);
  const isRequester = session.user.id === instance.requesterId;
  const isSuper = session.user.role.name === RoleName.SUPER_ADMIN;

  // ---- requester-only actions -------------------------------------------
  if (action === "CANCELLED") {
    if (!isRequester && !isSuper) {
      await deniedAct(session, instance, action);
      throw new ApiError(403, "FORBIDDEN", "Only the requester can cancel");
    }
    if (instance.status !== WfStatus.IN_PROGRESS) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot cancel a ${instance.status} instance`);
    }
    await db.$transaction(async (tx) => {
      await tx.workflowInstance.update({
        where: { id: instance.id },
        data: { status: WfStatus.CANCELLED },
      });
      // a withdrawn review releases the document back to DRAFT (#15)
      await syncDocumentStatus(tx, session, instance, DocStatus.DRAFT);
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "WF_CANCELLED",
        targetType: "WorkflowInstance",
        targetId: instance.id,
        detail: { ...instanceDetail(instance), comment: input.comment ?? null },
      });
      await notifyUsers(tx, [instance.requesterId].filter((id) => id !== session.user.id), {
        title: `Request cancelled: ${instance.title}`,
        body: `${session.user.name} withdrew it`,
        link: "/workflows",
      });
    });
    return;
  }

  if (action === "RESUBMITTED") {
    if (!isRequester && !isSuper) {
      await deniedAct(session, instance, action);
      throw new ApiError(403, "FORBIDDEN", "Only the requester can resubmit");
    }
    if (instance.status !== WfStatus.REVISION_REQUESTED) {
      throw new ApiError(409, "INVALID_TRANSITION", `Cannot resubmit a ${instance.status} instance`);
    }
    // the DIAMOND DoA ladder reads the amount — resubmission must not re-tier it
    if (input.amount != null && amountOf(instance) != null && input.amount !== amountOf(instance)) {
      throw new ApiError(409, "VALIDATION", "The amount cannot change on resubmission — start a new request");
    }
    if (steps.some((s) => s.tiers?.length) && input.amount == null && amountOf(instance) == null) {
      throw new ApiError(400, "VALIDATION", "This workflow needs an amount");
    }
    const step = steps[Math.min(instance.currentStep, steps.length - 1)];
    const resolved = resolveStep(step, (input.amount ?? amountOf(instance)) ?? null);
    const approvers = await approversFor(resolved.role, await resolveDeptId(instance.requesterId, resolved.dept));
    await db.$transaction(async (tx) => {
      await tx.workflowInstance.update({
        where: { id: instance.id },
        data: {
          status: WfStatus.IN_PROGRESS,
          amount: input.amount ?? undefined,
          title: input.title ?? undefined,
        },
      });
      // resubmitted review puts the document back under review (#15)
      await syncDocumentStatus(tx, session, instance, DocStatus.IN_REVIEW);
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "WF_RESUBMITTED",
        targetType: "WorkflowInstance",
        targetId: instance.id,
        detail: { ...instanceDetail(instance), comment: input.comment ?? null },
      });
      await notifyUsers(
        tx,
        approvers.map((u) => u.id).filter((id) => id !== session.user.id),
        {
          title: `Approval needed: ${input.title ?? instance.title}`,
          body: `${instance.definition.name} — resubmitted, step ${instance.currentStep + 1} ${step.name}`,
          link: "/workflows",
        },
      );
    });
    return;
  }

  // ---- approver decisions ------------------------------------------------
  if (instance.status !== WfStatus.IN_PROGRESS) {
    throw new ApiError(409, "INVALID_TRANSITION", `Instance is ${instance.status}, not IN_PROGRESS`);
  }
  const step = currentStep(instance);
  if (!step) throw new ApiError(500, "INVALID_WORKFLOW", "Workflow definition has no steps");
  if (!(await isStepApprover(session, step, instance))) {
    await deniedAct(session, instance, action);
    throw new ApiError(403, "FORBIDDEN", "You are not the approver for this step");
  }
  if ((action === "REJECTED" || action === "RETURNED") && !input.comment?.trim()) {
    throw new ApiError(400, "VALIDATION", `A ${action.toLowerCase()} decision needs a reason`);
  }

  const isLast = instance.currentStep >= steps.length - 1;
  const nextStatus =
    action === "APPROVED" ? (isLast ? WfStatus.COMPLETED : WfStatus.IN_PROGRESS)
    : action === "REJECTED" ? WfStatus.REJECTED
    : WfStatus.REVISION_REQUESTED;

  // document linkage (#15): only the decisions the document must react to
  const docTo: DocStatus | null =
    action === "APPROVED" && isLast ? DocStatus.APPROVED
    : action === "REJECTED" || action === "RETURNED" ? DocStatus.CHANGES_REQUESTED
    : null;

  await db.$transaction(async (tx) => {
    await tx.approvalAction.create({
      data: {
        instanceId: instance.id,
        stepIndex: instance.currentStep,
        decision: action,
        actorId: session.user.id,
        comment: input.comment?.trim() ?? null,
      },
    });
    await tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: nextStatus,
        currentStep: action === "APPROVED" && !isLast ? instance.currentStep + 1 : instance.currentStep,
      },
    });
    await syncDocumentStatus(tx, session, instance, docTo);
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: `WF_${action}`,
      targetType: "WorkflowInstance",
      targetId: instance.id,
      detail: {
        ...instanceDetail(instance),
        step: step.name,
        comment: input.comment ?? null,
      },
    });

    const nextApprovers =
      action === "APPROVED" && !isLast
        ? await approversFor(
            resolveStep(steps[instance.currentStep + 1], amountOf(instance)).role,
            await resolveDeptId(instance.requesterId, resolveStep(steps[instance.currentStep + 1], amountOf(instance)).dept),
          )
        : [];
    if (action === "APPROVED" && isLast) {
      await notifyUsers(tx, [instance.requesterId].filter((id) => id !== session.user.id), {
        title: `Approved: ${instance.title}`,
        body: `${session.user.name} completed the final step (${step.name})`,
        link: "/workflows",
      });
    } else if (action === "APPROVED") {
      const nextStep = steps[instance.currentStep + 1];
      await notifyUsers(tx, nextApprovers.map((u) => u.id), {
        title: `Approval needed: ${instance.title}`,
        body: `${instance.definition.name} — step ${instance.currentStep + 2} ${nextStep.name}`,
        link: "/workflows",
      });
    } else {
      // rejected or returned: the requester learns why
      await notifyUsers(tx, [instance.requesterId].filter((id) => id !== session.user.id), {
        title: `${action === "REJECTED" ? "Rejected" : "Revision requested"}: ${instance.title}`,
        body: `${session.user.name}: ${input.comment?.trim()}`,
        link: "/workflows",
      });
    }
  });
}
