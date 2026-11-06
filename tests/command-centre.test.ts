import { describe, expect, it } from "vitest";
import { Prisma, RoleName, TaskStatus, UserStatus, WfStatus } from "@prisma/client";
import {
  KPI_REGISTER,
  approvalBacklog,
  ccFilterBacklog,
  ccFilterHeadcount,
  ccFilterInstances,
  ccFilterStages,
  ccFilterTasks,
  ccPeriodKey,
  headcountByDept,
  inr,
  isStale,
  maySeeKpi,
  overdueTasksByDept,
  paymentBacklog,
  periodStart,
  tierOf,
  type WfQueueRow,
} from "@/lib/command-centre";

// Pure unit tests — rows are constructed in memory, no database involved.
// Step shapes mirror the seed's wave-1 definitions so the aggregates are
// exercised against real DoA-tier semantics (P-06 placeholders).

const FIN = "finance-accounts";
const DOA_TIERS = [
  { upTo: 50_000, role: RoleName.MANAGER, dept: FIN },
  { upTo: 500_000, role: RoleName.ADMIN, dept: FIN },
  { upTo: Number.MAX_SAFE_INTEGER, role: RoleName.SUPER_ADMIN, dept: null },
];

const DEF_LEAVE = {
  key: "leave_request",
  name: "Leave request",
  steps: [{ name: "Line manager approval", role: RoleName.MANAGER, dept: null }],
};
const DEF_PURCHASE = {
  key: "purchase_requisition",
  name: "Purchase requisition → payment",
  steps: [
    { name: "Department head approval", role: RoleName.MANAGER, dept: null },
    { name: "Finance review", role: RoleName.ADMIN, dept: FIN },
    { name: "DoA approval", role: RoleName.ADMIN, dept: FIN, tiers: DOA_TIERS },
  ],
};
const DEF_INVOICE = {
  key: "vendor_invoice",
  name: "Vendor invoice → payment approval",
  steps: [
    { name: "Finance verification", role: RoleName.ADMIN, dept: FIN },
    { name: "DoA approval", role: RoleName.ADMIN, dept: FIN, tiers: DOA_TIERS },
  ],
};

const NOW = new Date();
const past = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const future = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const amt = (n: number) => new Prisma.Decimal(n);

function inst(over: Partial<WfQueueRow>): WfQueueRow {
  return {
    id: "i-" + Math.random().toString(36).slice(2, 8),
    currentStep: 0,
    amount: null,
    dueAt: past(2),
    status: WfStatus.IN_PROGRESS,
    createdAt: past(1),
    definition: DEF_LEAVE,
    ...over,
  };
}

describe("Master KPI Register", () => {
  it("carries the 4 sourced v1 KPIs and no faked sources for the pending 6", () => {
    expect(KPI_REGISTER).toHaveLength(10);
    const ids = KPI_REGISTER.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const sourced = KPI_REGISTER.filter((k) => k.source !== null);
    expect(sourced.map((k) => k.id)).toEqual(["overdue_tasks", "approval_backlog", "payment_backlog", "headcount"]);
    const pending = KPI_REGISTER.filter((k) => k.source === null);
    expect(pending).toHaveLength(6);
    for (const p of pending) {
      expect(p.pendingNote).toBeTruthy(); // a pending tile must say WHY it is pending
      expect([2, 3, null]).toContain(p.pendingWave);
    }
    for (const k of KPI_REGISTER) {
      expect(k.owner.length).toBeGreaterThan(0);
      expect(["daily", "monthly"]).toContain(k.refresh);
      expect(k.access.tiers.length).toBeGreaterThan(0);
    }
  });

  it("restricts payments to T1 + finance and decisions to T1 only", () => {
    const pay = KPI_REGISTER.find((k) => k.id === "payment_backlog")!;
    expect(pay.access).toEqual({ tiers: ["T1", "T2"], financeOnly: true });
    const dec = KPI_REGISTER.find((k) => k.id === "pending_decisions")!;
    expect(dec.access.tiers).toEqual(["T1"]);
  });
});

