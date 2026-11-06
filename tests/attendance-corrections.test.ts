import { beforeEach, describe, expect, it, vi } from "vitest";

// Database, HR gate and notifications are mocked: these tests cover the request / decision rules.
type Corr = { id: string; employeeId: string; date: Date; requestedStatus: string; reason: string; status: string; requestedById: string; employee: { id: string; name: string; userId: string | null; managerId: string | null } };
const state = {
  employees: [
    { id: "e1", name: "Asha", userId: "u-asha", managerId: "u-mgr" },
    { id: "e2", name: "Ravi", userId: "u-ravi", managerId: "u-other" },
  ],
  records: new Map<string, string>(),
  corrections: [] as Corr[],
  hrEdit: new Set<string>(),
  audits: [] as string[],
  notified: [] as string[][],
};
const key = (e: string, d: Date) => `${e}|${d.toISOString().slice(0, 10)}`;

const tx = {
  attendanceCorrection: {
    create: vi.fn(async ({ data }: { data: Omit<Corr, "id" | "status" | "employee"> }) => {
      const emp = state.employees.find((e) => e.id === data.employeeId)!;
      const c = { ...data, id: `c${state.corrections.length + 1}`, status: "PENDING", employee: emp };
      state.corrections.push(c);
      return c;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
      const c = state.corrections.find((x) => x.id === where.id)!;
      c.status = data.status;
      return c;
    }),
  },
  attendanceRecord: {
    findUnique: vi.fn(async ({ where }: { where: { employeeId_date: { employeeId: string; date: Date } } }) => {
      const s = state.records.get(key(where.employeeId_date.employeeId, where.employeeId_date.date));
      return s ? { status: s } : null;
    }),
    upsert: vi.fn(async ({ where, update }: { where: { employeeId_date: { employeeId: string; date: Date } }; update: { status: string } }) => {
      state.records.set(key(where.employeeId_date.employeeId, where.employeeId_date.date), update.status);
    }),
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    employee: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => state.employees.find((e) => e.userId === where.userId) ?? null),
    },
    attendanceCorrection: {
      findFirst: vi.fn(async ({ where }: { where: { employeeId: string; date: Date; status: string } }) =>
        state.corrections.find((c) => c.employeeId === where.employeeId && +c.date === +where.date && c.status === where.status) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.corrections.find((c) => c.id === where.id) ?? null),
    },
    attendanceRecord: { findUnique: (a: never) => tx.attendanceRecord.findUnique(a) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));
vi.mock("@/lib/hr", () => ({
  hrDept: vi.fn(async () => ({ id: "hr", name: "HR" })),
  hrAdminIds: vi.fn(async () => ["u-hr"]),
  hrCan: vi.fn(async (s: { user: { id: string } }) => state.hrEdit.has(s.user.id)),
  hrAudit: vi.fn(async (_t: unknown, _s: unknown, _d: unknown, e: { action: string }) => state.audits.push(e.action)),
}));
vi.mock("@/lib/notify", () => ({ notifyUsers: vi.fn(async (_t: unknown, ids: string[]) => state.notified.push(ids)) }));

const { decideCorrection, requestCorrection } = await import("@/lib/hr-attendance-corrections");
const as = (id: string) => ({ user: { id, email: `${id}@x`, role: { name: "OFFICER" } } }) as never;
const yesterday = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - 1));
};

beforeEach(() => {
  state.records.clear();
  state.corrections = [];
  state.hrEdit = new Set(["u-hr"]);
  state.audits = [];
  state.notified = [];
});

describe("attendance correction requests", () => {
  it("employee requests; manager and HR are notified; no duplicate pending request for the day", async () => {
    state.records.set(key("e1", yesterday()), "ABSENT");
    await requestCorrection(as("u-asha"), { date: yesterday(), status: "PRESENT", reason: "Punch missed" });
    expect(state.corrections[0]).toMatchObject({ previousStatus: "ABSENT", requestedStatus: "PRESENT", status: "PENDING" });
    expect(state.notified[0]).toEqual(["u-mgr", "u-hr"]);
    await expect(requestCorrection(as("u-asha"), { date: yesterday(), status: "HALF_DAY", reason: "again" })).rejects.toThrow(/pending request/);
  });

  it("refuses future days, very old days, unchanged status and non-employees", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    await expect(requestCorrection(as("u-asha"), { date: tomorrow, status: "PRESENT", reason: "x x" })).rejects.toThrow(/past day/);
    await expect(requestCorrection(as("u-asha"), { date: new Date("2020-01-01"), status: "PRESENT", reason: "x x" })).rejects.toThrow(/60 days/);
    state.records.set(key("e1", yesterday()), "PRESENT");
    await expect(requestCorrection(as("u-asha"), { date: yesterday(), status: "PRESENT", reason: "x x" })).rejects.toThrow(/already recorded/);
    await expect(requestCorrection(as("u-nobody"), { date: yesterday(), status: "PRESENT", reason: "x x" })).rejects.toThrow(/Only employees/);
  });

  it("the reporting manager approves; the record is updated and the correction audited", async () => {
    await requestCorrection(as("u-asha"), { date: yesterday(), status: "HALF_DAY", reason: "Left early" });
    expect(await decideCorrection(as("u-mgr"), "c1", { action: "APPROVE" })).toBe("APPROVED");
    expect(state.records.get(key("e1", yesterday()))).toBe("HALF_DAY");
    expect(state.audits).toContain("HR_ATTENDANCE_CORRECTED");
    expect(state.notified.at(-1)).toEqual(["u-asha"]);
  });

  it("only the manager or HR may decide, never the employee, and rejecting needs a reason", async () => {
    await requestCorrection(as("u-asha"), { date: yesterday(), status: "PRESENT", reason: "Punch missed" });
    await expect(decideCorrection(as("u-other"), "c1", { action: "APPROVE" })).rejects.toThrow(/Not found/);
    await expect(decideCorrection(as("u-asha"), "c1", { action: "APPROVE" })).rejects.toThrow(/Not found/);
    await expect(decideCorrection(as("u-hr"), "c1", { action: "REJECT" })).rejects.toThrow(/reason/);
    expect(await decideCorrection(as("u-hr"), "c1", { action: "REJECT", note: "No evidence" })).toBe("REJECTED");
    expect(state.records.size).toBe(0);
    await expect(decideCorrection(as("u-hr"), "c1", { action: "APPROVE" })).rejects.toThrow(/already been decided/);
  });

  it("the requester can cancel while pending; nobody else can", async () => {
    await requestCorrection(as("u-asha"), { date: yesterday(), status: "PRESENT", reason: "Punch missed" });
    await expect(decideCorrection(as("u-mgr"), "c1", { action: "CANCEL" })).rejects.toThrow(/Not found/);
    expect(await decideCorrection(as("u-asha"), "c1", { action: "CANCEL" })).toBe("CANCELLED");
  });
});
