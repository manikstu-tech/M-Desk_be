import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action, RoleName, TaskStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { createGrant } from "@/lib/authorize";
import { createTask, listMyTasks, transitionTask, type TaskRow } from "@/lib/tasks";
import type { AuthSession } from "@/lib/authorize";

const DEPT = { slug: "test-task-dept", name: "Test Task Dept", accent: "#101010" };
const DEPT_B = { slug: "test-task-dept-b", name: "Test Task Dept B", accent: "#202020" };

const EMAILS = {
  creator: "t.task.creator@mdesk.test",
  assignee: "t.task.assignee@mdesk.test",
  reviewer: "t.task.reviewer@mdesk.test",
  member: "t.task.member@mdesk.test", // dept-visible, not involved
  approver: "t.task.approver@mdesk.test", // holds dept APPROVE grant
  outsider: "t.task.outsider@mdesk.test", // other department
};
const createdUserIds: string[] = [];
let deptId: string;
let deptBId: string;

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return {
    id: "test-session",
    token: "x",
    userId: user.id,
    expiresAt: new Date(Date.now() + 1e12),
    userAgent: null,
    createdAt: new Date(),
    user,
  } as unknown as AuthSession;
}

async function mkMember(email: string, roleName: RoleName, departmentId?: string) {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
  createdUserIds.push(u.id);
  if (departmentId) {
    await db.departmentMembership.create({ data: { userId: u.id, departmentId } });
  }
  return u;
}

async function mkTask(session: AuthSession, overrides: Record<string, unknown> = {}) {
  return (await createTask(session, {
    title: "Test task",
    departmentId: deptId,
    assigneeId: (await db.user.findUniqueOrThrow({ where: { email: EMAILS.assignee } })).id,
    reviewerId: (await db.user.findUniqueOrThrow({ where: { email: EMAILS.reviewer } })).id,
    ...overrides,
  })) as unknown as TaskRow;
}

beforeAll(async () => {
  const [a, b] = await Promise.all([
    db.department.upsert({
      where: { slug: DEPT.slug },
      update: {},
      create: { number: 996, name: DEPT.name, slug: DEPT.slug, accentColor: DEPT.accent },
    }),
    db.department.upsert({
      where: { slug: DEPT_B.slug },
      update: {},
      create: { number: 997, name: DEPT_B.name, slug: DEPT_B.slug, accentColor: DEPT_B.accent },
    }),
  ]);
  deptId = a.id;
  deptBId = b.id;
  await mkMember(EMAILS.creator, RoleName.MANAGER, deptId);
  await mkMember(EMAILS.assignee, RoleName.OFFICER, deptId);
  await mkMember(EMAILS.reviewer, RoleName.MANAGER, deptId);
  await mkMember(EMAILS.member, RoleName.OFFICER, deptId);
  await mkMember(EMAILS.approver, RoleName.OFFICER, deptId);
  await mkMember(EMAILS.outsider, RoleName.OFFICER, deptBId);
});

afterAll(async () => {
  const ids = createdUserIds;
  const deptIds = [deptId, deptBId];
  await db.notification.deleteMany({
    where: { OR: [{ userId: { in: ids } }] },
  });
  await db.task.deleteMany({
    where: { OR: [{ departmentId: { in: deptIds } }, { createdById: { in: ids } }] },
  });
  await db.delegationGrant.deleteMany({
    where: { OR: [{ userId: { in: ids } }, { departmentId: { in: deptIds } }] },
  });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { slug: { in: [DEPT.slug, DEPT_B.slug] } } });
  await db.$disconnect();
});

