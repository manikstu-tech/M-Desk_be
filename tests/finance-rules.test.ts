import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/validation";
import {
  adjustAdvance,
  approveBill,
  attachDoc,
  classifyLine,
  confirmMatch,
  createBill,
  createVoucher,
  decideAdvance,
  decideBudget,
  decideVoucher,
  deleteVoucher,
  editAmount,
  editVoucher,
  emptyState,
  explainLine,
  linkLine,
  linkReceipt,
  lockMonth,
  markPaid,
  postVoucher,
  recordReceipt,
  rejectBill,
  reopenMonth,
  requestAdvance,
  requestBudget,
  returnReceipt,
  signOff,
  submitBill,
  submitVoucher,
  unmatchLine,
  uploadStatement,
  verifyReceipt,
  type Ctx,
} from "@/lib/finance-rules";
import { advanceOutstanding, billCounts, budgetRows, closeChecklist, paidOut, periodByKey, reconciliation, summary } from "@/lib/finance-calc";
import type { Actor, FinanceState } from "@/lib/finance-types";

const NOW = "2026-11-03T06:30:00.000Z";
const who = (id: string, role: Actor["role"], isSuper = false): Actor => ({ id, name: id, role, isSuper });
const acc1 = who("acc1", "ACCOUNTANT");
const acc2 = who("acc2", "ACCOUNTANT");
const head = who("head", "FINANCE_HEAD");
const head2 = who("head2", "FINANCE_HEAD");
const mgmt = who("mgmt", "MANAGEMENT");
const viewer = who("viewer", "VIEWER");
const field = who("field", "FIELD");
const sup = who("sup", "MANAGEMENT", true);
const as = (actor: Actor, now = NOW): Ctx => ({ actor, now });
const FY = { projectId: "p1", period: periodByKey("fy2026") };

function code(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    throw e;
  }
  return 0;
}

let s: FinanceState;

beforeEach(() => {
  s = emptyState();
  s.projects = [{ id: "p1", name: "Project AJAH", scheme: "Scheme", sanctioned: 1000000 }];
  s.vendors = [
    { id: "v1", name: "Fabricator A" },
    { id: "v2", name: "Transport vendor" },
  ];
  s.accounts = [{ id: "hdfc", name: "HDFC current account", bank: "HDFC", last4: "4821" }];
  s.workOrders = [
    { id: "WO-1", projectId: "p1", vendorId: "v1", category: "FABRICATOR", description: "Sheds", shed: "AJ-1", amount: 300000, approved: true, closed: false, instalmentNo: 1, placedOn: "2026-09-01" },
    { id: "WO-2", projectId: "p1", vendorId: "v1", category: "FABRICATOR", description: "Unapproved", shed: null, amount: 50000, approved: false, closed: false, instalmentNo: 1, placedOn: "2026-09-01" },
  ];
  s.budgets = [
    { projectId: "p1", category: "FABRICATOR", amount: 400000 },
    { projectId: "p1", category: "TRANSPORT", amount: 20000 },
    { projectId: "p1", category: "ADMIN_OTHER", amount: 10000 },
  ];
  s.instalments = [{ projectId: "p1", no: 1, purpose: "First", dueNote: "", receiptId: null }];
});

function readyBill(amount = 100000) {
  const b = createBill(s, as(acc1), {
    projectId: "p1",
    vendorId: "v1",
    type: "FABRICATOR_BILL",
    category: "FABRICATOR",
    workOrderId: "WO-1",
    amount,
    billDate: "2026-11-02",
    dueDate: "2026-11-09",
  });
  attachDoc(s, as(acc1), { billId: b.id, kind: "INVOICE", title: "Invoice.pdf" });
  attachDoc(s, as(acc1), { billId: b.id, kind: "COMPLETION_PROOF", title: "Completion photos" });
  s.bills.find((x) => x.id === b.id)!.workAccepted = true;
  submitBill(s, as(acc1), { billId: b.id });
  return b.id;
}

