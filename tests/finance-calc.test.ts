import { describe, expect, it } from "vitest";
import {
  addDays,
  formatINR,
  formatLakh,
  isValidAmount,
  istDate,
  monthEnd,
  monthKey,
  monthLabel,
  roundRupee,
} from "@/lib/finance-format";
import {
  advanceOutstanding,
  billCounts,
  billPayable,
  budgetRows,
  byCategory,
  closeChecklist,
  committed,
  filterBills,
  inPeriod,
  instalmentRows,
  missingForApproval,
  monthlyInOut,
  needsAttention,
  paidOut,
  periodByKey,
  reconciliation,
  receiptTotals,
  summary,
  verifiedIn,
} from "@/lib/finance-calc";
import type { Bill, FinanceState, LedgerEntry, Receipt, Stamp, WorkOrder } from "@/lib/finance-types";
import { emptyState } from "@/lib/finance-rules";

const S: Stamp = { id: "u1", name: "Accountant", at: "2026-10-01T10:00:00.000Z" };

function entry(p: Partial<LedgerEntry> & Pick<LedgerEntry, "id" | "date" | "kind" | "direction" | "amount">): LedgerEntry {
  return {
    ref: p.id,
    projectId: "p1",
    category: null,
    description: "",
    accountId: "hdfc",
    instalmentNo: null,
    workOrderId: null,
    source: null,
    reversesId: null,
    reversedById: null,
    bankLineId: null,
    createdBy: S,
    ...p,
  };
}

function bill(p: Partial<Bill> & Pick<Bill, "id" | "status">): Bill {
  return {
    projectId: "p1",
    vendorId: "v1",
    type: "FABRICATOR_BILL",
    category: "FABRICATOR",
    workOrderId: null,
    shed: null,
    submittedAmount: 100000,
    finalAmount: null,
    amountReason: null,
    amountEditedBy: null,
    advanceId: null,
    advanceDeduction: 0,
    workAccepted: true,
    billDate: "2026-10-10",
    dueDate: "2026-11-10",
    createdBy: S,
    submittedBy: S,
    checkedBy: null,
    approvedBy: null,
    paidBy: null,
    payment: null,
    rejectedReason: null,
    overBudget: false,
    docs: [
      { id: "d1", kind: "INVOICE", title: "Invoice.pdf", source: "Documents", addedBy: "x", addedAt: S.at },
      { id: "d2", kind: "COMPLETION_PROOF", title: "Photos", source: "Shed record", addedBy: "x", addedAt: S.at },
    ],
    history: [],
    ...p,
  };
}

function wo(p: Partial<WorkOrder> & Pick<WorkOrder, "id" | "amount">): WorkOrder {
  return {
    projectId: "p1",
    vendorId: "v1",
    category: "FABRICATOR",
    description: "Sheds",
    shed: null,
    approved: true,
    closed: false,
    instalmentNo: 1,
    placedOn: "2026-09-01",
    ...p,
  };
}

function receipt(p: Partial<Receipt> & Pick<Receipt, "id" | "status" | "amount">): Receipt {
  return {
    projectId: "p1",
    from: "Scheme department",
    purpose: "Instalment",
    receivedOn: "2026-10-05",
    reference: null,
    instalmentNo: null,
    enteredBy: S,
    bankLineId: null,
    linkedBy: null,
    verifiedBy: null,
    returnedReason: null,
    ledgerId: null,
    history: [],
    ...p,
  };
}

function state(p: Partial<FinanceState>): FinanceState {
  return {
    ...emptyState(),
    projects: [
      { id: "p1", name: "Project One", scheme: "Scheme", sanctioned: 5000000 },
      { id: "p2", name: "Project Two", scheme: "Scheme", sanctioned: 1000000 },
    ],
    accounts: [{ id: "hdfc", name: "HDFC current account", bank: "HDFC", last4: "4821" }],
    ...p,
  };
}

const FY = periodByKey("fy2026");
const all = { projectId: "all", period: FY };
const p1 = { projectId: "p1", period: FY };