describe("overdueTasksByDept", () => {
  const A = { id: "a", slug: "finance-accounts", name: "Finance & Accounts" };
  const B = { id: "b", slug: "technology-mis", name: "Technology & MIS" };

  it("counts past-due open tasks per department and skips done/undated ones", () => {
    const tasks = [
      { id: "t1", departmentId: "a", dueAt: past(3), status: TaskStatus.IN_PROGRESS },
      { id: "t2", departmentId: "a", dueAt: past(1), status: TaskStatus.OPEN },
      { id: "t3", departmentId: "b", dueAt: past(5), status: TaskStatus.COMPLETED }, // done, ignored
      { id: "t4", departmentId: "b", dueAt: past(5), status: TaskStatus.CANCELLED }, // cancelled, ignored
      { id: "t5", departmentId: "b", dueAt: future(30), status: TaskStatus.OPEN }, // not yet due
      { id: "t6", departmentId: "a", dueAt: null, status: TaskStatus.OPEN }, // no due date set
    ];
    const rows = overdueTasksByDept(tasks, [A, B], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deptId: "a", deptName: A.name, deptSlug: A.slug, count: 2, oldestDueAt: past(3) });
  });
});

describe("approvalBacklog", () => {
  it("groups only open beyond-SLA chains by workflow and resolved approver", () => {
    const rows = approvalBacklog(
      [
        inst({ definition: DEF_LEAVE, dueAt: past(2), createdAt: past(6) }), // line manager
        inst({ definition: DEF_PURCHASE, currentStep: 0, amount: amt(30000), createdAt: past(3) }), // dept head
        inst({ definition: DEF_PURCHASE, currentStep: 1, amount: amt(30000), createdAt: past(1) }), // finance review
        inst({ definition: DEF_INVOICE, currentStep: 1, amount: amt(300000), createdAt: past(4) }), // DoA ADMIN
        inst({ definition: DEF_INVOICE, currentStep: 1, amount: amt(700000), createdAt: past(2) }), // DoA MD tier
        inst({ definition: DEF_LEAVE, status: WfStatus.REVISION_REQUESTED, createdAt: past(2) }), // returned
        inst({ definition: DEF_LEAVE, status: WfStatus.COMPLETED }), // terminal — excluded
        inst({ definition: DEF_LEAVE, dueAt: future(60) }), // fresh — within SLA
      ],
      NOW,
    );

    expect(rows).toHaveLength(6);
    const leave = rows.find((r) => r.key === "leave_request" && r.step === "Line manager approval")!;
    expect(leave).toMatchObject({ role: RoleName.MANAGER, dept: null, count: 1, oldestDays: 6 });

    const revision = rows.find((r) => r.step === "Returned to requester")!;
    expect(revision).toMatchObject({ key: "leave_request", role: null, dept: null, count: 1 });

    const finReview = rows.find((r) => r.step === "Finance review")!;
    expect(finReview).toMatchObject({ key: "purchase_requisition", role: RoleName.ADMIN, dept: FIN, count: 1, oldestDays: 1 });

    const doaAdmin = rows.find((r) => r.step === "DoA approval" && r.role === RoleName.ADMIN)!;
    expect(doaAdmin).toMatchObject({ dept: FIN, count: 1, oldestDays: 4 });

    const doaMd = rows.find((r) => r.step === "DoA approval" && r.role === RoleName.SUPER_ADMIN)!;
    expect(doaMd).toMatchObject({ dept: null, count: 1, oldestDays: 2 });
  });
});

describe("paymentBacklog", () => {
  it("totals open money chains and separates the Finance/DoA queue", () => {
    const b = paymentBacklog(
      [
        inst({ definition: DEF_PURCHASE, currentStep: 0, amount: amt(30000), createdAt: past(3) }), // dept head — not finance yet
        inst({ definition: DEF_PURCHASE, currentStep: 1, amount: amt(30000), createdAt: past(1) }), // finance review
        inst({ definition: DEF_INVOICE, currentStep: 1, amount: amt(300000), dueAt: future(60), createdAt: past(4) }), // DoA ADMIN, fresh
        inst({ definition: DEF_INVOICE, currentStep: 1, amount: amt(700000), dueAt: future(980), createdAt: past(5) }), // DoA MD tier, fresh
        inst({ definition: DEF_INVOICE, status: WfStatus.REVISION_REQUESTED, amount: amt(5000), createdAt: past(2) }), // returned to filer
        inst({ definition: DEF_LEAVE, amount: amt(999999) }), // not money
        inst({ definition: DEF_PURCHASE, status: WfStatus.COMPLETED, amount: amt(50000) }), // terminal
      ],
      NOW,
    );
    expect(b.chains).toBe(5);
    expect(b.totalAmount).toBe(1_065_000);
    expect(b.overdue).toBe(3);
    expect(b.awaitingFinance).toBe(3); // finance review + DoA ADMIN + MD gate
    expect(b.awaitingFinanceTotal).toBe(1_030_000);
    expect(b.byStage).toHaveLength(5); // dept head, finance review, DoA@FIN, DoA@MD, returned
  });
});

