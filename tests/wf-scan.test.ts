import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import { scanWorkflows, startWorkflow } from "@/lib/workflows";
import type { AuthSession } from "@/lib/authorize";

const DEPT = { slug: "test-wf-scan-dept", name: "Test Wf Scan Dept", number: 981, accent: "#616161" };
const EMAILS = {
  requester: "t.wfscan.requester@mdesk.test",
  manager: "t.wfscan.manager@mdesk.test",
};
const createdUserIds: string[] = [];
let deptId: string;
const instIds: string[] = [];

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

// leave_request = one MANAGER-of-requester's-dept step, 1-working-day SLA
async function pastOverdue(): Promise<string> {
  const inst = await startWorkflow(await sessionFor(EMAILS.requester), {
    key: "leave_request",
    title: "wf scan overdue probe",
  });
  instIds.push(inst.id);
  await db.workflowInstance.update({
    where: { id: inst.id },
    data: { createdAt: new Date(Date.now() - 5 * 24 * 3600e3), dueAt: new Date(Date.now() - 2 * 24 * 3600e3) },
  });
  return inst.id;
}

beforeAll(async () => {
  const dept = await db.department.upsert({
    where: { slug: DEPT.slug },
    update: {},
    create: { number: DEPT.number, name: DEPT.name, slug: DEPT.slug, accentColor: DEPT.accent },
  });
  deptId = dept.id;
  const officerRole = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  const managerRole = await db.role.findUniqueOrThrow({ where: { name: RoleName.MANAGER } });
  const requester = await db.user.create({
    data: { email: EMAILS.requester, name: EMAILS.requester, passwordHash: "x", roleId: officerRole.id },
  });
  const manager = await db.user.create({
    data: { email: EMAILS.manager, name: EMAILS.manager, passwordHash: "x", roleId: managerRole.id },
  });
  createdUserIds.push(requester.id, manager.id);
  for (const u of [requester, manager]) {
    await db.departmentMembership.create({ data: { userId: u.id, departmentId: deptId } });
  }
});

afterAll(async () => {
  const ids = createdUserIds;
  await db.approvalAction.deleteMany({ where: { instanceId: { in: instIds } } });
  await db.workflowInstance.deleteMany({ where: { id: { in: instIds } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { targetType: "WorkflowInstance", targetId: { in: instIds } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  // WF_SCAN audits carry no actor (system scan) — leave them (append-only).
  await db.$disconnect();
});

describe("workflow SLA scan", () => {
  it("escalates overdue chains to approver + requester; rerun is a no-op", async () => {
    const overdueId = await pastOverdue();
    // second instance, fresh window (due 1 working day out, half-point not reached)
    const fresh = await startWorkflow(await sessionFor(EMAILS.requester), {
      key: "leave_request",
      title: "wf scan fresh probe",
    });
    instIds.push(fresh.id);

    const first = await scanWorkflows();
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    const rows = await db.workflowInstance.findMany({ where: { id: { in: [overdueId, fresh.id] } } });
    const od = rows.find((r) => r.id === overdueId)!;
    const fr = rows.find((r) => r.id === fresh.id)!;
    expect(od.escalatedAt).not.toBeNull();
    expect(fr.escalatedAt).toBeNull();
    expect(fr.remindedAt).toBeNull(); // fresh window untouched

    // receipts: the waiting manager escalated both ways, the requester got told too
    const manager = await db.user.findUniqueOrThrow({ where: { email: EMAILS.manager } });
    const requester = await db.user.findUniqueOrThrow({ where: { email: EMAILS.requester } });
    const managerOverdue = await db.notification.findFirst({
      where: { userId: manager.id, title: "OVERDUE: wf scan overdue probe" },
    });
    const requesterOverdue = await db.notification.findFirst({
      where: { userId: requester.id, title: "OVERDUE: wf scan overdue probe" },
    });
    expect(managerOverdue).not.toBeNull();
    expect(requesterOverdue).not.toBeNull();

    const audit = await db.auditEvent.findFirst({ where: { action: "WF_SCAN" }, orderBy: { createdAt: "desc" } });
    expect(audit).not.toBeNull();
    expect((audit?.detail as { escalated?: number })?.escalated).toBeGreaterThanOrEqual(1);

    // rerun: stamps make it free
    const before = await db.notification.count({
      where: { userId: { in: createdUserIds }, title: { contains: "wf scan" } },
    });
    const second = await scanWorkflows();
    expect(second.escalated).toBe(0);
    expect(second.reminded).toBe(0);
    const after = await db.notification.count({
      where: { userId: { in: createdUserIds }, title: { contains: "wf scan" } },
    });
    expect(after).toBe(before);
  });
});