describe("finance formatting", () => {
  it("formats rupees with Indian grouping", () => {
    expect(formatINR(186000)).toBe("₹1,86,000");
    expect(formatINR(2085000)).toBe("₹20,85,000");
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(-18500)).toBe("-₹18,500");
    expect(formatINR(1180.5)).toBe("₹1,180.50");
    expect(formatINR(999)).toBe("₹999");
  });

  it("formats lakhs with two decimals", () => {
    expect(formatLakh(4860000)).toBe("₹48.60 L");
    expect(formatLakh(40000)).toBe("₹0.40 L");
    expect(formatLakh(0)).toBe("₹0.00 L");
    expect(formatLakh(-1180)).toBe("-₹0.01 L");
  });

  it("rounds to paise and rejects bad amounts", () => {
    expect(roundRupee(0.1 + 0.2)).toBe(0.3);
    expect(roundRupee(1180.005)).toBe(1180.01);
    expect(isValidAmount(1)).toBe(true);
    expect(isValidAmount(1180.5)).toBe(true);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-5)).toBe(false);
    expect(isValidAmount(10.123)).toBe(false);
    expect(isValidAmount(Number.NaN)).toBe(false);
    expect(isValidAmount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidAmount(1_00_00_00_001)).toBe(false);
  });

  it("uses the India date for 'today', not the UTC date (regression)", () => {
    // 1:30 am IST on 3 Nov is still 2 Nov in UTC — a payment dated 3 Nov must not count as "future".
    expect(istDate("2026-11-02T20:00:00.000Z")).toBe("2026-11-03");
    expect(istDate("2026-11-03T06:30:00.000Z")).toBe("2026-11-03");
  });

  it("never shows a negative zero (regression)", () => {
    expect(Object.is(roundRupee(0.1 + 0.2 - 0.3), 0)).toBe(true);
    expect(formatINR(0.1 + 0.2 - 0.3)).toBe("₹0");
  });

  it("handles months and dates", () => {
    expect(monthKey("2026-10-31")).toBe("2026-10");
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
});

describe("periods", () => {
  it("filters dates by inclusive period bounds", () => {
    expect(inPeriod("2026-04-01", FY)).toBe(true);
    expect(inPeriod("2027-03-31", FY)).toBe(true);
    expect(inPeriod("2026-03-31", FY)).toBe(false);
    expect(inPeriod("2026-10-15", periodByKey("2026-10"))).toBe(true);
    expect(inPeriod("2026-11-01", periodByKey("2026-10"))).toBe(false);
  });

  it("falls back to the financial year for an unknown key", () => {
    expect(periodByKey("nonsense").key).toBe("fy2026");
  });
});

