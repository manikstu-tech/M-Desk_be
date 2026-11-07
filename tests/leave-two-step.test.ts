import { beforeEach, describe, expect, it, vi } from "vitest";

// Database, HR gate and notifications are mocked: these tests cover the manager-then-HR leave rule.
type Req = {
  id: string;
  status: string;
  days: number;
  leaveType: string;
  startDate: Date;
  comment: string | null;
  managerApprovedAt: Date | null;
  managerApprovedById?: string;
  employee: { id: string; name: string; userId: string | null; managerId: string | null };
};
const state = { req: null as unknown as Req, hr: new Set<string>(), audits: [] as string[], notified: [] as string[][] };

const tx = {
  leaveRequest: {
    update: vi.fn(async ({ data }: { data: Partial<Req> }) => Object.assign(state.req, data)),
  },
};
vi.mock("@/lib/db", () => ({
  db: {
    leaveRequest: { findUnique: vi.fn(async () => state.req) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));
vi.mock("@/lib/hr", () => ({
  hrDept: vi.fn(async () => ({ id: "hr" })),
  hrAdminIds: vi.fn(async () => ["u-hr"]),
  hrCan: vi.fn(async (s: { user: { id: string } }) => state.hr.has(s.user.id)),
  requireHr: vi.fn(async () => ({ id: "hr" })),
  hrAudit: vi.fn(async (_t: unknown, _s: unknown, _d: unknown, e: { action: string }) => state.audits.push(e.action)),
}));
vi.mock("@/lib/notify", () => ({ notifyUsers: vi.fn(async (_t: unknown, ids: string[]) => state.notified.push(ids)) }));

const { decideLeave, leaveStage } = await import("@/lib/hr-time");
const as = (id: string) => ({ user: { id, email: `${id}@x`, role: { name: "OFFICER" } } }) as never;

beforeEach(() => {
  state.req = {
    id: "l1",
    status: "PENDING",
    days: 2,
    leaveType: "Casual",
    startDate: new Date("2026-11-10T00:00:00Z"),
    comment: null,
    managerApprovedAt: null,
    employee: { id: "e1", name: "Asha", userId: "u-asha", managerId: "u-mgr" },
  };
  state.hr = new Set(["u-hr"]);
  state.audits = [];
  state.notified = [];
});

describe("leave approval: manager first, then HR", () => {
  it("the manager approves step 1; it stays pending and goes to HR; HR approves step 2", async () => {
    expect(leaveStage(state.req)).toBe("MANAGER");
    await expect(decideLeave(as("u-hr"), "l1", "APPROVE")).rejects.toThrow(/manager to approve first/);
    await decideLeave(as("u-mgr"), "l1", "APPROVE");
    expect(state.req.status).toBe("PENDING");
    expect(state.req.managerApprovedById).toBe("u-mgr");
    expect(state.notified[0]).toEqual(["u-hr"]);
    expect(leaveStage(state.req)).toBe("HR");
    await expect(decideLeave(as("u-mgr"), "l1", "APPROVE")).rejects.toThrow(/HR approves/);
    await decideLeave(as("u-hr"), "l1", "APPROVE");
    expect(state.req.status).toBe("APPROVED");
    expect(state.audits).toEqual(["HR_LEAVE_MANAGER_APPROVED", "HR_LEAVE_APPROVED"]);
  });

  it("the manager can reject at step 1 (with a reason)", async () => {
    await expect(decideLeave(as("u-mgr"), "l1", "REJECT")).rejects.toThrow(/reason/);
    await decideLeave(as("u-mgr"), "l1", "REJECT", "Busy week");
    expect(state.req.status).toBe("REJECTED");
  });

  it("with no manager it goes straight to HR; a manager who is also HR completes both steps", async () => {
    state.req.employee.managerId = null;
    expect(leaveStage(state.req)).toBe("HR");
    await decideLeave(as("u-hr"), "l1", "APPROVE");
    expect(state.req.status).toBe("APPROVED");

    state.req = { ...state.req, status: "PENDING", employee: { ...state.req.employee, managerId: "u-hr" } };
    await decideLeave(as("u-hr"), "l1", "APPROVE");
    expect(state.req).toMatchObject({ status: "APPROVED", managerApprovedById: "u-hr" });
  });

  it("nobody decides their own leave", async () => {
    await expect(decideLeave(as("u-asha"), "l1", "APPROVE")).rejects.toThrow(/own leave/);
  });
});
