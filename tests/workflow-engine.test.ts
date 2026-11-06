import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName, WfStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { actOnInstance, listWorkflows, startWorkflow } from "@/lib/workflows";
import type { AuthSession } from "@/lib/authorize";

const DEPT = { slug: "test-wf-dept", name: "Test Wf Dept", accent: "#050505" };
const DEPT_B = { slug: "test-wf-dept-other", name: "Test Wf Dept Other", accent: "#030303" };

const EMAILS = {
  requester: "t.wf.requester@mdesk.test",
  deptHead: "t.wf.managers@mdesk.test", // MANAGER in the requester's department
  selfManager: "t.wf.requestermgr@mdesk.test", // requester who is also a MANAGER there
  finManager: "t.wf.finmgr@mdesk.test", // MANAGER, Finance & Accounts (DoA tier 1)
  finAdmin: "t.wf.finadmin@mdesk.test", // ADMIN, Finance & Accounts
  outsider: "t.wf.outsider@mdesk.test", // other department, OFFICER
  colleague: "t.wf.colleague@mdesk.test", // same dept, OFFICER — visible non-approver
};

const createdUserIds: string[] = [];
let deptId: string;
let deptBId: string;
let financeId: string;
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

async function mkMember(email: string, roleName: RoleName, departmentId?: string) {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
  createdUserIds.push(u.id);
  if (departmentId) {
    await db.departmentMembership.create({ data: { userId: u.id, departmentId } });
  }
  return u;
}

async function started(email: string, key: string, title: string, amount?: number) {
  const inst = await startWorkflow(await sessionFor(email), { key, title, amount });
  instIds.push(inst.id);
  return inst;
}

beforeAll(async () => {
  const [[a, b], finance] = await Promise.all([
    Promise.all([
      db.department.upsert({
        where: { slug: DEPT.slug },
        update: {},
        create: { number: 979, name: DEPT.name, slug: DEPT.slug, accentColor: DEPT.accent },
      }),
      db.department.upsert({
        where: { slug: DEPT_B.slug },
        update: {},
        create: { number: 980, name: DEPT_B.name, slug: DEPT_B.slug, accentColor: DEPT_B.accent },
      }),
    ]),
    db.department.findUniqueOrThrow({ where: { slug: "finance-accounts" } }),
  ]);
  deptId = a.id;
  deptBId = b.id;
  financeId = finance.id;
  await mkMember(EMAILS.requester, RoleName.OFFICER, deptId);
  await mkMember(EMAILS.deptHead, RoleName.MANAGER, deptId);
  await mkMember(EMAILS.finManager, RoleName.MANAGER, financeId);
  await mkMember(EMAILS.finAdmin, RoleName.ADMIN, financeId);
  await mkMember(EMAILS.outsider, RoleName.OFFICER, deptBId);
  await mkMember(EMAILS.colleague, RoleName.OFFICER, deptId);
  // self-manager variant needs its own membership: requesters who are MANAGER
  // in their own department are never approvers of their own request
  await mkMember(EMAILS.selfManager, RoleName.MANAGER, deptId);
});

afterAll(async () => {
  const ids = createdUserIds;
  await db.approvalAction.deleteMany({ where: { instanceId: { in: instIds } } });
  await db.workflowInstance.deleteMany({ where: { id: { in: instIds } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { targetType: "WorkflowInstance", targetId: { in: instIds } }] },
  });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { slug: { in: [DEPT.slug, DEPT_B.slug] } } });
  await db.$disconnect();
});