describe("tier access (M2)", () => {
  it("tiers: t1 super admin, t2 admin+manager, everything else t3", () => {
    expect(tierOf(RoleName.SUPER_ADMIN)).toBe("T1");
    expect(tierOf(RoleName.ADMIN)).toBe("T2");
    expect(tierOf(RoleName.MANAGER)).toBe("T2");
    expect(tierOf(RoleName.OFFICER)).toBe("T3");
    expect(tierOf(RoleName.FIELD_STAFF)).toBe("T3");
  });

  it("access matrix: t1 sees all incl. finance-only; t2 needs finance membership; t1-only blocks t2", () => {
    const md = { role: RoleName.SUPER_ADMIN, financeMember: false };
    const finAdmin = { role: RoleName.ADMIN, financeMember: true };
    const lineManager = { role: RoleName.MANAGER, financeMember: false };
    const officer = { role: RoleName.OFFICER, financeMember: false };
    for (const k of KPI_REGISTER) expect(maySeeKpi(k, md)).toBe(true); // MD overrides every gate

    const pay = KPI_REGISTER.find((k) => k.id === "payment_backlog")!;
    const dec = KPI_REGISTER.find((k) => k.id === "pending_decisions")!;
    const over = KPI_REGISTER.find((k) => k.id === "overdue_tasks")!;

    expect(maySeeKpi(pay, finAdmin)).toBe(true); // finance membership satisfies financeOnly
    expect(maySeeKpi(pay, lineManager)).toBe(false); // t2 but not finance
    expect(maySeeKpi(pay, officer)).toBe(false);
    expect(maySeeKpi(dec, finAdmin)).toBe(false); // t2 does not reach t1-only KPIs
    expect(maySeeKpi(over, lineManager)).toBe(true);

    // officers only reach the open-information (source-pending) project KPIs
    const visibleToOfficer = KPI_REGISTER.filter((k) => maySeeKpi(k, officer)).map((k) => k.id);
    expect(visibleToOfficer).toEqual(["active_projects", "projects_on_track", "critical_milestones"]);
  });

  it("inr renders en-IN grouping with ₹ and whole numbers", () => {
    expect(inr(1065000)).toBe("₹10,65,000");
    expect(inr(500)).toBe("₹500");
    expect(inr(0)).toBe("₹0");
  });
});

describe("headcountByDept", () => {
  it("counts active users per membership with role break-out", () => {
    const ru = (id: string, name: RoleName, status: UserStatus) => ({ id, status, role: { name } });
    const users = [
      ru("u1", RoleName.OFFICER, UserStatus.ACTIVE),
      ru("u2", RoleName.MANAGER, UserStatus.ACTIVE),
      ru("u3", RoleName.OFFICER, UserStatus.ACTIVE),
      ru("u4", RoleName.OFFICER, UserStatus.DISABLED), // leaver — headcount ignores
    ];
    const memberships = [
      { userId: "u1", departmentId: "a" },
      { userId: "u1", departmentId: "b" }, // shared service sitter: two depts
      { userId: "u2", departmentId: "a" },
      { userId: "u3", departmentId: "a" },
      { userId: "u4", departmentId: "a" },
    ];
    const rows = headcountByDept(users, memberships, [
      { id: "a", slug: "finance-accounts", name: "Finance & Accounts" },
      { id: "b", slug: "technology-mis", name: "Technology & MIS" },
    ]);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.deptId === "a")!;
    expect(a.total).toBe(3);
    expect(a.byRole).toMatchObject({ [RoleName.OFFICER]: 2, [RoleName.MANAGER]: 1 });
    const b = rows.find((r) => r.deptId === "b")!;
    expect(b.total).toBe(1);
    expect(b.byRole).toMatchObject({ [RoleName.OFFICER]: 1 });
  });
});