describe("bills: prepared → checked → approved → paid", () => {
  it("runs the whole journey and moves the counts", () => {
    const id = readyBill();
    expect(billCounts(s.bills)).toMatchObject({ WAITING: 1, APPROVED: 0 });
    approveBill(s, as(acc2), { billId: id });
    expect(s.bills[0].status).toBe("WITH_FINANCE_HEAD");
    approveBill(s, as(head), { billId: id });
    expect(billCounts(s.bills)).toMatchObject({ WAITING: 0, APPROVED: 1 });
    const before = paidOut(s, FY);
    markPaid(s, as(acc1), { billId: id, date: "2026-11-03", reference: "UTR-555001" });
    expect(s.bills[0].status).toBe("PAID");
    expect(paidOut(s, FY)).toBe(before + 100000);
    expect(s.ledger.at(-1)).toMatchObject({ kind: "PAYMENT", amount: 100000, workOrderId: "WO-1", source: { type: "BILL", id } });
    expect(s.audit.length).toBeGreaterThan(4);
  });

  it("refuses approval when documents are missing", () => {
    const b = createBill(s, as(acc1), { projectId: "p1", vendorId: "v1", type: "FABRICATOR_BILL", category: "FABRICATOR", workOrderId: "WO-1", amount: 1000, billDate: "2026-11-02", dueDate: "2026-11-09" });
    submitBill(s, as(acc1), { billId: b.id });
    expect(code(() => approveBill(s, as(acc2), { billId: b.id }))).toBe(409);
  });

  it("refuses a bill under an unapproved work order", () => {
    const b = createBill(s, as(acc1), { projectId: "p1", vendorId: "v1", type: "FABRICATOR_BILL", category: "FABRICATOR", workOrderId: "WO-2", amount: 1000, billDate: "2026-11-02", dueDate: "2026-11-09" });
    attachDoc(s, as(acc1), { billId: b.id, kind: "INVOICE", title: "Invoice.pdf" });
    attachDoc(s, as(acc1), { billId: b.id, kind: "COMPLETION_PROOF", title: "Photos" });
    s.bills[0].workAccepted = true;
    submitBill(s, as(acc1), { billId: b.id });
    expect(code(() => approveBill(s, as(acc2), { billId: b.id }))).toBe(409);
  });

  it("blocks self-approval and the checker approving their own check", () => {
    const id = readyBill();
    expect(code(() => approveBill(s, as(acc1), { billId: id }))).toBe(403);
    approveBill(s, as(head), { billId: id });
    expect(code(() => approveBill(s, as(head), { billId: id }))).toBe(403);
    approveBill(s, as(head2), { billId: id });
    expect(s.bills[0].status).toBe("APPROVED");
  });

  it("will not pay a bill before it is approved", () => {
    const id = readyBill();
    expect(code(() => markPaid(s, as(acc1), { billId: id, date: "2026-11-03", reference: "UTR-1" }))).toBe(409);
  });

  it("keeps the submitted amount and needs a second person after an edit", () => {
    const id = readyBill(186000);
    expect(code(() => editAmount(s, as(sup), { billId: id, amount: 179500, reason: "" }))).toBe(422);
    editAmount(s, as(sup), { billId: id, amount: 179500, reason: "Rework on the shed floor" });
    const b = s.bills[0];
    expect(b.submittedAmount).toBe(186000);
    expect(b.finalAmount).toBe(179500);
    approveBill(s, as(acc2), { billId: id });
    expect(code(() => approveBill(s, as(sup), { billId: id }))).toBe(403);
    approveBill(s, as(head), { billId: id });
    expect(b.status).toBe("APPROVED");
  });

  it("rejects only with a reason", () => {
    const id = readyBill();
    expect(code(() => rejectBill(s, as(acc2), { billId: id, reason: " " }))).toBe(422);
    rejectBill(s, as(acc2), { billId: id, reason: "No invoice from the vendor" });
    expect(s.bills[0]).toMatchObject({ status: "REJECTED", rejectedReason: "No invoice from the vendor" });
    expect(code(() => approveBill(s, as(head), { billId: id }))).toBe(409);
  });

  it("refuses duplicate payment references and future payment dates", () => {
    const a = readyBill(1000);
    const b = readyBill(2000);
    for (const id of [a, b]) {
      approveBill(s, as(acc2), { billId: id });
      approveBill(s, as(head), { billId: id });
    }
    markPaid(s, as(acc1), { billId: a, date: "2026-11-03", reference: "UTR-9" });
    expect(code(() => markPaid(s, as(acc1), { billId: b, date: "2026-11-03", reference: "utr-9" }))).toBe(409);
    expect(code(() => markPaid(s, as(acc1), { billId: b, date: "2026-11-30", reference: "UTR-10" }))).toBe(422);
    expect(code(() => markPaid(s, as(acc1), { billId: a, date: "2026-11-03", reference: "UTR-11" }))).toBe(409);
  });

  it("deducts the advance and clears it when the bill is paid", () => {
    const adv = requestAdvance(s, as(acc1), { projectId: "p1", givenTo: "Fabricator A", vendorId: "v1", workOrderId: "WO-1", category: "FABRICATOR", purpose: "Mobilisation", amount: 40000, givenOn: "2026-11-01" });
    decideAdvance(s, as(head), { advanceId: adv.id, approve: true, note: "" });
    const id = readyBill(100000);
    expect(s.bills.find((b) => b.id === id)?.advanceDeduction).toBe(40000);
    approveBill(s, as(acc2), { billId: id });
    approveBill(s, as(head), { billId: id });
    markPaid(s, as(acc1), { billId: id, date: "2026-11-03", reference: "UTR-77" });
    expect(s.ledger.at(-1)?.amount).toBe(60000);
    expect(advanceOutstanding(s.advances[0])).toBe(0);
    expect(s.advances[0].status).toBe("CLEARED");
    expect(paidOut(s, FY)).toBe(100000);
  });

  it("sends an over-budget bill to Management", () => {
    const b = createBill(s, as(acc1), { projectId: "p1", vendorId: "v2", type: "EXPENSE", category: "TRANSPORT", workOrderId: null, amount: 25000, billDate: "2026-11-02", dueDate: "2026-11-09" });
    attachDoc(s, as(acc1), { billId: b.id, kind: "INVOICE", title: "Fuel bills" });
    submitBill(s, as(acc1), { billId: b.id });
    approveBill(s, as(acc2), { billId: b.id });
    expect(code(() => approveBill(s, as(head), { billId: b.id }))).toBe(409);
    expect(s.bills[0].overBudget).toBe(true);
    approveBill(s, as(sup), { billId: b.id });
    expect(s.bills[0].status).toBe("APPROVED");
  });

  it("does not let a viewer or field officer act on bills", () => {
    const id = readyBill();
    expect(code(() => approveBill(s, as(viewer), { billId: id }))).toBe(403);
    expect(code(() => rejectBill(s, as(field), { billId: id, reason: "nope nope" }))).toBe(403);
    expect(code(() => approveBill(s, as(head), { billId: "BL-9999" }))).toBe(404);
  });

  it("accepts today's date just after midnight in India (regression)", () => {
    const id = readyBill(1000);
    approveBill(s, as(acc2, "2026-11-02T19:00:00.000Z"), { billId: id });
    approveBill(s, as(head, "2026-11-02T19:00:00.000Z"), { billId: id });
    // 00:45 IST on 3 Nov = 19:15 UTC on 2 Nov
    expect(code(() => markPaid(s, as(acc1, "2026-11-02T19:15:00.000Z"), { billId: id, date: "2026-11-03", reference: "UTR-MIDNIGHT" }))).toBe(0);
  });

  it("rejects nonsense amounts", () => {
    for (const amount of [0, -5, 10.123, Number.NaN, 1e12]) {
      expect(code(() => createBill(s, as(acc1), { projectId: "p1", vendorId: "v1", type: "EXPENSE", category: "TRANSPORT", workOrderId: null, amount, billDate: "2026-11-02", dueDate: "2026-11-09" }))).toBe(422);
    }
  });
});

