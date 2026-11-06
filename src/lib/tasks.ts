import { RoleName, TaskStatus } from "@prisma/client";
import { db } from "./db";
import { writeAudit } from "./audit";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import type { AuthSession } from "./authorize";
import type { Prisma } from "@prisma/client";

type ActorKind = "ASSIGNEE" | "REVIEWER" | "CREATOR" | "APPROVER";

type Rule = { to: TaskStatus; as: ActorKind[]; need?: "note" | "reason" };

// Blueprint §5 state flow: Not Started → In Progress → Submitted → Revision/Approved →
// Completed; On Hold / Blocked / Cancelled alongside. Terminal: COMPLETED, CANCELLED.
const FLOW: Record<TaskStatus, Rule[]> = {
  OPEN: [
    { to: TaskStatus.IN_PROGRESS, as: ["ASSIGNEE", "APPROVER"] },
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  IN_PROGRESS: [
    { to: TaskStatus.SUBMITTED, as: ["ASSIGNEE", "APPROVER"] },
    { to: TaskStatus.ON_HOLD, as: ["ASSIGNEE", "CREATOR", "APPROVER"] },
    { to: TaskStatus.BLOCKED, as: ["ASSIGNEE", "APPROVER"], need: "reason" },
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  ON_HOLD: [
    { to: TaskStatus.IN_PROGRESS, as: ["ASSIGNEE", "CREATOR", "APPROVER"] },
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  BLOCKED: [
    { to: TaskStatus.IN_PROGRESS, as: ["ASSIGNEE", "APPROVER"] },
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  SUBMITTED: [
    { to: TaskStatus.COMPLETED, as: ["REVIEWER", "APPROVER"] },
    { to: TaskStatus.REVISION_REQUESTED, as: ["REVIEWER", "APPROVER"], need: "note" }, // rejection needs a reason (blueprint §6)
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  REVISION_REQUESTED: [
    { to: TaskStatus.SUBMITTED, as: ["ASSIGNEE", "APPROVER"] },
    { to: TaskStatus.CANCELLED, as: ["CREATOR", "APPROVER"] },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

const TERMINAL: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED];

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  reviewer: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function isSuperAdmin(session: AuthSession) {
  return session.user.role.name === RoleName.SUPER_ADMIN;
}

// A task belongs to a department workspace: participants always see it, and
// members of its department see it. Same FR-9 posture as documents.
export async function isDeptMember(userId: string, departmentId: string) {
  const member = await db.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
  });
  return member !== null;
}

export function isTaskParticipant(userId: string, task: Pick<TaskRow, "assigneeId" | "reviewerId" | "createdById">) {
  return (
    userId === task.assigneeId || userId === task.reviewerId || userId === task.createdById
  );
}

async function hasApproveGrant(userId: string, departmentId: string | null) {
  if (!departmentId) return false;
  const grant = await db.delegationGrant.findFirst({
    where: {
      userId,
      departmentId,
      action: "APPROVE",
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  return grant !== null;
}

async function actorKinds(session: AuthSession, task: TaskRow): Promise<ActorKind[]> {
  if (isSuperAdmin(session)) return ["ASSIGNEE", "REVIEWER", "CREATOR", "APPROVER"];
  const kinds: ActorKind[] = [];
  if (session.user.id === task.assigneeId) kinds.push("ASSIGNEE");
  if (session.user.id === task.reviewerId) kinds.push("REVIEWER");
  if (session.user.id === task.createdById) kinds.push("CREATOR");
  if (await hasApproveGrant(session.user.id, task.departmentId)) kinds.push("APPROVER");
  return kinds;
}

async function requireVisible(session: AuthSession, taskId: string): Promise<TaskRow> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });
  // 404 either way — never reveal whether a task exists (FR-9)
  if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found");
  const visible =
    isSuperAdmin(session) ||
    isTaskParticipant(session.user.id, task) ||
    (task.departmentId !== null && (await isDeptMember(session.user.id, task.departmentId)));
  if (!visible) throw new ApiError(404, "NOT_FOUND", "Task not found");
  return task;
}

export async function listMyTasks(session: AuthSession) {
  const me = session.user.id;
  const notTerminal = { status: { notIn: TERMINAL } };
  const memberships = await db.departmentMembership.findMany({
    where: { userId: me },
    select: { departmentId: true },
  });
  const [assignedToMe, createdByMe, forReview, department] = await Promise.all([
    db.task.findMany({
      where: { assigneeId: me, ...notTerminal },
      include: taskInclude,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    }),
    db.task.findMany({
      where: { createdById: me, ...notTerminal },
      include: taskInclude,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    }),
    db.task.findMany({
      where: { reviewerId: me, status: TaskStatus.SUBMITTED },
      include: taskInclude,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
    }),
    db.task.findMany({
      where: { departmentId: { in: memberships.map((m) => m.departmentId) }, ...notTerminal },
      include: taskInclude,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 50,
    }),
  ]);
  return { assignedToMe, createdByMe, forReview, department };
}

export async function createTask(
  session: AuthSession,
  input: {
    title: string;
    departmentId: string;
    note?: string;
    assigneeId?: string;
    reviewerId?: string;
    dueAt?: Date;
  },
) {
  const { user } = session;
  if (!isSuperAdmin(session) && !(await isDeptMember(user.id, input.departmentId))) {
    throw new ApiError(403, "FORBIDDEN", "You are not a member of this department");
  }
  if (input.assigneeId && input.assigneeId === input.reviewerId) {
    throw new ApiError(400, "INVALID_TASK", "Reviewer must differ from the assignee");
  }
  for (const uid of [input.assigneeId, input.reviewerId]) {
    if (uid && !(await isDeptMember(uid, input.departmentId))) {
      throw new ApiError(400, "INVALID_TASK", "Assignee and reviewer must belong to the department");
    }
  }

  const task = await db.$transaction(async (tx) => {
    const row = await tx.task.create({
      data: {
        title: input.title,
        note: input.note,
        departmentId: input.departmentId,
        assigneeId: input.assigneeId,
        reviewerId: input.reviewerId,
        dueAt: input.dueAt,
        createdById: user.id,
      },
    });
    await writeAudit(tx, {
      actorId: user.id,
      actorEmail: user.email,
      action: "TASK_CREATED",
      targetType: "Task",
      targetId: row.id,
      departmentId: input.departmentId,
      detail: { title: input.title, assigneeId: input.assigneeId ?? null, reviewerId: input.reviewerId ?? null },
    });
    await notifyUsers(
      tx,
      [input.assigneeId, input.reviewerId].filter((id): id is string => id != null),
      {
        title: `New task: ${input.title}`,
        body: `${user.name} assigned you work`,
        link: "/my",
      },
    );
    return row;
  });

  return task as unknown as TaskRow;
}

// UI helper: the transitions the session may legally perform on a task.
// Server still re-enforces everything on POST — this only drives buttons.
export async function nextTransitions(session: AuthSession, task: TaskRow) {
  const kinds = await actorKinds(session, task);
  return (FLOW[task.status] ?? [])
    .filter((rule) => rule.as.some((k) => kinds.includes(k)))
    .map((rule) => ({ to: rule.to, need: rule.need ?? undefined }));
}

const LABELS: Partial<Record<TaskStatus, string>> = {
  [TaskStatus.IN_PROGRESS]: "Start work",
  [TaskStatus.SUBMITTED]: "Submit for review",
  [TaskStatus.ON_HOLD]: "Put on hold",
  [TaskStatus.BLOCKED]: "Block",
  [TaskStatus.CANCELLED]: "Cancel task",
  [TaskStatus.COMPLETED]: "Approve & complete",
  [TaskStatus.REVISION_REQUESTED]: "Request revision",
};

export function transitionLabel(to: TaskStatus, fromTask?: { status: TaskStatus }): string {
  if (to === TaskStatus.IN_PROGRESS && fromTask) {
    if (fromTask.status === TaskStatus.ON_HOLD) return "Resume";
    if (fromTask.status === TaskStatus.BLOCKED) return "Unblock";
    if (fromTask.status === TaskStatus.REVISION_REQUESTED) return "Start revision";
  }
  if (to === TaskStatus.SUBMITTED && fromTask?.status === TaskStatus.REVISION_REQUESTED) {
    return "Resubmit";
  }
  return LABELS[to] ?? "Move to " + to;
}

// Objective scan (blueprint §6): remind at 50% of the task window, escalate
// once past due. Idempotent per task via remindedAt / escalatedAt stamps, so
// running it twice (cron later, admin button now) never duplicates anything.
export async function scanTasks() {
  const now = new Date();
  const [overdue, upcoming] = await Promise.all([
    db.task.findMany({
      where: { status: { notIn: TERMINAL }, escalatedAt: null, dueAt: { lt: now } },
      include: taskInclude,
    }),
    db.task.findMany({
      where: { status: { notIn: TERMINAL }, remindedAt: null, dueAt: { gt: now } },
      include: taskInclude,
    }),
  ]);
  const toRemind = upcoming.filter((t) => {
    // dueAt is non-null by the query; window can't be <= 0 here (due > now)
    const windowMs = (t.dueAt as Date).getTime() - t.createdAt.getTime();
    return now.getTime() - t.createdAt.getTime() >= windowMs / 2;
  });

  await db.$transaction(async (tx) => {
    for (const t of toRemind) {
      await tx.task.update({ where: { id: t.id }, data: { remindedAt: now } });
      await notifyUsers(tx, [t.assigneeId, t.reviewerId, t.createdById].filter((id): id is string => id !== null), {
        title: `Reminder: ${t.title}`,
        body: `Half the window to ${t.dueAt?.toLocaleDateString("en-GB")} is gone`,
        link: "/my",
      });
    }
    for (const t of overdue) {
      await tx.task.update({ where: { id: t.id }, data: { escalatedAt: now } });
      await notifyUsers(tx, [t.assigneeId, t.reviewerId, t.createdById].filter((id): id is string => id !== null), {
        title: `OVERDUE: ${t.title}`,
        body: `${t.department?.name ?? "Task"} — was due ${t.dueAt?.toLocaleDateString("en-GB")}`,
        link: "/my",
      });
    }
    await writeAudit(tx, {
      action: "TASK_SCAN",
      targetType: "Task",
      detail: { reminded: toRemind.length, escalated: overdue.length },
    });
  });

  return { reminded: toRemind.length, escalated: overdue.length };
}

export async function transitionTask(  session: AuthSession,
  taskId: string,
  to: TaskStatus,
  input: { note?: string; blockedReason?: string },
) {
  const task = await requireVisible(session, taskId);
  const rule = FLOW[task.status]?.find((r) => r.to === to);
  if (!rule) {
    throw new ApiError(409, "INVALID_TRANSITION", `Cannot go from ${task.status} to ${to}`);
  }
  const kinds = await actorKinds(session, task);
  if (!rule.as.some((k) => kinds.includes(k))) {
    // visible but not entitled — audit the denial like every other DENIED path
    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "DENIED_TASK_TRANSITION",
        targetType: "Task",
        targetId: task.id,
        departmentId: task.departmentId,
        outcome: "DENIED",
        detail: { from: task.status, to },
      }),
    );
    throw new ApiError(403, "FORBIDDEN", "You cannot perform this transition");
  }
  if (rule.need === "reason" && !input.blockedReason?.trim()) {
    throw new ApiError(400, "VALIDATION", "A blocked task needs a reason");
  }
  if (rule.need === "note" && !input.note?.trim()) {
    throw new ApiError(400, "VALIDATION", "A revision request needs a reason");
  }
  // no self-review: the assignee never signs off their own submission (an APPROVE
  // grant makes an assignee "APPROVER", so guard it here)
  if (to === TaskStatus.COMPLETED && !isSuperAdmin(session) && task.assigneeId === session.user.id) {
    throw new ApiError(403, "FORBIDDEN", "The assignee cannot approve their own work");
  }

  const done = to === TaskStatus.COMPLETED || to === TaskStatus.CANCELLED;
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.task.update({
      where: { id: task.id },
      data: {
        status: to,
        note: input.note?.trim() ? input.note.trim() : task.note,
        blockedReason: to === TaskStatus.BLOCKED ? input.blockedReason?.trim() : null,
        closedAt: done ? new Date() : null,
      },
      include: taskInclude,
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: `TASK_${to}`,
      targetType: "Task",
      targetId: task.id,
      departmentId: task.departmentId,
      detail: { from: task.status, to, note: input.note ?? null, blockedReason: input.blockedReason ?? null },
    });
    const others = [task.assigneeId, task.reviewerId, task.createdById].filter(
      (id): id is string => id !== null && id !== session.user.id,
    );
    await notifyUsers(tx, others, {
      title: `Task ${to.replace(/_/g, " ").toLowerCase()}: ${task.title}`,
      body: `${session.user.name} moved it from ${task.status} to ${to}`,
      link: "/my",
    });
    return row;
  });

  return updated;
}