describe("headline figures", () => {
  const ledger = [
    entry({ id: "r1", date: "2026-09-14", kind: "RECEIPT", direction: "IN", amount: 2400000, instalmentNo: 1 }),
    entry({ id: "r2", date: "2026-10-30", kind: "RECEIPT", direction: "IN", amount: 500000, projectId: "p2" }),
    entry({ id: "a1", date: "2026-09-16", kind: "ADVANCE", direction: "OUT", amount: 60000, category: "FABRICATOR", workOrderId: "wo1", instalmentNo: 1 }),
    entry({ id: "pm1", date: "2026-10-02", kind: "PAYMENT", direction: "OUT", amount: 213000, category: "FABRICATOR", workOrderId: "wo1", instalmentNo: 1 }),
    entry({ id: "pm2", date: "2026-10-05", kind: "PAYMENT", direction: "OUT", amount: 18500, category: "MATERIALS", instalmentNo: 1, reversedById: "rv1" }),
    entry({ id: "rv1", date: "2026-10-06", kind: "REVERSAL", direction: "IN", amount: 18500, category: "MATERIALS", reversesId: "pm2", instalmentNo: 1 }),
    entry({ id: "bc1", date: "2026-10-31", kind: "BANK_CHARGE", direction: "OUT", amount: 1180, category: "ADMIN_OTHER", instalmentNo: 1 }),
  ];
  const s = state({
    ledger,
    workOrders: [wo({ id: "wo1", amount: 550000 })],
    receipts: [
      receipt({ id: "c1", status: "CLAIMED", amount: 210000 }),
      receipt({ id: "c2", status: "CLAIMED", amount: 25000, projectId: "p2" }),
      receipt({ id: "x1", status: "RETURNED", amount: 40000 }),
      receipt({ id: "v1", status: "VERIFIED", amount: 2400000, ledgerId: "r1" }),
    ],
  });

  it("counts verified money in only from the ledger", () => {
    expect(verifiedIn(s, p1)).toBe(2400000);
    expect(verifiedIn(s, all)).toBe(2900000);
  });

  it("keeps claimed and returned receipts out of verified", () => {
    expect(receiptTotals(s, p1)).toEqual({ verified: 2400000, claimed: 210000, claimedCount: 1, returned: 40000, returnedCount: 1 });
  });

  it("nets reversals out of paid", () => {
    expect(paidOut(s, p1)).toBe(60000 + 213000 + 1180);
  });

  it("commits only what a work order still owes", () => {
    expect(committed(s, "p1")).toBe(550000 - 60000 - 213000);
  });

  it("adds approved unpaid bills that have no work order to committed", () => {
    const s2 = state({ ...s, bills: [bill({ id: "b1", status: "APPROVED", category: "TRANSPORT", submittedAmount: 12300 })] });
    expect(committed(s2, "p1")).toBe(550000 - 273000 + 12300);
  });

  it("returns five separate figures, cash view = verified minus paid", () => {
    const f = summary(s, p1);
    expect(f.verified).toBe(2400000);
    expect(f.claimed).toBe(210000);
    expect(f.paid).toBe(274180);
    expect(f.committed).toBe(277000);
    expect(f.cash).toBe(2400000 - 274180);
  });

  it("splits spend by category", () => {
    const rows = byCategory(s, p1);
    const fab = rows.find((r) => r.category === "FABRICATOR");
    expect(fab).toMatchObject({ paid: 273000, committed: 277000 });
    expect(rows.find((r) => r.category === "MATERIALS")?.paid).toBe(0);
    expect(rows.reduce((n, r) => n + r.paid, 0)).toBe(paidOut(s, p1));
  });

  it("sums verified in and paid out per month", () => {
    const m = monthlyInOut(s, "p1", "2026-10", 2);
    expect(m.map((x) => x.month)).toEqual(["2026-09", "2026-10"]);
    expect(m[0]).toMatchObject({ verifiedIn: 2400000, paidOut: 60000 });
    expect(m[1]).toMatchObject({ verifiedIn: 0, paidOut: 213000 + 1180 });
  });

  it("works out instalment use without double counting", () => {
    const s3 = state({
      ...s,
      instalments: [
        { projectId: "p1", no: 1, purpose: "First batch", dueNote: "", receiptId: "v1" },
        { projectId: "p1", no: 2, purpose: "Second batch", dueNote: "After utilisation", receiptId: null },
      ],
    });
    const [i1, i2] = instalmentRows(s3, "p1");
    expect(i1).toMatchObject({ released: 2400000, spent: 274180, committed: 277000, remaining: 2400000 - 274180 - 277000, status: "IN_USE" });
    expect(i2).toMatchObject({ released: 0, status: "NOT_RELEASED", remaining: 0 });
  });

  it("flags budget use", () => {
    const s4 = state({
      ...s,
      budgets: [
        { projectId: "p1", category: "FABRICATOR", amount: 600000 },
        { projectId: "p1", category: "ADMIN_OTHER", amount: 1000 },
        { projectId: "p1", category: "MATERIALS", amount: 100000 },
      ],
    });
    const rows = budgetRows(s4, "p1");
    expect(rows.find((r) => r.category === "FABRICATOR")).toMatchObject({ paid: 273000, committed: 277000, left: 50000, flag: "NEARLY_USED" });
    expect(rows.find((r) => r.category === "ADMIN_OTHER")).toMatchObject({ left: -180, flag: "OVER" });
    expect(rows.find((r) => r.category === "MATERIALS")).toMatchObject({ left: 100000, flag: "ON_TRACK" });
  });
});