describe("receipts: claimed → bank match → second person verifies", () => {
  function upload(lines: { date: string; amount: number; reference: string }[], month = "2026-10") {
    return uploadStatement(s, as(acc1), { accountId: "hdfc", month, fileName: "stmt.csv", lines: lines.map((l) => ({ ...l, description: "NEFT" })) });
  }

  it("counts a receipt as verified only after match and second-person verification", () => {
    const r = recordReceipt(s, as(field), { projectId: "p1", from: "Beneficiary", purpose: "Contribution", amount: 210000, receivedOn: "2026-10-28", reference: "UPI-1192", instalmentNo: null });
    expect(summary(s, FY)).toMatchObject({ verified: 0, claimed: 210000 });
    expect(code(() => verifyReceipt(s, as(acc1), { receiptId: r.id }))).toBe(409);
    upload([{ date: "2026-10-28", amount: 210000, reference: "UPI-1192" }]);
    const line = s.bankLines[0];
    linkReceipt(s, as(acc1), { receiptId: r.id, bankLineId: line.id });
    expect(summary(s, FY).verified).toBe(0);
    expect(code(() => verifyReceipt(s, as(field), { receiptId: r.id }))).toBe(403);
    verifyReceipt(s, as(acc2), { receiptId: r.id });
    expect(summary(s, FY)).toMatchObject({ verified: 210000, claimed: 0 });
    expect(reconciliation(s, "hdfc", "2026-10").difference).toBe(0);
  });

  it("never lets the person who entered a receipt verify it", () => {
    upload([{ date: "2026-10-28", amount: 5000, reference: "X1" }]);
    const r = recordReceipt(s, as(acc1), { projectId: "p1", from: "Vendor refund", purpose: "Excess", amount: 5000, receivedOn: "2026-10-28", reference: null, instalmentNo: null });
    linkReceipt(s, as(acc1), { receiptId: r.id, bankLineId: s.bankLines[0].id });
    expect(code(() => verifyReceipt(s, as(acc1), { receiptId: r.id }))).toBe(403);
  });

  it("refuses links with a different amount or to a line already used", () => {
    upload([{ date: "2026-10-28", amount: 5000, reference: "X1" }]);
    const a = recordReceipt(s, as(acc1), { projectId: "p1", from: "A", purpose: "A", amount: 4000, receivedOn: "2026-10-28", reference: null, instalmentNo: null });
    const b = recordReceipt(s, as(acc1), { projectId: "p1", from: "B", purpose: "B", amount: 5000, receivedOn: "2026-10-28", reference: null, instalmentNo: null });
    const c = recordReceipt(s, as(acc1), { projectId: "p1", from: "C", purpose: "C", amount: 5000, receivedOn: "2026-10-28", reference: null, instalmentNo: null });
    expect(code(() => linkReceipt(s, as(acc1), { receiptId: a.id, bankLineId: s.bankLines[0].id }))).toBe(422);
    linkReceipt(s, as(acc1), { receiptId: b.id, bankLineId: s.bankLines[0].id });
    expect(code(() => linkReceipt(s, as(acc1), { receiptId: c.id, bankLineId: s.bankLines[0].id }))).toBe(409);
  });

  it("refuses duplicate receipt references and needs a reason to return", () => {
    recordReceipt(s, as(acc1), { projectId: "p1", from: "A", purpose: "A", amount: 100, receivedOn: "2026-10-28", reference: "UTR-1", instalmentNo: null });
    expect(code(() => recordReceipt(s, as(acc1), { projectId: "p1", from: "B", purpose: "B", amount: 200, receivedOn: "2026-10-28", reference: "utr-1", instalmentNo: null }))).toBe(409);
    const r = s.receipts[0];
    expect(code(() => returnReceipt(s, as(acc2), { receiptId: r.id, reason: "" }))).toBe(422);
    returnReceipt(s, as(acc2), { receiptId: r.id, reason: "Sender could not be identified" });
    expect(r.status).toBe("RETURNED");
    expect(code(() => verifyReceipt(s, as(acc2), { receiptId: r.id }))).toBe(409);
  });

  it("releases a scheme instalment when its receipt is verified", () => {
    upload([{ date: "2026-10-30", amount: 500000, reference: "UTR-4821" }]);
    const r = recordReceipt(s, as(acc1), { projectId: "p1", from: "Scheme department", purpose: "Instalment 1", amount: 500000, receivedOn: "2026-10-30", reference: "UTR-4821", instalmentNo: 1 });
    expect(code(() => recordReceipt(s, as(acc1), { projectId: "p1", from: "x", purpose: "x", amount: 1, receivedOn: "2026-10-30", reference: null, instalmentNo: 1 }))).toBe(409);
    confirmMatch(s, as(acc1), { lineId: s.bankLines[0].id });
    verifyReceipt(s, as(head), { receiptId: r.id });
    expect(s.ledger[0]).toMatchObject({ kind: "RECEIPT", instalmentNo: 1, bankLineId: s.bankLines[0].id });
  });
});