describe("task engine", () => {
  it("happy path: create → start → submit → reviewer completes (audited + notified)", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));

    const assigneeS = await sessionFor(EMAILS.assignee);
    await transitionTask(assigneeS, task.id, TaskStatus.IN_PROGRESS, {});
    await transitionTask(assigneeS, task.id, TaskStatus.SUBMITTED, { note: "work done" });

    const reviewerS = await sessionFor(EMAILS.reviewer);
    const completed = await transitionTask(reviewerS, task.id, TaskStatus.COMPLETED, {});
    expect(completed.status).toBe(TaskStatus.COMPLETED);
    expect(completed.closedAt).not.toBeNull();

    const audits = await db.auditEvent.findMany({ where: { targetType: "Task", targetId: task.id } });
    const names = audits.map((a) => a.action);
    expect(names).toEqual(
      expect.arrayContaining(["TASK_CREATED", "TASK_IN_PROGRESS", "TASK_SUBMITTED", "TASK_COMPLETED"]),
    );
    // assignee and reviewer (non-actors on create) got notified at least once
    const userRows = await db.user.findMany({ where: { email: { in: Object.values(EMAILS) } } });
    const byEmail = Object.fromEntries(userRows.map((r) => [r.email, r.id])) as Record<string, string>;
    const notes = await db.notification.findMany({
      where: { userId: { in: [byEmail[EMAILS.assignee], byEmail[EMAILS.reviewer]] } },
    });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("revision cycle: reviewer without reason → 400; with reason → revision; assignee resubmits", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    const assigneeS = await sessionFor(EMAILS.assignee);
    const reviewerS = await sessionFor(EMAILS.reviewer);

    await transitionTask(assigneeS, task.id, TaskStatus.IN_PROGRESS, {});
    await transitionTask(assigneeS, task.id, TaskStatus.SUBMITTED, {});

    await expect(
      transitionTask(reviewerS, task.id, TaskStatus.REVISION_REQUESTED, {}),
    ).rejects.toMatchObject({ status: 400 });

    await transitionTask(reviewerS, task.id, TaskStatus.REVISION_REQUESTED, { note: "figure out what x means" });
    const reread = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(reread.status).toBe(TaskStatus.REVISION_REQUESTED);
    expect(reread.closedAt).toBeNull();

    await transitionTask(assigneeS, task.id, TaskStatus.SUBMITTED, { note: "clarified" });
    await transitionTask(reviewerS, task.id, TaskStatus.COMPLETED, {});
  });

  it("illegal transitions rejected", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    const assigneeS = await sessionFor(EMAILS.assignee);
    await expect(
      transitionTask(assigneeS, task.id, TaskStatus.COMPLETED, {}),
    ).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
  });

  it("reviewer must differ from assignee", async () => {
    const assignee = await db.user.findUniqueOrThrow({ where: { email: EMAILS.assignee } });
    await expect(
      createTask(await sessionFor(EMAILS.creator), {
        title: "self review",
        departmentId: deptId,
        assigneeId: assignee.id,
        reviewerId: assignee.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("cross-department outsider gets 404, not 403 (no existence leak)", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    await expect(
      transitionTask(await sessionFor(EMAILS.outsider), task.id, TaskStatus.IN_PROGRESS, {}),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("visible non-actor denied with DENIED audit row", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    await transitionTask(
      await sessionFor(EMAILS.assignee),
      task.id,
      TaskStatus.IN_PROGRESS,
      {},
    );
    await transitionTask(
      await sessionFor(EMAILS.assignee),
      task.id,
      TaskStatus.SUBMITTED,
      { note: "ready" },
    );
    await expect(
      transitionTask(await sessionFor(EMAILS.member), task.id, TaskStatus.COMPLETED, {}),
    ).rejects.toMatchObject({ status: 403 });
    const denied = await db.auditEvent.findFirst({
      where: { action: "DENIED_TASK_TRANSITION", targetId: task.id },
    });
    expect(denied).not.toBeNull();
  });

  it("dept APPROVE grantee can approve without being the reviewer", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    const assigneeS = await sessionFor(EMAILS.assignee);
    await transitionTask(assigneeS, task.id, TaskStatus.IN_PROGRESS, {});
    await transitionTask(assigneeS, task.id, TaskStatus.SUBMITTED, { note: "v1" });

    const approver = await db.user.findUniqueOrThrow({ where: { email: EMAILS.approver } });
    await createGrant(await sessionFor("admin@manikstu.local"), {
      userId: approver.id,
      departmentId: deptId,
      action: Action.APPROVE,
      reason: "backup approver",
    });
    const done = await transitionTask(
      await sessionFor(EMAILS.approver),
      task.id,
      TaskStatus.COMPLETED,
      {},
    );
    expect(done.status).toBe(TaskStatus.COMPLETED);
  });

  it("blocked requires a reason; unblock clears it", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    const assigneeS = await sessionFor(EMAILS.assignee);
    await transitionTask(assigneeS, task.id, TaskStatus.IN_PROGRESS, {});

    await expect(
      transitionTask(assigneeS, task.id, TaskStatus.BLOCKED, {}),
    ).rejects.toMatchObject({ status: 400 });

    const blocked = await transitionTask(assigneeS, task.id, TaskStatus.BLOCKED, {
      blockedReason: "waiting on vendor list",
    });
    expect(blocked.blockedReason).toBe("waiting on vendor list");
    expect(blocked.closedAt).toBeNull();

    const freed = await transitionTask(assigneeS, task.id, TaskStatus.IN_PROGRESS, {});
    expect(freed.blockedReason).toBeNull();
  });

  it("listMyTasks buckets by role", async () => {
    const task = await mkTask(await sessionFor(EMAILS.creator));
    await transitionTask(await sessionFor(EMAILS.assignee), task.id, TaskStatus.IN_PROGRESS, {});
    await transitionTask(await sessionFor(EMAILS.assignee), task.id, TaskStatus.SUBMITTED, { note: "ok" });

    const assigneeBuckets = await listMyTasks(await sessionFor(EMAILS.assignee));
    expect(assigneeBuckets.assignedToMe.some((t) => t.id === task.id)).toBe(true);
    const reviewBuckets = await listMyTasks(await sessionFor(EMAILS.reviewer));
    expect(reviewBuckets.forReview.some((t) => t.id === task.id)).toBe(true);
    const outsiderBuckets = await listMyTasks(await sessionFor(EMAILS.outsider));
    expect(
      [...outsiderBuckets.department].some((t) => t.id === task.id),
    ).toBe(false);
    const creatorBuckets = await listMyTasks(await sessionFor(EMAILS.creator));
    expect(creatorBuckets.createdByMe.some((t) => t.id === task.id)).toBe(true);
    // department members see the department bucket even when uninvolved
    const memberBuckets = await listMyTasks(await sessionFor(EMAILS.member));
    expect(memberBuckets.department.some((t) => t.id === task.id)).toBe(true);
  });
});
