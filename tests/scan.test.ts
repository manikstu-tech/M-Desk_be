import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName, TaskStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { scanTasks } from "@/lib/tasks";

const DEPT = { slug: "test-scan-dept", name: "Test Scan Dept", number: 998, accent: "#606060" };
const EMAILS = {
  assignee: "t.scan.assignee@mdesk.test",
  creator: "t.scan.creator@mdesk.test",
};
const createdUserIds: string[] = [];
let deptId: string;
const taskIds: string[] = [];

async function mkTask(input: Partial<{ status: TaskStatus; createdAt: Date; dueAt: Date | null }>) {
  const assignee = await db.user.findUniqueOrThrow({ where: { email: EMAILS.assignee } });
  const creator = await db.user.findUniqueOrThrow({ where: { email: EMAILS.creator } });
  const t = await db.task.create({
    data: {
      title: input.status === TaskStatus.CANCELLED ? "seed terminal" : "scan me",
      departmentId: deptId,
      assigneeId: assignee.id,
      createdById: creator.id,
      status: input.status ?? TaskStatus.OPEN,
      createdAt: input.createdAt ?? new Date(),
      dueAt: "dueAt" in input ? input.dueAt : undefined,
    },
  });
  taskIds.push(t.id);
  return t;
}

beforeAll(async () => {
  const dept = await db.department.upsert({
    where: { slug: DEPT.slug },
    update: {},
    create: { number: DEPT.number, name: DEPT.name, slug: DEPT.slug, accentColor: DEPT.accent },
  });
  deptId = dept.id;
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  for (const email of Object.values(EMAILS)) {
    const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
    createdUserIds.push(u.id);
    await db.departmentMembership.create({ data: { userId: u.id, departmentId: deptId } });
  }
});

afterAll(async () => {
  const ids = createdUserIds;
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { slug: DEPT.slug } });
  // TASK_SCAN audits carry no actor — the scan is the system; leave them (append-only).
  await db.$disconnect();
});

describe("objective scan", () => {
  it("escalates overdue, reminds past-half-window, ignores early; rerun is a no-op", async () => {
    // overdue regardless of window shape
    const overdueAgenda = mkTask({
      status: TaskStatus.IN_PROGRESS,
      createdAt: new Date(Date.now() - 5 * 24 * 3600e3),
      dueAt: new Date(Date.now() - 2 * 24 * 3600e3),
    });
    // 75% of a 4-day window elapsed → due for reminder
    const halfWindow = mkTask({
      createdAt: new Date(Date.now() - 3 * 24 * 3600e3),
      dueAt: new Date(Date.now() + 1 * 24 * 3600e3),
    });
    // 10% elapsed → untouched
    const early = mkTask({
      createdAt: new Date(),
      dueAt: new Date(Date.now() + 10 * 24 * 3600e3),
    });
    // terminal tasks never escalate, even overdue
    const cancelled = mkTask({
      status: TaskStatus.CANCELLED,
      createdAt: new Date(Date.now() - 5 * 24 * 3600e3),
      dueAt: new Date(Date.now() - 1 * 24 * 3600e3),
    });
    const [ov, hw] = await Promise.all([overdueAgenda, halfWindow]);
    // early/cancelled created too — scan must skip both
    await Promise.all([early, cancelled]);

    const first = await scanTasks();
    expect(first.escalated).toBeGreaterThanOrEqual(1); // ours reached escalation…
    expect(first.reminded).toBeGreaterThanOrEqual(1); // …and so did the mid-window one

    const [ovRow, hwRow] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: ov.id } }),
      db.task.findUniqueOrThrow({ where: { id: hw.id } }),
    ]);
    expect(ovRow.escalatedAt).not.toBeNull();
    expect(hwRow.remindedAt).not.toBeNull();
    expect(hwRow.escalatedAt).toBeNull();

    const notesAfterFirst = await db.notification.count({ where: { userId: { in: createdUserIds } } });
    expect(notesAfterFirst).toBeGreaterThanOrEqual(2); // + creator/side rows too

    const second = await scanTasks();
    expect(second).toEqual({ reminded: 0, escalated: 0 });
    const notesAfterSecond = await db.notification.count({ where: { userId: { in: createdUserIds } } });
    expect(notesAfterSecond).toBe(notesAfterFirst); // stamps make repeats free
  });
});