describe("budgets need an approval", () => {
  it("records a request and changes nothing until another person approves", () => {
    const req = requestBudget(s, as(acc1), { projectId: "p1", category: "TRANSPORT", proposed: 30000, reason: "More trips for batch 2" });
    expect(budgetRows(s, "p1").find((r) => r.category === "TRANSPORT")?.budget).toBe(20000);
    expect(code(() => decideBudget(s, as(acc1), { requestId: req.id, approve: true, note: "" }))).toBe(403);
    expect(code(() => decideBudget(s, as(acc2), { requestId: req.id, approve: true, note: "" }))).toBe(403);
    decideBudget(s, as(head), { requestId: req.id, approve: true, note: "" });
    expect(budgetRows(s, "p1").find((r) => r.category === "TRANSPORT")?.budget).toBe(30000);
  });

  it("flags a request beyond the sanction for Management", () => {
    const req = requestBudget(s, as(acc1), { projectId: "p1", category: "FABRICATOR", proposed: 990000, reason: "Two more sheds" });
    expect(req.exceedsSanction).toBe(true);
    expect(code(() => decideBudget(s, as(head), { requestId: req.id, approve: true, note: "" }))).toBe(403);
    decideBudget(s, as(mgmt), { requestId: req.id, approve: true, note: "" });
    expect(s.budgets.find((b) => b.category === "FABRICATOR")?.amount).toBe(990000);
  });

  it("will not set a budget below what is already used, nor allow two open requests", () => {
    s.ledger.push({ id: "x", ref: "PM-1", date: "2026-10-01", kind: "PAYMENT", direction: "OUT", amount: 15000, projectId: "p1", category: "TRANSPORT", description: "", accountId: "hdfc", instalmentNo: null, workOrderId: null, source: null, reversesId: null, reversedById: null, bankLineId: null, createdBy: { id: "a", name: "a", at: NOW } });
    expect(code(() => requestBudget(s, as(acc1), { projectId: "p1", category: "TRANSPORT", proposed: 10000, reason: "Cut back" }))).toBe(422);
    requestBudget(s, as(acc1), { projectId: "p1", category: "TRANSPORT", proposed: 25000, reason: "More trips" });
    expect(code(() => requestBudget(s, as(acc2), { projectId: "p1", category: "TRANSPORT", proposed: 26000, reason: "More trips" }))).toBe(409);
    expect(code(() => requestBudget(s, as(viewer), { projectId: "p1", category: "ADMIN_OTHER", proposed: 26000, reason: "More trips" }))).toBe(403);
  });
});