describe("M3 filters (department + period)", () => {
  it("period: unknown URL values fall back to all; start is now minus the window; all has none", () => {
    expect(ccPeriodKey("30d")).toBe("30d");
    expect(ccPeriodKey("bogus")).toBe("all");
    expect(ccPeriodKey(undefined)).toBe("all");
    expect(periodStart("all", NOW)).toBeNull();
    expect(periodStart("7d", NOW)).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
    expect(periodStart("90d", NOW)).toEqual(new Date(NOW.getTime() - 90 * 86_400_000));
  });

  it("ccFilterTasks: department narrows, period keeps only just-overdue rows, unfiltered passes all", () => {
    const tasks = [
      { id: "t1", departmentId: "a", dueAt: past(3), status: TaskStatus.IN_PROGRESS }, // inside 30d
      { id: "t2", departmentId: "a", dueAt: past(60), status: TaskStatus.IN_PROGRESS }, // outside 30d
      { id: "t3", departmentId: "b", dueAt: past(3), status: TaskStatus.IN_PROGRESS }, // other dept
      { id: "t4", departmentId: null, dueAt: past(3), status: TaskStatus.IN_PROGRESS }, // dept-less
    ];
    expect(ccFilterTasks(tasks, null, null)).toHaveLength(4);
    expect(ccFilterTasks(tasks, "a", null).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(ccFilterTasks(tasks, "a", periodStart("30d", NOW)!).map((t) => t.id)).toEqual(["t1"]);
  });

  it("ccFilterInstances: keeps chains raised inside the window only", () => {
    const rows = [inst({ createdAt: past(2) }), inst({ createdAt: past(40) })];
    expect(ccFilterInstances(rows, null)).toHaveLength(2);
    expect(ccFilterInstances(rows, periodStart("30d", NOW)!)).toHaveLength(1);
  });

  it("post-aggregation dept filters narrow rows to the selected gate; unfiltered passes through", () => {
    const backlog = approvalBacklog(
      [
        inst({ definition: DEF_PURCHASE, currentStep: 1, amount: amt(30000), createdAt: past(3) }), // waits at FIN
        inst({ definition: DEF_LEAVE, createdAt: past(6) }), // waits on requester (dept null)
      ],
      NOW,
    );
    expect(ccFilterBacklog(backlog, FIN)).toHaveLength(1);
    expect(ccFilterBacklog(backlog, FIN)[0].dept).toBe(FIN);
    expect(ccFilterBacklog(backlog, null)).toHaveLength(2);

    const pay = paymentBacklog([inst({ definition: DEF_INVOICE, currentStep: 1, amount: amt(300000), createdAt: past(4) })], NOW);
    expect(ccFilterStages(pay.byStage, FIN)).toHaveLength(1);
    expect(ccFilterStages(pay.byStage, "other-dept")).toHaveLength(0);
    expect(ccFilterStages(pay.byStage, null)).toHaveLength(1);

    const hc = headcountByDept(
      [
        { id: "u1", status: UserStatus.ACTIVE, role: { name: RoleName.OFFICER } },
        { id: "u2", status: UserStatus.ACTIVE, role: { name: RoleName.MANAGER } },
      ],
      [
        { userId: "u1", departmentId: "a" },
        { userId: "u2", departmentId: "b" },
      ],
      [
        { id: "a", slug: "finance-accounts", name: "Finance & Accounts" },
        { id: "b", slug: "technology-mis", name: "Technology & MIS" },
      ],
    );
    expect(ccFilterHeadcount(hc, "a").map((r) => r.deptId)).toEqual(["a"]);
    expect(ccFilterHeadcount(hc, null)).toHaveLength(2);
  });
});

describe("M4 stale guard (§8 as-of / amber)", () => {
  it("live tiles (asOf = now) are never stale; monthly tiles use a wider grace", () => {
    expect(isStale(NOW, "daily", NOW)).toBe(false); // fresh
    expect(isStale(new Date(NOW.getTime() - 10 * 3600 * 1000), "daily", NOW)).toBe(false); // 10h old — within 36h grace
    expect(isStale(new Date(NOW.getTime() - 48 * 3600 * 1000), "daily", NOW)).toBe(true); // 48h — past grace
  });

  it("null asOf (extract not yet seen) is always stale", () => {
    expect(isStale(null, "daily", NOW)).toBe(true);
  });

  it("monthly tiles tolerate a missed day (grace is 45 days)", () => {
    expect(isStale(new Date(NOW.getTime() - 44 * 86_400_000), "monthly", NOW)).toBe(false);
    expect(isStale(new Date(NOW.getTime() - 46 * 86_400_000), "monthly", NOW)).toBe(true);
  });
});