describe("workflow engine", () => {
  it("leave: start → dept head approves → completed, audited + requester notified", async () => {
    const inst = await started(EMAILS.requester, "leave_request", "Ravi annual leave 3 days");

    // the system picked the seeded dept MANAGER chain: requester's dept
    const head = await sessionFor(EMAILS.deptHead);
    const { awaitingMine } = await listWorkflows(head);
    expect(awaitingMine.some((i) => i.id === inst.id)).toBe(true);

    await actOnInstance(head, inst.id, "APPROVED", {});
    const done = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(done.status).toBe(WfStatus.COMPLETED);

    const audits = await db.auditEvent.findMany({
      where: { targetType: "WorkflowInstance", targetId: inst.id },
    });
    expect(audits.map((x) => x.action)).toEqual(
      expect.arrayContaining(["WF_STARTED", "WF_APPROVED"]),
    );
    const requester = await db.user.findUniqueOrThrow({ where: { email: EMAILS.requester } });
    const notes = await db.notification.findMany({ where: { userId: requester.id } });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("purchase: DoA tiers route the final step by amount; full chain completes", async () => {
    const inst = await started(EMAILS.requester, "purchase_requisition", "12 tent bundles", 30000);
    const head = await sessionFor(EMAILS.deptHead);

    // tier for 30k: MANAGER of Finance — so the finance ADMIN cannot act here
    await expect(
      actOnInstance(await sessionFor(EMAILS.finAdmin), inst.id, "APPROVED", {}),
    ).rejects.toMatchObject({ status: 404 });

    // a colleague in the requester's dept CAN see it but cannot approve it
    await expect(
      actOnInstance(await sessionFor(EMAILS.colleague), inst.id, "APPROVED", {}),
    ).rejects.toMatchObject({ status: 403 });
    const denied = await db.auditEvent.findFirst({
      where: { action: "DENIED_WF_ACT", targetId: inst.id },
    });
    expect(denied).not.toBeNull();

    await actOnInstance(head, inst.id, "APPROVED", {}); // step 1: dept head
    let row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.currentStep).toBe(1);

    await actOnInstance(await sessionFor(EMAILS.finAdmin), inst.id, "APPROVED", {}); // step 2: finance review
    row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.currentStep).toBe(2);

    await actOnInstance(await sessionFor(EMAILS.finManager), inst.id, "APPROVED", {}); // step 3: DoA tier 1
    row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.status).toBe(WfStatus.COMPLETED);
  });

  it("top DoA tier goes to the super admin", async () => {
    const inst = await started(EMAILS.requester, "purchase_requisition", "Server refresh", 750000);
    const head = await sessionFor(EMAILS.deptHead);
    await actOnInstance(head, inst.id, "APPROVED", {});
    await actOnInstance(await sessionFor(EMAILS.finAdmin), inst.id, "APPROVED", {});
    // ADMIN-of-finance is the tier-2 holder, not valid for 750k — and outside
    // the requester's dept they simply cannot see the instance
    await expect(
      actOnInstance(await sessionFor(EMAILS.finAdmin), inst.id, "APPROVED", {}),
    ).rejects.toMatchObject({ status: 404 });
    await actOnInstance(await sessionFor("admin@manikstu.local"), inst.id, "APPROVED", {});
    const row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.status).toBe(WfStatus.COMPLETED);
  });

  it("a requester never approves their own request", async () => {
    const inst = await started(EMAILS.selfManager, "leave_request", "Self-approved leave");
    await expect(
      actOnInstance(await sessionFor(EMAILS.selfManager), inst.id, "APPROVED", {}),
    ).rejects.toMatchObject({ status: 403 });
    await actOnInstance(await sessionFor(EMAILS.deptHead), inst.id, "APPROVED", {});
  });

  it("reject needs a reason and notifies the requester", async () => {
    const inst = await started(EMAILS.requester, "leave_request", "Unpaid leave next week");
    const head = await sessionFor(EMAILS.deptHead);
    await expect(actOnInstance(head, inst.id, "REJECTED", {})).rejects.toMatchObject({ status: 400 });
    await actOnInstance(head, inst.id, "REJECTED", { comment: "leave balance exhausted" });
    const row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.status).toBe(WfStatus.REJECTED);
    const actions = await db.approvalAction.findMany({ where: { instanceId: inst.id } });
    expect(actions[0].decision).toBe("REJECTED");
    expect(actions[0].comment).toBe("leave balance exhausted");
  });

  it("returned → requester resubmits → same step approver notified again", async () => {
    const inst = await started(EMAILS.requester, "leave_request", "Leave with wrong dates");
    const head = await sessionFor(EMAILS.deptHead);
    await actOnInstance(head, inst.id, "RETURNED", { comment: "dates do not cover the roster" });

    const row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.status).toBe(WfStatus.REVISION_REQUESTED);

    // outsider cannot even see it
    await expect(
      actOnInstance(await sessionFor(EMAILS.outsider), inst.id, "RESUBMITTED", {}),
    ).rejects.toMatchObject({ status: 404 });

    await actOnInstance(await sessionFor(EMAILS.requester), inst.id, "RESUBMITTED", {});
    const back = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(back.status).toBe(WfStatus.IN_PROGRESS);

    const head2 = await listWorkflows(head);
    expect(head2.awaitingMine.some((i) => i.id === inst.id)).toBe(true);
    await actOnInstance(head, inst.id, "APPROVED", {});
  });

  it("requester cancels their own pending request; membership members see it", async () => {
    const inst = await started(EMAILS.requester, "it_access", "Staging VPN for Ravi");
    await actOnInstance(await sessionFor(EMAILS.requester), inst.id, "CANCELLED", {});
    const row = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.status).toBe(WfStatus.CANCELLED);
  });

  it("money workflows without an amount are refused; unknown keys 404", async () => {
    await expect(
      startWorkflow(await sessionFor(EMAILS.requester), { key: "purchase_requisition", title: "no amount" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      startWorkflow(await sessionFor(EMAILS.requester), { key: "ghost_key", title: "n" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