describe("advances and recoveries", () => {
  it("is still to recover = given − adjusted, never below zero", () => {
    const a = requestAdvance(s, as(acc1), { projectId: "p1", givenTo: "Site team", vendorId: null, workOrderId: null, category: "TRANSPORT", purpose: "Travel", amount: 15000, givenOn: "2026-11-01" });
    expect(code(() => adjustAdvance(s, as(acc1), { advanceId: a.id, kind: "EXPENSE_SETTLED", amount: 100, note: "Fuel" }))).toBe(409);
    expect(code(() => decideAdvance(s, as(acc1), { advanceId: a.id, approve: true, note: "" }))).toBe(403);
    decideAdvance(s, as(head), { advanceId: a.id, approve: true, note: "" });
    expect(paidOut(s, FY)).toBe(15000);
    adjustAdvance(s, as(acc1), { advanceId: a.id, kind: "EXPENSE_SETTLED", amount: 9200, note: "Fuel bills" });
    expect(advanceOutstanding(s.advances[0])).toBe(5800);
    expect(s.advances[0].status).toBe("PARTLY_ADJUSTED");
    expect(code(() => adjustAdvance(s, as(acc1), { advanceId: a.id, kind: "CASH_RETURNED", amount: 5800.01, note: "Too much" }))).toBe(422);
    adjustAdvance(s, as(acc2), { advanceId: a.id, kind: "CASH_RETURNED", amount: 5800, note: "Cash returned" });
    expect(s.advances[0].status).toBe("CLEARED");
    expect(paidOut(s, FY)).toBe(9200);
  });

  it("cannot advance more than a work order still owes", () => {
    expect(code(() => requestAdvance(s, as(acc1), { projectId: "p1", givenTo: "Fabricator A", vendorId: "v1", workOrderId: "WO-1", category: "FABRICATOR", purpose: "x", amount: 300001, givenOn: "2026-11-01" }))).toBe(422);
  });
});