describe("bills", () => {
  it("pays the final amount less the advance, never the submitted one after an edit", () => {
    expect(billPayable(bill({ id: "b", status: "APPROVED", submittedAmount: 186000, finalAmount: 179500, advanceDeduction: 40000 }))).toBe(139500);
    expect(billPayable(bill({ id: "b", status: "APPROVED", submittedAmount: 92400 }))).toBe(92400);
  });

  it("lists what blocks approval", () => {
    const w = wo({ id: "wo1", amount: 100, approved: false });
    const b = bill({ id: "b", status: "WITH_ACCOUNTANT", workOrderId: "wo1", workAccepted: false, docs: [] });
    expect(missingForApproval(state({ workOrders: [w] }), b)).toEqual([
      "Work order is not approved",
      "AVP has not accepted the completed work",
      "Invoice is not attached",
      "Completion proof is not attached",
    ]);
    const expense = bill({ id: "e", status: "WITH_ACCOUNTANT", type: "EXPENSE", docs: [] });
    expect(missingForApproval(state({}), expense)).toEqual(["Invoice is not attached"]);
  });

  it("counts statuses and filters by search, type, work order and due date", () => {
    const bills = [
      bill({ id: "BL-1", status: "DRAFT", dueDate: "2026-11-04" }),
      bill({ id: "BL-2", status: "WITH_ACCOUNTANT", type: "EXPENSE", dueDate: "2026-11-20" }),
      bill({ id: "BL-3", status: "WITH_FINANCE_HEAD", workOrderId: "WO-9", dueDate: "2026-10-30" }),
      bill({ id: "BL-4", status: "PAID" }),
    ];
    expect(billCounts(bills)).toMatchObject({ ALL: 4, DRAFT: 1, WAITING: 2, APPROVED: 0, PAID: 1, REJECTED: 0 });
    const s = state({ bills, vendors: [{ id: "v1", name: "Fabricator A" }] });
    const now = "2026-11-03";
    expect(filterBills(s, { q: "bl-2" }, now).map((b) => b.id)).toEqual(["BL-2"]);
    expect(filterBills(s, { q: "fabricator" }, now)).toHaveLength(4);
    expect(filterBills(s, { type: "EXPENSE" }, now).map((b) => b.id)).toEqual(["BL-2"]);
    expect(filterBills(s, { wo: "WO-9" }, now).map((b) => b.id)).toEqual(["BL-3"]);
    expect(filterBills(s, { due: "overdue" }, now).map((b) => b.id)).toEqual(["BL-3"]);
    expect(filterBills(s, { due: "week" }, now).map((b) => b.id)).toEqual(["BL-1"]);
    expect(filterBills(s, { status: "WAITING" }, now).map((b) => b.id)).toEqual(["BL-2", "BL-3"]);
    expect(filterBills(s, { q: "   " }, now)).toHaveLength(4);
  });
});

describe("advances", () => {
  it("is amount given minus adjustments", () => {
    const adj = (amount: number) => ({ id: "x", kind: "EXPENSE_SETTLED" as const, amount, note: "", billId: null, ledgerId: null, by: S });
    expect(advanceOutstanding({ amount: 15000, adjustments: [adj(4000), adj(5200)] })).toBe(5800);
    expect(advanceOutstanding({ amount: 60000, adjustments: [adj(60000)] })).toBe(0);
    expect(advanceOutstanding({ amount: 0.3, adjustments: [adj(0.1), adj(0.2)] })).toBe(0);
  });
});

