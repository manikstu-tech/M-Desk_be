import { describe, expect, it, vi } from "vitest";

// Database and holiday calendar are mocked: these tests cover the conflict and correction report rules.
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const emp = (id: string, name: string) => ({ id, code: id.toUpperCase(), name, employmentType: "PERMANENT", location: "Head office" });
const records = [
  { employeeId: "e1", date: day("2026-11-02"), status: "PRESENT", employee: emp("e1", "Asha") }, // on approved leave
  { employeeId: "e1", date: day("2026-11-03"), status: "ON_LEAVE", employee: emp("e1", "Asha") }, // fine
  { employeeId: "e2", date: day("2026-11-04"), status: "ON_LEAVE", employee: emp("e2", "Ravi") }, // no leave
  { employeeId: "e2", date: day("2026-11-08"), status: "ABSENT", employee: emp("e2", "Ravi") }, // holiday
  { employeeId: "e2", date: day("2026-11-05"), status: "HOLIDAY", employee: emp("e2", "Ravi") }, // not a holiday
  { employeeId: "e2", date: day("2026-11-06"), status: "HALF_DAY", employee: emp("e2", "Ravi") }, // half-day leave: fine
];
const leaves = [
  { employeeId: "e1", startDate: day("2026-11-02"), endDate: day("2026-11-03"), days: 2, leaveType: "Casual" },
  { employeeId: "e2", startDate: day("2026-11-06"), endDate: day("2026-11-06"), days: 0.5, leaveType: "Sick" },
];
const events = [
  { targetId: "e1", actorEmail: "hr@x", actor: { name: "Biren" }, createdAt: day("2026-11-06"), detail: { date: "2026-11-05", from: "HALF_DAY", to: "PRESENT", reason: "Punch missed", source: "correction" } },
  { targetId: "e2", actorEmail: "hr@x", actor: null, createdAt: day("2026-11-01"), detail: { date: "2026-10-20", from: null, to: "ABSENT", reason: "", source: "import" } },
];

vi.mock("@/lib/db", () => ({
  db: {
    attendanceRecord: { findMany: vi.fn(async () => records) },
    leaveRequest: { findMany: vi.fn(async () => leaves) },
    auditEvent: { findMany: vi.fn(async () => events) },
    employee: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [emp("e1", "Asha"), emp("e2", "Ravi")].filter((e) => where.id.in.includes(e.id)),
      ),
    },
  },
}));
vi.mock("@/lib/hr-time", () => ({ holidayKeysFor: vi.fn(async () => new Set(["2026-11-08"])) }));
vi.mock("@/lib/hr", () => ({ requireHr: vi.fn(), hrAudit: vi.fn() }));

const { reportDef } = await import("@/lib/hr-reports");

describe("attendance reports", () => {
  it("flags attendance that disagrees with approved leave or the holiday calendar", async () => {
    const t = await reportDef("attendance-conflicts")!.build({ from: day("2026-11-01"), to: day("2026-11-30") });
    const issues = t.rows.map((r) => `${r[0]} ${r[2]}: ${r[5]}`);
    expect(issues).toEqual([
      "2026-11-02 Asha: Marked present on approved Casual leave",
      "2026-11-04 Ravi: On leave without an approved leave request",
      "2026-11-08 Ravi: Absent on a holiday",
      "2026-11-05 Ravi: Holiday marked on a day not in the holiday calendar",
    ]);
  });

  it("lists corrections with how they were made and who approved them, filtered by day", async () => {
    const all = await reportDef("attendance-corrections")!.build({});
    expect(all.rows[0]).toEqual(["2026-11-05", "E1", "Asha", "Permanent", "Half day", "Present", "Punch missed", "Employee request", "Biren", "2026-11-06"]);
    expect(all.rows[1].slice(4, 9)).toEqual(["Not recorded", "Absent", "", "Excel import", "hr@x"]);
    const nov = await reportDef("attendance-corrections")!.build({ from: day("2026-11-01") });
    expect(nov.rows).toHaveLength(1);
  });
});