describe("vouchers", () => {
  it("draft → submit → approve → post creates a ledger line, and posted ones cannot change", () => {
    const v = createVoucher(s, as(acc1), { type: "PAYMENT", date: "2026-11-02", projectId: "p1", category: "ADMIN_OTHER", fromCategory: null, description: "Office stationery", amount: 2500, related: null, reversesLedgerId: null, bankLineId: null, docs: [] });
    expect(code(() => postVoucher(s, as(head), { voucherId: v.id }))).toBe(409);
    submitVoucher(s, as(acc1), { voucherId: v.id });
    expect(code(() => decideVoucher(s, as(acc1), { voucherId: v.id, approve: true, note: "" }))).toBe(403);
    decideVoucher(s, as(head), { voucherId: v.id, approve: true, note: "" });
    postVoucher(s, as(head), { voucherId: v.id });
    expect(s.vouchers[0].status).toBe("POSTED");
    expect(s.ledger.at(-1)).toMatchObject({ kind: "PAYMENT", amount: 2500, category: "ADMIN_OTHER" });
    expect(code(() => editVoucher(s, as(acc1), { voucherId: v.id, description: "changed", amount: 1 }))).toBe(409);
    expect(code(() => deleteVoucher(s, as(acc1), { voucherId: v.id }))).toBe(409);
  });

  it("corrects a posted entry only with a reversal", () => {
    const v = createVoucher(s, as(acc1), { type: "PAYMENT", date: "2026-11-02", projectId: "p1", category: "ADMIN_OTHER", fromCategory: null, description: "Wrong", amount: 2500, related: null, reversesLedgerId: null, bankLineId: null, docs: [] });
    submitVoucher(s, as(acc1), { voucherId: v.id });
    decideVoucher(s, as(head), { voucherId: v.id, approve: true, note: "" });
    postVoucher(s, as(head), { voucherId: v.id });
    const entryId = s.ledger.at(-1)!.id;
    expect(code(() => createVoucher(s, as(acc1), { type: "REVERSAL", date: "2026-11-03", projectId: "p1", category: null, fromCategory: null, description: "Undo", amount: 2000, related: null, reversesLedgerId: entryId, bankLineId: null, docs: [] }))).toBe(422);
    const r = createVoucher(s, as(acc1), { type: "REVERSAL", date: "2026-11-03", projectId: "p1", category: null, fromCategory: null, description: "Undo the wrong one", amount: 2500, related: null, reversesLedgerId: entryId, bankLineId: null, docs: [] });
    submitVoucher(s, as(acc1), { voucherId: r.id });
    decideVoucher(s, as(head), { voucherId: r.id, approve: true, note: "" });
    postVoucher(s, as(head), { voucherId: r.id });
    expect(paidOut(s, FY)).toBe(0);
    expect(code(() => createVoucher(s, as(acc1), { type: "REVERSAL", date: "2026-11-03", projectId: "p1", category: null, fromCategory: null, description: "Again", amount: 2500, related: null, reversesLedgerId: entryId, bankLineId: null, docs: [] }))).toBe(409);
  });

  it("validates required fields and refuses advance vouchers outside the advance flow", () => {
    const base = { date: "2026-11-02", projectId: "p1", category: null, fromCategory: null, description: "x", amount: 100, related: null, reversesLedgerId: null, bankLineId: null, docs: [] };
    expect(code(() => createVoucher(s, as(acc1), { ...base, type: "PAYMENT", description: "Paper" }))).toBe(422);
    expect(code(() => createVoucher(s, as(acc1), { ...base, type: "JOURNAL", category: "MATERIALS", fromCategory: "MATERIALS", description: "Move" }))).toBe(422);
    expect(code(() => createVoucher(s, as(acc1), { ...base, type: "ADVANCE", category: "TRANSPORT", description: "Travel" }))).toBe(422);
    expect(code(() => createVoucher(s, as(acc1), { ...base, type: "RECEIPT", description: "Interest" }))).toBe(422);
    expect(code(() => createVoucher(s, as(viewer), { ...base, type: "PAYMENT", category: "TRANSPORT", description: "Diesel" }))).toBe(403);
  });
});