describe("reconciliation", () => {
  const ledger = [
    entry({ id: "r1", date: "2026-10-30", kind: "RECEIPT", direction: "IN", amount: 2085000, bankLineId: "L1" }),
    entry({ id: "pm1", date: "2026-10-27", kind: "PAYMENT", direction: "OUT", amount: 125000, bankLineId: "L2", category: "FABRICATOR" }),
    entry({ id: "pm2", date: "2026-10-31", kind: "PAYMENT", direction: "OUT", amount: 5000, category: "TRANSPORT" }),
  ];
  const line = (id: string, date: string, amount: number, p: Record<string, unknown> = {}) => ({
    id,
    accountId: "hdfc",
    month: "2026-10",
    date,
    description: id,
    reference: id,
    amount,
    ledgerId: null,
    receiptId: null,
    classification: "NONE" as const,
    explanation: null,
    matchedBy: null,
    ...p,
  });
  const s = state({
    ledger,
    receipts: [receipt({ id: "RC-2", status: "CLAIMED", amount: 210000, receivedOn: "2026-10-26" })],
    bankLines: [
      line("L1", "2026-10-30", 2085000, { ledgerId: "r1" }),
      line("L2", "2026-10-27", -125000, { ledgerId: "pm1" }),
      line("L3", "2026-10-28", 210000),
      line("L4", "2026-10-31", -1180, { classification: "BANK_CHARGE" }),
      line("L5", "2026-10-03", 40000),
    ],
    uploads: [{ accountId: "hdfc", month: "2026-10", lines: 5, by: S, fileName: "oct.csv" }],
  });

  it("explains the whole difference", () => {
    const r = reconciliation(s, "hdfc", "2026-10");
    expect(r.bankClosing).toBe(2085000 - 125000 + 210000 - 1180 + 40000);
    expect(r.booksClosing).toBe(2085000 - 125000 - 5000);
    expect(r.difference).toBe(r.bankClosing - r.booksClosing);
    expect(r.explainedTotal).toBe(r.difference);
    expect(r.counts).toEqual({ matched: 2, suggested: 1, notMatched: 2, open: 3 });
  });

  it("suggests a claimed receipt with the same amount within a few days", () => {
    const r = reconciliation(s, "hdfc", "2026-10");
    const l3 = r.lines.find((x) => x.line.id === "L3");
    expect(l3?.status).toBe("SUGGESTED");
    expect(l3?.suggestion).toEqual({ type: "RECEIPT", id: "RC-2" });
    expect(r.lines.find((x) => x.line.id === "L5")?.status).toBe("NOT_MATCHED");
  });

  it("does not suggest one receipt for two lines", () => {
    const s2 = state({ ...s, bankLines: [...s.bankLines, line("L6", "2026-10-27", 210000)] });
    const r = reconciliation(s2, "hdfc", "2026-10");
    expect(r.lines.filter((x) => x.suggestion?.id === "RC-2")).toHaveLength(1);
  });

  it("drives the close checklist", () => {
    const c = closeChecklist(s, "hdfc", "2026-10");
    expect(c.items.map((i) => i.status)).toEqual(["DONE", "DONE", "DONE", "WAITING", "NOT_STARTED", "NOT_STARTED"]);
    expect(c.canSignOff).toBe(false);
    expect(c.canLock).toBe(false);
  });

  it("raises attention items from the data", () => {
    const s2 = state({
      ...s,
      bills: [
        bill({ id: "a", status: "WITH_ACCOUNTANT", docs: [], billDate: "2026-10-28", submittedBy: { ...S, at: "2026-10-28T10:00:00.000Z" } }),
        bill({ id: "b", status: "APPROVED", dueDate: "2026-11-05" }),
      ],
    });
    const n = needsAttention(s2, all, "2026-11-03T10:00:00.000Z");
    expect(n.find((x) => x.key === "waiting")).toMatchObject({ count: 1, detail: "Oldest has waited 6 days" });
    expect(n.find((x) => x.key === "claimed")?.count).toBe(1);
    expect(n.find((x) => x.key === "unmatched")?.count).toBe(3);
    expect(n.find((x) => x.key === "due")?.count).toBe(1);
    expect(n.find((x) => x.key === "missing")?.count).toBe(1);
  });
});