describe("reconciliation and month-end close", () => {
  function octoberWithCharge() {
    uploadStatement(s, as(acc1), {
      accountId: "hdfc",
      month: "2026-10",
      fileName: "oct.csv",
      lines: [
        { date: "2026-10-31", description: "Bank charges", reference: "CHG-31", amount: -1180 },
        { date: "2026-10-03", description: "Cash deposit", reference: "DEP-6618", amount: 40000 },
      ],
    });
  }

  it("refuses statement lines outside the month or duplicated", () => {
    const res = uploadStatement(s, as(acc1), {
      accountId: "hdfc",
      month: "2026-10",
      fileName: "oct.csv",
      lines: [{ date: "2026-10-31", description: "Charges", reference: "C1", amount: -10 }],
    });
    expect(res).toMatchObject({ added: 1, skipped: 0 });
    expect(uploadStatement(s, as(acc1), { accountId: "hdfc", month: "2026-10", fileName: "again.csv", lines: [{ date: "2026-10-31", description: "Charges", reference: "C1", amount: -10 }] })).toMatchObject({ added: 0, skipped: 1 });
    expect(code(() => uploadStatement(s, as(acc1), { accountId: "hdfc", month: "2026-10", fileName: "x.csv", lines: [{ date: "2026-11-01", description: "x", reference: "x", amount: 5 }] }))).toBe(422);
    expect(code(() => uploadStatement(s, as(acc1), { accountId: "hdfc", month: "2026-10", fileName: "x.csv", lines: [{ date: "2026-10-02", description: "x", reference: "x", amount: 0 }] }))).toBe(422);
  });

  it("clears a bank charge through a voucher, explains the unknown deposit, then signs off and locks", () => {
    octoberWithCharge();
    const charge = s.bankLines.find((l) => l.amount < 0)!;
    const deposit = s.bankLines.find((l) => l.amount > 0)!;
    classifyLine(s, as(acc1), { lineId: charge.id, classification: "BANK_CHARGE" });
    const v = createVoucher(s, as(acc1), { type: "PAYMENT", date: "2026-10-31", projectId: "p1", category: "ADMIN_OTHER", fromCategory: null, description: "October bank charges", amount: 1180, related: null, reversesLedgerId: null, bankLineId: charge.id, docs: [] });
    submitVoucher(s, as(acc1), { voucherId: v.id });
    decideVoucher(s, as(head), { voucherId: v.id, approve: true, note: "" });
    postVoucher(s, as(head), { voucherId: v.id });
    expect(charge.ledgerId).not.toBeNull();
    expect(s.ledger.at(-1)?.kind).toBe("BANK_CHARGE");
    expect(code(() => lockMonth(s, as(head), { accountId: "hdfc", month: "2026-10" }))).toBe(409);
    expect(code(() => explainLine(s, as(acc1), { lineId: deposit.id, note: "short" }))).toBe(422);
    explainLine(s, as(acc1), { lineId: deposit.id, note: "Sender unknown; receipt RC-0214 returned, chase next month" });
    expect(closeChecklist(s, "hdfc", "2026-10").canSignOff).toBe(true);
    expect(code(() => signOff(s, as(acc1), { accountId: "hdfc", month: "2026-10" }))).toBe(403);
    expect(code(() => signOff(s, as(head), { accountId: "hdfc", month: "2026-10" }))).toBe(0);
    lockMonth(s, as(head2), { accountId: "hdfc", month: "2026-10" });
    expect(closeChecklist(s, "hdfc", "2026-10").locked).toBe(true);
  });

  it("freezes a locked month and lets only Management reopen it with a reason", () => {
    s.closes.push({ month: "2026-10", signedOffBy: { id: "head", name: "head", at: NOW }, lockedBy: { id: "head", name: "head", at: NOW }, reopened: [] });
    expect(code(() => createVoucher(s, as(acc1), { type: "PAYMENT", date: "2026-10-20", projectId: "p1", category: "ADMIN_OTHER", fromCategory: null, description: "Backdated", amount: 10, related: null, reversesLedgerId: null, bankLineId: null, docs: [] }))).toBe(409);
    expect(code(() => uploadStatement(s, as(acc1), { accountId: "hdfc", month: "2026-10", fileName: "x.csv", lines: [{ date: "2026-10-02", description: "x", reference: "x", amount: 5 }] }))).toBe(409);
    expect(code(() => reopenMonth(s, as(head), { month: "2026-10", reason: "Found a missing bank charge" }))).toBe(403);
    expect(code(() => reopenMonth(s, as(mgmt), { month: "2026-10", reason: "short" }))).toBe(422);
    reopenMonth(s, as(mgmt), { month: "2026-10", reason: "Found a missing bank charge" });
    expect(s.closes[0]).toMatchObject({ lockedBy: null, signedOffBy: null });
    expect(s.closes[0].reopened).toHaveLength(1);
  });

  it("matches one line to one entry only, and undoing a match needs the Finance Head", () => {
    uploadStatement(s, as(acc1), { accountId: "hdfc", month: "2026-10", fileName: "o.csv", lines: [{ date: "2026-10-20", description: "NEFT", reference: "N1", amount: -2500 }, { date: "2026-10-21", description: "NEFT", reference: "N2", amount: -2500 }] });
    const v = createVoucher(s, as(acc1), { type: "PAYMENT", date: "2026-10-20", projectId: "p1", category: "ADMIN_OTHER", fromCategory: null, description: "Stationery", amount: 2500, related: null, reversesLedgerId: null, bankLineId: null, docs: [] });
    submitVoucher(s, as(acc1), { voucherId: v.id });
    decideVoucher(s, as(head), { voucherId: v.id, approve: true, note: "" });
    postVoucher(s, as(head), { voucherId: v.id });
    const entry = s.ledger.at(-1)!;
    const [l1, l2] = s.bankLines;
    linkLine(s, as(acc1), { lineId: l1.id, targetType: "LEDGER", targetId: entry.id });
    expect(code(() => linkLine(s, as(acc1), { lineId: l2.id, targetType: "LEDGER", targetId: entry.id }))).toBe(409);
    expect(code(() => unmatchLine(s, as(acc1), { lineId: l1.id, reason: "Wrong line" }))).toBe(403);
    unmatchLine(s, as(head), { lineId: l1.id, reason: "Wrong line, belongs to N2" });
    expect(entry.bankLineId).toBeNull();
    linkLine(s, as(acc1), { lineId: l2.id, targetType: "LEDGER", targetId: entry.id });
    expect(reconciliation(s, "hdfc", "2026-10").counts.matched).toBe(1);
  });
});
