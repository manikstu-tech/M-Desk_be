import { ApiError } from "./validation";
import {
  advanceOutstanding,
  advanceStatusFor,
  billAmount,
  billPayable,
  budgetRows,
  closeChecklist,
  isLocked,
  missingForApproval,
  reconciliation,
  wouldExceedBudget,
  workOrderOutstanding,
} from "./finance-calc";
import { formatINR, isValidAmount, istDate, monthKey, monthLabel, roundRupee } from "./finance-format";
import {
  BILL_TYPES,
  CATEGORIES,
  categoryLabel,
  VOUCHER_TYPES,
  type Actor,
  type Advance,
  type BankLine,
  type Bill,
  type BillType,
  type BudgetRequest,
  type Category,
  type DocKind,
  type FinanceState,
  type HistoryEntry,
  type LedgerEntry,
  type Receipt,
  type Stamp,
  type Voucher,
  type VoucherType,
} from "./finance-types";

// Finance workflow rules. Each function checks who may act, validates the input, then
// changes the state it is given; it throws ApiError (403 who, 404 what, 409 when, 422 how)
// and changes nothing in that case that the caller keeps (the repository applies rules to a
// copy and only swaps it in on success). No clock and no I/O: callers pass ctx.now.

export type Ctx = { actor: Actor; now: string };
export type Result = { target: string; text: string };

export function emptyState(): FinanceState {
  return {
    projects: [],
    vendors: [],
    accounts: [],
    workOrders: [],
    bills: [],
    receipts: [],
    instalments: [],
    budgets: [],
    budgetRequests: [],
    advances: [],
    ledger: [],
    vouchers: [],
    bankLines: [],
    uploads: [],
    closes: [],
    audit: [],
    seq: {},
  };
}

// ---------- who may do what ----------

export const can = {
  view: () => true,
  record: (a: Actor) => a.isSuper || a.role === "ACCOUNTANT" || a.role === "FINANCE_HEAD" || a.role === "FIELD",
  prepare: (a: Actor) => a.isSuper || a.role === "ACCOUNTANT" || a.role === "FINANCE_HEAD",
  approve: (a: Actor) => a.isSuper || a.role === "FINANCE_HEAD",
  manage: (a: Actor) => a.isSuper || a.role === "MANAGEMENT",
};

function need(ok: boolean, message: string) {
  if (!ok) throw new ApiError(403, "FORBIDDEN", message);
}
function bad(message: string): never {
  throw new ApiError(422, "VALIDATION", message);
}
function conflict(message: string): never {
  throw new ApiError(409, "CONFLICT", message);
}
function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} not found`);
}

// ---------- small helpers ----------

function stamp(ctx: Ctx): Stamp {
  return { id: ctx.actor.id, name: ctx.actor.name, at: ctx.now };
}

function nextId(s: FinanceState, prefix: string): string {
  const n = (s.seq[prefix] ?? 0) + 1;
  s.seq[prefix] = n;
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

function note(ctx: Ctx, history: HistoryEntry[], text: string) {
  history.push({ at: ctx.now, actorId: ctx.actor.id, actorName: ctx.actor.name, text });
}

function audit(s: FinanceState, ctx: Ctx, action: string, target: string, text: string): Result {
  s.audit.push({ at: ctx.now, actorId: ctx.actor.id, actorName: ctx.actor.name, action, target, text });
  return { target, text };
}

function text(v: string | null | undefined, min: number, max: number, field: string): string {
  const t = (v ?? "").trim();
  if (t.length < min) bad(min <= 1 ? `${field} is required` : `${field} needs at least ${min} characters`);
  if (t.length > max) bad(`${field} is too long (max ${max} characters)`);
  return t;
}

function amount(n: number, field = "Amount"): number {
  if (!isValidAmount(n)) bad(`${field} must be a positive rupee amount with at most 2 decimals`);
  return roundRupee(n);
}

function isoDate(d: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00.000Z`))) bad(`${field} must be a date (YYYY-MM-DD)`);
  return d;
}

function notFuture(ctx: Ctx, d: string, field: string) {
  if (d > istDate(ctx.now)) bad(`${field} cannot be in the future`);
}

function openMonth(s: FinanceState, date: string) {
  const m = monthKey(date);
  if (isLocked(s, m)) conflict(`${monthLabel(m)} is locked — post the correction in an open month, or ask Management to reopen it`);
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

function find<T extends { id: string }>(rows: T[], id: string, what: string): T {
  return rows.find((r) => r.id === id) ?? notFound(what);
}

function project(s: FinanceState, id: string) {
  return find(s.projects, id, "Project");
}

function category(c: string | null | undefined, field = "Category"): Category {
  const hit = CATEGORIES.find((x) => x.key === c);
  if (!hit) bad(`${field} is required`);
  return hit.key;
}

function latestReleasedNo(s: FinanceState, projectId: string): number | null {
  const nos = s.instalments
    .filter((i) => i.projectId === projectId && i.receiptId && s.receipts.find((r) => r.id === i.receiptId)?.status === "VERIFIED")
    .map((i) => i.no);
  return nos.length ? Math.max(...nos) : null;
}

function defaultAccount(s: FinanceState): string {
  return s.accounts[0]?.id ?? notFound("Bank account");
}

type NewEntry = Omit<LedgerEntry, "id" | "ref" | "createdBy" | "reversedById" | "bankLineId"> & { ref?: string };

function post(s: FinanceState, ctx: Ctx, e: NewEntry, prefix: string): LedgerEntry {
  openMonth(s, e.date);
  const id = nextId(s, `LE`);
  const entry: LedgerEntry = { ...e, id, ref: e.ref ?? nextId(s, prefix), createdBy: stamp(ctx), reversedById: null, bankLineId: null };
  s.ledger.push(entry);
  return entry;
}

function lineOpen(l: BankLine): boolean {
  return !l.ledgerId && !l.receiptId && !l.explanation;
}

function matchLine(ctx: Ctx, line: BankLine, entry: LedgerEntry) {
  const signedAmt = entry.direction === "IN" ? entry.amount : -entry.amount;
  if (line.ledgerId || entry.bankLineId) conflict("That bank line or book entry is already matched — one line matches one entry");
  if (line.accountId !== entry.accountId) bad("The entry is on a different bank account");
  if (roundRupee(signedAmt) !== roundRupee(line.amount)) bad(`Amounts differ: bank ${formatINR(line.amount)}, books ${formatINR(signedAmt)}`);
  line.ledgerId = entry.id;
  line.matchedBy = stamp(ctx);
  entry.bankLineId = line.id;
}

// ---------- bills ----------

export type CreateBillInput = {
  projectId: string;
  vendorId: string;
  type: BillType;
  category: Category;
  workOrderId: string | null;
  shed?: string | null;
  amount: number;
  billDate: string;
  dueDate: string;
};

export function createBill(s: FinanceState, ctx: Ctx, i: CreateBillInput): Bill {
  need(can.prepare(ctx.actor), "Only Finance can enter bills");
  project(s, i.projectId);
  find(s.vendors, i.vendorId, "Vendor");
  if (!BILL_TYPES.some((t) => t.key === i.type)) bad("Bill type is required");
  const cat = category(i.category);
  const amt = amount(i.amount);
  const billDate = isoDate(i.billDate, "Bill date");
  const dueDate = isoDate(i.dueDate, "Due date");
  notFuture(ctx, billDate, "Bill date");
  if (dueDate < billDate) bad("Due date cannot be before the bill date");
  let shed = i.shed?.trim() || null;
  let advanceId: string | null = null;
  let advanceDeduction = 0;
  if (i.workOrderId) {
    const wo = find(s.workOrders, i.workOrderId, "Work order");
    if (wo.projectId !== i.projectId || wo.vendorId !== i.vendorId) bad("That work order belongs to another project or payee");
    shed = shed ?? wo.shed;
    const adv = s.advances.find((a) => a.workOrderId === wo.id && (a.status === "OPEN" || a.status === "PARTLY_ADJUSTED"));
    if (adv) {
      advanceId = adv.id;
      advanceDeduction = Math.min(advanceOutstanding(adv), amt);
    }
  }
  const dup = s.bills.find((b) => b.status !== "REJECTED" && b.vendorId === i.vendorId && b.submittedAmount === amt && b.billDate === billDate);
  if (dup) conflict(`This looks like a duplicate of ${dup.id} (same payee, amount and date)`);
  const bill: Bill = {
    id: nextId(s, "BL"),
    projectId: i.projectId,
    vendorId: i.vendorId,
    type: i.type,
    category: cat,
    workOrderId: i.workOrderId,
    shed,
    submittedAmount: amt,
    finalAmount: null,
    amountReason: null,
    amountEditedBy: null,
    advanceId,
    advanceDeduction,
    workAccepted: false,
    billDate,
    dueDate,
    status: "DRAFT",
    createdBy: stamp(ctx),
    submittedBy: null,
    checkedBy: null,
    approvedBy: null,
    paidBy: null,
    payment: null,
    rejectedReason: null,
    overBudget: false,
    docs: [],
    history: [],
  };
  note(ctx, bill.history, `${ctx.actor.name} entered the bill for ${formatINR(amt)}`);
  s.bills.push(bill);
  audit(s, ctx, "BILL_CREATED", bill.id, `Bill ${bill.id} entered`);
  return bill;
}

export function submitBill(s: FinanceState, ctx: Ctx, i: { billId: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can submit bills");
  const b = find(s.bills, i.billId, "Bill");
  if (b.status !== "DRAFT") conflict("Only a draft bill can be submitted");
  b.status = "WITH_ACCOUNTANT";
  b.submittedBy = stamp(ctx);
  note(ctx, b.history, `${ctx.actor.name} submitted the bill`);
  return audit(s, ctx, "BILL_SUBMITTED", b.id, `Bill ${b.id} submitted for checking`);
}

const DOC_KINDS: DocKind[] = ["INVOICE", "COMPLETION_PROOF", "WORK_ORDER", "OTHER"];

export function attachDoc(s: FinanceState, ctx: Ctx, i: { billId: string; kind: DocKind; title: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can attach documents");
  const b = find(s.bills, i.billId, "Bill");
  if (b.status === "PAID" || b.status === "REJECTED") conflict("This bill is closed");
  if (!DOC_KINDS.includes(i.kind)) bad("Document type is required");
  const title = text(i.title, 3, 120, "Document name");
  b.docs.push({ id: nextId(s, "DOC"), kind: i.kind, title, source: "Attached in Finance (demo metadata)", addedBy: ctx.actor.name, addedAt: ctx.now });
  note(ctx, b.history, `${ctx.actor.name} attached "${title}"`);
  return audit(s, ctx, "BILL_DOC_ATTACHED", b.id, `Document attached to ${b.id}`);
}

/** New spend this bill adds beyond what its work order already commits. */
function billNewUsage(s: FinanceState, b: Bill): number {
  if (b.workOrderId) return Math.max(0, roundRupee(billAmount(b) - workOrderOutstanding(s, b.workOrderId)));
  return billPayable(b);
}

/** "Approve and forward": the Accountant's check, then the Finance Head's approval. */
export function approveBill(s: FinanceState, ctx: Ctx, i: { billId: string }): Result {
  need(can.prepare(ctx.actor), "You cannot approve bills");
  const b = find(s.bills, i.billId, "Bill");
  const me = ctx.actor.id;
  if (b.status === "WITH_ACCOUNTANT") {
    need(b.submittedBy?.id !== me && b.createdBy.id !== me, "A different person must check a bill you entered or submitted");
    const missing = missingForApproval(s, b);
    if (missing.length) conflict(`Cannot forward yet: ${missing.join("; ")}`);
    b.overBudget = wouldExceedBudget(s, b.projectId, b.category, billNewUsage(s, b));
    b.status = "WITH_FINANCE_HEAD";
    b.checkedBy = stamp(ctx);
    note(ctx, b.history, `${ctx.actor.name} checked the bill against the work order and inspection${b.overBudget ? " — flagged over budget for Management" : ""}`);
    return audit(s, ctx, "BILL_CHECKED", b.id, `Bill ${b.id} checked and forwarded`);
  }
  if (b.status === "WITH_FINANCE_HEAD") {
    need(can.approve(ctx.actor), "Only the Finance Head can approve a checked bill");
    need(b.submittedBy?.id !== me && b.createdBy.id !== me && b.checkedBy?.id !== me, "Approval needs a person who did not enter or check this bill");
    need(b.amountEditedBy?.id !== me, "You changed the amount, so a different person must approve it");
    const missing = missingForApproval(s, b);
    if (missing.length) conflict(`Cannot approve: ${missing.join("; ")}`);
    b.overBudget = wouldExceedBudget(s, b.projectId, b.category, billNewUsage(s, b));
    if (b.overBudget && !can.manage(ctx.actor)) conflict(`This bill would push ${categoryLabel(b.category)} over its budget — Management must approve it`);
    b.status = "APPROVED";
    b.approvedBy = stamp(ctx);
    note(ctx, b.history, `${ctx.actor.name} approved the bill${b.overBudget ? " (over budget, Management approval)" : ""}`);
    return audit(s, ctx, "BILL_APPROVED", b.id, `Bill ${b.id} approved`);
  }
  conflict(`A bill that is ${b.status.toLowerCase().replace(/_/g, " ")} cannot be approved`);
}

export function editAmount(s: FinanceState, ctx: Ctx, i: { billId: string; amount: number; reason: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can change a bill amount");
  const b = find(s.bills, i.billId, "Bill");
  if (!["DRAFT", "WITH_ACCOUNTANT", "WITH_FINANCE_HEAD"].includes(b.status)) conflict("The amount can only change before the bill is approved");
  const reason = text(i.reason, 5, 300, "Reason for the change");
  const amt = amount(i.amount, "Final amount");
  const before = billAmount(b);
  if (amt === before) bad("The new amount is the same as the current one");
  if (amt < b.advanceDeduction) bad(`The final amount cannot be below the advance already paid (${formatINR(b.advanceDeduction)})`);
  b.finalAmount = amt;
  b.amountReason = reason;
  b.amountEditedBy = stamp(ctx);
  note(ctx, b.history, `${ctx.actor.name} changed the final amount from ${formatINR(before)} to ${formatINR(amt)} (${reason})`);
  return audit(s, ctx, "BILL_AMOUNT_CHANGED", b.id, `Final amount of ${b.id} changed from ${formatINR(before)} to ${formatINR(amt)}`);
}

export function rejectBill(s: FinanceState, ctx: Ctx, i: { billId: string; reason: string }): Result {
  const b = find(s.bills, i.billId, "Bill");
  if (b.status === "WITH_FINANCE_HEAD") need(can.approve(ctx.actor), "Only the Finance Head can reject a checked bill");
  else need(can.prepare(ctx.actor), "Only Finance can reject bills");
  if (!["DRAFT", "WITH_ACCOUNTANT", "WITH_FINANCE_HEAD"].includes(b.status)) conflict("Only a bill still under review can be rejected");
  const reason = text(i.reason, 5, 300, "Reason");
  b.status = "REJECTED";
  b.rejectedReason = reason;
  note(ctx, b.history, `${ctx.actor.name} rejected the bill: ${reason}`);
  return audit(s, ctx, "BILL_REJECTED", b.id, `Bill ${b.id} rejected`);
}

export function markPaid(s: FinanceState, ctx: Ctx, i: { billId: string; date: string; reference: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can record payments");
  const b = find(s.bills, i.billId, "Bill");
  if (b.status !== "APPROVED") conflict("A bill can be paid only after it has been checked and approved");
  const date = isoDate(i.date, "Payment date");
  notFuture(ctx, date, "Payment date");
  if (b.approvedBy && date < istDate(b.approvedBy.at)) bad("Payment date cannot be before the approval");
  const reference = text(i.reference, 3, 40, "Bank reference");
  if (!/^[A-Za-z0-9/\- ]+$/.test(reference)) bad("Bank reference may only contain letters, digits, spaces, - and /");
  const dup = s.bills.find((x) => x.payment && sameText(x.payment.reference, reference));
  if (dup) conflict(`Reference ${reference} is already used for ${dup.id}`);
  const wo = b.workOrderId ? s.workOrders.find((w) => w.id === b.workOrderId) : undefined;
  const instalmentNo = wo?.instalmentNo ?? latestReleasedNo(s, b.projectId);
  if (b.advanceId && b.advanceDeduction > 0) {
    const adv = find(s.advances, b.advanceId, "Advance");
    if (b.advanceDeduction > advanceOutstanding(adv)) conflict(`Advance ${adv.id} has only ${formatINR(advanceOutstanding(adv))} left to adjust`);
  }
  const payable = billPayable(b);
  let ledgerId = "";
  if (payable > 0) {
    const vendor = s.vendors.find((v) => v.id === b.vendorId)?.name ?? "payee";
    const e = post(
      s,
      ctx,
      {
        date,
        kind: "PAYMENT",
        direction: "OUT",
        amount: payable,
        projectId: b.projectId,
        category: b.category,
        description: `${vendor}, ${b.id}`,
        accountId: defaultAccount(s),
        instalmentNo,
        workOrderId: b.workOrderId,
        source: { type: "BILL", id: b.id },
        reversesId: null,
      },
      "PM",
    );
    ledgerId = e.id;
  } else openMonth(s, date);
  if (b.advanceId && b.advanceDeduction > 0) {
    const adv = find(s.advances, b.advanceId, "Advance");
    adv.adjustments.push({ id: nextId(s, "ADJ"), kind: "AGAINST_BILL", amount: b.advanceDeduction, note: `Adjusted against ${b.id}`, billId: b.id, ledgerId: null, by: stamp(ctx) });
    adv.status = advanceStatusFor(adv);
    note(ctx, adv.history, `${ctx.actor.name} adjusted ${formatINR(b.advanceDeduction)} against ${b.id}`);
  }
  b.status = "PAID";
  b.paidBy = stamp(ctx);
  b.payment = { date, reference, ledgerId };
  note(ctx, b.history, `${ctx.actor.name} recorded payment of ${formatINR(payable)} on ${date} (ref ${reference})`);
  return audit(s, ctx, "BILL_PAID", b.id, `Bill ${b.id} paid, ${formatINR(payable)}`);
}

// ---------- receipts ----------

export type RecordReceiptInput = {
  projectId: string;
  from: string;
  purpose: string;
  amount: number;
  receivedOn: string;
  reference: string | null;
  instalmentNo: number | null;
};

export function recordReceipt(s: FinanceState, ctx: Ctx, i: RecordReceiptInput): Receipt {
  need(can.record(ctx.actor), "You cannot record receipts");
  project(s, i.projectId);
  const from = text(i.from, 1, 120, "Received from");
  const purpose = text(i.purpose, 1, 160, "Purpose");
  const amt = amount(i.amount);
  const receivedOn = isoDate(i.receivedOn, "Date received");
  notFuture(ctx, receivedOn, "Date received");
  const reference = i.reference?.trim() ? text(i.reference, 3, 40, "Reference") : null;
  if (reference) {
    const dup = s.receipts.find((r) => r.status !== "RETURNED" && sameText(r.reference, reference));
    if (dup) conflict(`Reference ${reference} is already used on ${dup.id}`);
  }
  let instalmentNo: number | null = null;
  if (i.instalmentNo !== null && i.instalmentNo !== undefined) {
    const inst = s.instalments.find((x) => x.projectId === i.projectId && x.no === i.instalmentNo) ?? notFound("Instalment");
    if (inst.receiptId) conflict(`Instalment ${inst.no} already has receipt ${inst.receiptId}`);
    instalmentNo = inst.no;
  }
  const r: Receipt = {
    id: nextId(s, "RC"),
    projectId: i.projectId,
    from,
    purpose,
    amount: amt,
    receivedOn,
    reference,
    instalmentNo,
    enteredBy: stamp(ctx),
    bankLineId: null,
    linkedBy: null,
    verifiedBy: null,
    returnedReason: null,
    ledgerId: null,
    status: "CLAIMED",
    history: [],
  };
  if (instalmentNo !== null) {
    const inst = s.instalments.find((x) => x.projectId === i.projectId && x.no === instalmentNo);
    if (inst) inst.receiptId = r.id;
  }
  note(ctx, r.history, `${ctx.actor.name} recorded ${formatINR(amt)} from ${from} as claimed`);
  s.receipts.push(r);
  audit(s, ctx, "RECEIPT_RECORDED", r.id, `Receipt ${r.id} recorded (claimed)`);
  return r;
}

export function linkReceipt(s: FinanceState, ctx: Ctx, i: { receiptId: string; bankLineId: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can match receipts to the bank");
  const r = find(s.receipts, i.receiptId, "Receipt");
  const line = find(s.bankLines, i.bankLineId, "Bank line");
  if (r.status !== "CLAIMED") conflict("Only a claimed receipt can be matched");
  if (r.bankLineId) conflict(`${r.id} is already matched to a bank line`);
  if (!lineOpen(line) || line.classification !== "NONE") conflict("That bank line is already matched, explained or marked");
  if (line.amount <= 0) bad("A receipt can only match a credit (money in)");
  if (roundRupee(line.amount) !== r.amount) bad(`Amounts differ: bank ${formatINR(line.amount)}, receipt ${formatINR(r.amount)}`);
  if (isLocked(s, line.month)) conflict(`${monthLabel(line.month)} is locked`);
  r.bankLineId = line.id;
  r.linkedBy = stamp(ctx);
  line.receiptId = r.id;
  note(ctx, r.history, `${ctx.actor.name} matched it to bank line ${line.reference} (${line.date})`);
  return audit(s, ctx, "RECEIPT_LINKED", r.id, `Receipt ${r.id} matched to bank line ${line.reference}`);
}

export function verifyReceipt(s: FinanceState, ctx: Ctx, i: { receiptId: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can verify receipts");
  const r = find(s.receipts, i.receiptId, "Receipt");
  if (r.status !== "CLAIMED") conflict("Only a claimed receipt can be verified");
  need(r.enteredBy.id !== ctx.actor.id, "The person who entered a receipt cannot verify it — a second person must");
  if (!r.bankLineId) conflict("Match the receipt to a bank credit line before verifying it");
  const line = find(s.bankLines, r.bankLineId, "Bank line");
  const e = post(
    s,
    ctx,
    {
      ref: r.id,
      date: line.date,
      kind: "RECEIPT",
      direction: "IN",
      amount: r.amount,
      projectId: r.projectId,
      category: null,
      description: `${r.from} — ${r.purpose}`,
      accountId: line.accountId,
      instalmentNo: r.instalmentNo,
      workOrderId: null,
      source: { type: "RECEIPT", id: r.id },
      reversesId: null,
    },
    "RC",
  );
  e.bankLineId = line.id;
  line.ledgerId = e.id;
  line.matchedBy = stamp(ctx);
  r.status = "VERIFIED";
  r.verifiedBy = stamp(ctx);
  r.ledgerId = e.id;
  note(ctx, r.history, `${ctx.actor.name} verified it against the bank line`);
  return audit(s, ctx, "RECEIPT_VERIFIED", r.id, `Receipt ${r.id} verified, ${formatINR(r.amount)}`);
}

export function returnReceipt(s: FinanceState, ctx: Ctx, i: { receiptId: string; reason: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can return receipts");
  const r = find(s.receipts, i.receiptId, "Receipt");
  if (r.status !== "CLAIMED") conflict("Only a claimed receipt can be returned");
  const reason = text(i.reason, 5, 300, "Reason");
  if (r.bankLineId) {
    const line = s.bankLines.find((l) => l.id === r.bankLineId);
    if (line && isLocked(s, line.month)) conflict(`${monthLabel(line.month)} is locked`);
    if (line) line.receiptId = null;
    r.bankLineId = null;
  }
  const inst = s.instalments.find((x) => x.receiptId === r.id);
  if (inst) inst.receiptId = null;
  r.status = "RETURNED";
  r.returnedReason = reason;
  note(ctx, r.history, `${ctx.actor.name} returned it: ${reason}`);
  return audit(s, ctx, "RECEIPT_RETURNED", r.id, `Receipt ${r.id} returned`);
}

// ---------- budgets ----------

export function requestBudget(s: FinanceState, ctx: Ctx, i: { projectId: string; category: Category; proposed: number; reason: string }): BudgetRequest {
  need(can.prepare(ctx.actor), "Only Finance can request a budget change");
  const p = project(s, i.projectId);
  const cat = category(i.category);
  const proposed = amount(i.proposed, "Proposed budget");
  const reason = text(i.reason, 5, 300, "Reason");
  const row = budgetRows(s, p.id).find((r) => r.category === cat);
  const used = roundRupee((row?.paid ?? 0) + (row?.committed ?? 0));
  if (proposed < used) bad(`${categoryLabel(cat)} already has ${formatINR(used)} paid or committed — the budget cannot go below that`);
  if (proposed === row?.budget) bad("The proposed budget is the same as the current one");
  if (s.budgetRequests.some((r) => r.projectId === p.id && r.category === cat && r.status === "PENDING")) conflict("There is already a pending change for this category");
  const totalAfter = roundRupee(s.budgets.filter((b) => b.projectId === p.id && b.category !== cat).reduce((n, b) => n + b.amount, 0) + proposed);
  const req: BudgetRequest = {
    id: nextId(s, "BR"),
    projectId: p.id,
    category: cat,
    current: row?.budget ?? 0,
    proposed,
    reason,
    requestedBy: stamp(ctx),
    status: "PENDING",
    exceedsSanction: totalAfter > p.sanctioned,
    decidedBy: null,
    decisionNote: null,
  };
  s.budgetRequests.push(req);
  audit(s, ctx, "BUDGET_CHANGE_REQUESTED", req.id, `${categoryLabel(cat)} budget change requested: ${formatINR(req.current)} → ${formatINR(proposed)}`);
  return req;
}

export function decideBudget(s: FinanceState, ctx: Ctx, i: { requestId: string; approve: boolean; note: string }): Result {
  need(can.approve(ctx.actor) || can.manage(ctx.actor), "Only the Finance Head or Management can decide budget changes");
  const req = find(s.budgetRequests, i.requestId, "Budget request");
  if (req.status !== "PENDING") conflict("This request is already decided");
  need(req.requestedBy.id !== ctx.actor.id, "A different person must decide your own budget request");
  if (!i.approve) {
    req.decisionNote = text(i.note, 5, 300, "Reason");
    req.status = "REJECTED";
    req.decidedBy = stamp(ctx);
    return audit(s, ctx, "BUDGET_CHANGE_REJECTED", req.id, `Budget request ${req.id} rejected`);
  }
  need(!req.exceedsSanction || can.manage(ctx.actor), "This change takes the budget past the scheme sanction — Management must approve it");
  const row = budgetRows(s, req.projectId).find((r) => r.category === req.category);
  if (row && req.proposed < roundRupee(row.paid + row.committed)) conflict("Spend has grown since the request; the proposed budget is now below what is used");
  const line = s.budgets.find((b) => b.projectId === req.projectId && b.category === req.category);
  if (line) line.amount = req.proposed;
  else s.budgets.push({ projectId: req.projectId, category: req.category, amount: req.proposed });
  req.status = "APPROVED";
  req.decidedBy = stamp(ctx);
  req.decisionNote = i.note?.trim() || null;
  return audit(s, ctx, "BUDGET_CHANGE_APPROVED", req.id, `${categoryLabel(req.category)} budget set to ${formatINR(req.proposed)}`);
}

// ---------- advances ----------

export type RequestAdvanceInput = {
  projectId: string;
  givenTo: string;
  vendorId: string | null;
  workOrderId: string | null;
  category: Category;
  purpose: string;
  amount: number;
  givenOn: string;
};

export function requestAdvance(s: FinanceState, ctx: Ctx, i: RequestAdvanceInput): Advance {
  need(can.prepare(ctx.actor), "Only Finance can request advances");
  project(s, i.projectId);
  const givenTo = text(i.givenTo, 2, 120, "Given to");
  const purpose = text(i.purpose, 2, 160, "Purpose");
  const cat = category(i.category);
  const amt = amount(i.amount);
  const givenOn = isoDate(i.givenOn, "Date");
  notFuture(ctx, givenOn, "Date");
  if (i.vendorId) find(s.vendors, i.vendorId, "Vendor");
  if (i.workOrderId) {
    const wo = find(s.workOrders, i.workOrderId, "Work order");
    if (wo.projectId !== i.projectId) bad("That work order belongs to another project");
    if (!wo.approved) conflict("The work order is not approved");
    const left = workOrderOutstanding(s, wo.id);
    if (amt > left) bad(`The work order has only ${formatINR(left)} left to pay`);
  }
  const a: Advance = {
    id: nextId(s, "AD"),
    projectId: i.projectId,
    givenTo,
    vendorId: i.vendorId,
    workOrderId: i.workOrderId,
    category: cat,
    purpose,
    amount: amt,
    givenOn,
    requestedBy: stamp(ctx),
    approvedBy: null,
    ledgerId: null,
    status: "PENDING_APPROVAL",
    adjustments: [],
    history: [],
  };
  note(ctx, a.history, `${ctx.actor.name} requested an advance of ${formatINR(amt)} to ${givenTo}`);
  s.advances.push(a);
  audit(s, ctx, "ADVANCE_REQUESTED", a.id, `Advance ${a.id} requested, ${formatINR(amt)}`);
  return a;
}

export function decideAdvance(s: FinanceState, ctx: Ctx, i: { advanceId: string; approve: boolean; note: string }): Result {
  need(can.approve(ctx.actor), "Only the Finance Head can approve advances");
  const a = find(s.advances, i.advanceId, "Advance");
  if (a.status !== "PENDING_APPROVAL") conflict("This advance is already decided");
  need(a.requestedBy.id !== ctx.actor.id, "A different person must approve an advance you requested");
  if (!i.approve) {
    const reason = text(i.note, 5, 300, "Reason");
    a.status = "REJECTED";
    note(ctx, a.history, `${ctx.actor.name} rejected the advance: ${reason}`);
    return audit(s, ctx, "ADVANCE_REJECTED", a.id, `Advance ${a.id} rejected`);
  }
  if (!a.workOrderId && wouldExceedBudget(s, a.projectId, a.category, a.amount) && !can.manage(ctx.actor)) {
    conflict(`This advance would push ${categoryLabel(a.category)} over its budget — Management must approve it`);
  }
  const wo = a.workOrderId ? s.workOrders.find((w) => w.id === a.workOrderId) : undefined;
  const e = post(
    s,
    ctx,
    {
      ref: a.id,
      date: a.givenOn,
      kind: "ADVANCE",
      direction: "OUT",
      amount: a.amount,
      projectId: a.projectId,
      category: a.category,
      description: `Advance to ${a.givenTo}${a.workOrderId ? ` against ${a.workOrderId}` : ""}`,
      accountId: defaultAccount(s),
      instalmentNo: wo?.instalmentNo ?? latestReleasedNo(s, a.projectId),
      workOrderId: a.workOrderId,
      source: { type: "ADVANCE", id: a.id },
      reversesId: null,
    },
    "AD",
  );
  a.ledgerId = e.id;
  a.approvedBy = stamp(ctx);
  a.status = "OPEN";
  note(ctx, a.history, `${ctx.actor.name} approved and paid the advance`);
  return audit(s, ctx, "ADVANCE_APPROVED", a.id, `Advance ${a.id} approved, ${formatINR(a.amount)}`);
}

export function adjustAdvance(s: FinanceState, ctx: Ctx, i: { advanceId: string; kind: "EXPENSE_SETTLED" | "CASH_RETURNED"; amount: number; note: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can record adjustments");
  const a = find(s.advances, i.advanceId, "Advance");
  if (a.status !== "OPEN" && a.status !== "PARTLY_ADJUSTED") conflict("Only an open advance can be adjusted");
  if (i.kind !== "EXPENSE_SETTLED" && i.kind !== "CASH_RETURNED") bad("Adjustment type is required");
  const amt = amount(i.amount);
  const left = advanceOutstanding(a);
  if (amt > left) bad(`Only ${formatINR(left)} is still to recover`);
  const memo = text(i.note, 3, 200, "Note");
  let ledgerId: string | null = null;
  if (i.kind === "CASH_RETURNED") {
    const e = post(
      s,
      ctx,
      {
        date: istDate(ctx.now),
        kind: "RECOVERY",
        direction: "IN",
        amount: amt,
        projectId: a.projectId,
        category: a.category,
        description: `Cash returned against ${a.id}`,
        accountId: defaultAccount(s),
        instalmentNo: s.ledger.find((x) => x.id === a.ledgerId)?.instalmentNo ?? null,
        workOrderId: a.workOrderId,
        source: { type: "ADVANCE", id: a.id },
        reversesId: null,
      },
      "RY",
    );
    ledgerId = e.id;
  } else openMonth(s, istDate(ctx.now));
  a.adjustments.push({ id: nextId(s, "ADJ"), kind: i.kind, amount: amt, note: memo, billId: null, ledgerId, by: stamp(ctx) });
  a.status = advanceStatusFor(a);
  note(ctx, a.history, `${ctx.actor.name} recorded ${i.kind === "CASH_RETURNED" ? "cash returned" : "expenses settled"} of ${formatINR(amt)} (${memo})`);
  return audit(s, ctx, "ADVANCE_ADJUSTED", a.id, `Advance ${a.id} adjusted by ${formatINR(amt)}`);
}

// ---------- vouchers ----------

export type CreateVoucherInput = {
  type: VoucherType;
  date: string;
  projectId: string;
  category: Category | null;
  fromCategory: Category | null;
  description: string;
  amount: number;
  related: string | null;
  reversesLedgerId: string | null;
  bankLineId: string | null;
  docs: { title: string; note: string }[];
};

export function createVoucher(s: FinanceState, ctx: Ctx, i: CreateVoucherInput): Voucher {
  need(can.prepare(ctx.actor), "Only Finance can create vouchers");
  const meta = VOUCHER_TYPES.find((t) => t.key === i.type) ?? bad("Voucher type is required");
  if (i.type === "ADVANCE") bad("Advances are raised under Receipts, Funds & Budgets → Advances, so the advance and its recovery stay together");
  const date = isoDate(i.date, "Voucher date");
  notFuture(ctx, date, "Voucher date");
  openMonth(s, date);
  let projectId = project(s, i.projectId).id;
  const description = text(i.description, 3, 200, "Description");
  let amt = amount(i.amount);
  let cat: Category | null = null;
  let fromCat: Category | null = null;
  let reversesLedgerId: string | null = null;
  if (i.type === "PAYMENT") cat = category(i.category);
  if (i.type === "JOURNAL") {
    cat = category(i.category, "Move to category");
    fromCat = category(i.fromCategory, "Move from category");
    if (cat === fromCat) bad("A journal must move the amount between two different categories");
  }
  if (i.type === "REVERSAL") {
    const orig = s.ledger.find((e) => e.id === i.reversesLedgerId) ?? bad("Choose the posted entry to reverse");
    if (orig.kind === "REVERSAL") bad("A reversal cannot itself be reversed — post a new entry instead");
    if (orig.reversedById) conflict(`${orig.ref} is already reversed`);
    if (s.vouchers.some((v) => v.reversesLedgerId === orig.id && v.status !== "REJECTED")) conflict(`A reversal of ${orig.ref} is already in progress`);
    if (amt !== orig.amount) bad(`A reversal must be for the full ${formatINR(orig.amount)} of ${orig.ref}`);
    reversesLedgerId = orig.id;
    projectId = orig.projectId;
    cat = orig.category;
    amt = orig.amount;
  }
  let bankLineId: string | null = null;
  if (i.bankLineId) {
    const line = find(s.bankLines, i.bankLineId, "Bank line");
    if (!lineOpen(line)) conflict("That bank line is already matched or explained");
    const want = i.type === "RECEIPT" ? amt : -amt;
    if (i.type !== "RECEIPT" && i.type !== "PAYMENT") bad("Only payment and receipt vouchers can clear a bank line");
    if (roundRupee(line.amount) !== want) bad(`Amounts differ: bank ${formatINR(line.amount)}, voucher ${formatINR(want)}`);
    bankLineId = line.id;
  }
  if (i.type === "RECEIPT" && !bankLineId) bad("A receipt voucher must clear a bank credit line — money in is counted only once the bank shows it");
  const docs = (i.docs ?? []).slice(0, 5).map((d) => ({ title: text(d.title, 3, 120, "Document name"), note: (d.note ?? "").trim().slice(0, 200) }));
  const v: Voucher = {
    id: nextId(s, meta.prefix),
    type: i.type,
    date,
    projectId,
    category: cat,
    fromCategory: fromCat,
    description,
    amount: amt,
    related: i.related?.trim().slice(0, 40) || null,
    reversesLedgerId,
    bankLineId,
    docs,
    status: "DRAFT",
    createdBy: stamp(ctx),
    approvedBy: null,
    postedBy: null,
    rejectedReason: null,
    ledgerIds: [],
    overBudget: false,
    history: [],
  };
  note(ctx, v.history, `${ctx.actor.name} drafted the voucher for ${formatINR(amt)}`);
  s.vouchers.push(v);
  audit(s, ctx, "VOUCHER_CREATED", v.id, `${meta.label} ${v.id} drafted`);
  return v;
}

export function editVoucher(s: FinanceState, ctx: Ctx, i: { voucherId: string; description: string; amount: number }): Result {
  need(can.prepare(ctx.actor), "Only Finance can edit vouchers");
  const v = find(s.vouchers, i.voucherId, "Voucher");
  if (v.status !== "DRAFT") conflict("Only a draft can be edited — a posted voucher is corrected with a reversal");
  need(v.createdBy.id === ctx.actor.id, "Only the person who drafted it can edit it");
  if (v.type === "REVERSAL") bad("A reversal always carries the full amount of the entry it reverses");
  v.description = text(i.description, 3, 200, "Description");
  v.amount = amount(i.amount);
  note(ctx, v.history, `${ctx.actor.name} edited the draft`);
  return audit(s, ctx, "VOUCHER_EDITED", v.id, `Draft ${v.id} edited`);
}

export function deleteVoucher(s: FinanceState, ctx: Ctx, i: { voucherId: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can discard vouchers");
  const v = find(s.vouchers, i.voucherId, "Voucher");
  if (v.status !== "DRAFT") conflict("Only a draft can be discarded — a posted voucher is corrected with a reversal");
  need(v.createdBy.id === ctx.actor.id, "Only the person who drafted it can discard it");
  s.vouchers = s.vouchers.filter((x) => x.id !== v.id);
  return audit(s, ctx, "VOUCHER_DISCARDED", v.id, `Draft ${v.id} discarded`);
}

export function submitVoucher(s: FinanceState, ctx: Ctx, i: { voucherId: string }): Result {
  need(can.prepare(ctx.actor), "Only Finance can submit vouchers");
  const v = find(s.vouchers, i.voucherId, "Voucher");
  if (v.status !== "DRAFT") conflict("Only a draft can be submitted");
  v.status = "SUBMITTED";
  note(ctx, v.history, `${ctx.actor.name} submitted it for review`);
  return audit(s, ctx, "VOUCHER_SUBMITTED", v.id, `Voucher ${v.id} submitted`);
}

export function decideVoucher(s: FinanceState, ctx: Ctx, i: { voucherId: string; approve: boolean; note: string }): Result {
  need(can.approve(ctx.actor), "Only the Finance Head can approve vouchers");
  const v = find(s.vouchers, i.voucherId, "Voucher");
  if (v.status !== "SUBMITTED") conflict("Only a submitted voucher can be decided");
  need(v.createdBy.id !== ctx.actor.id, "A different person must approve a voucher you drafted");
  if (!i.approve) {
    v.rejectedReason = text(i.note, 5, 300, "Reason");
    v.status = "REJECTED";
    note(ctx, v.history, `${ctx.actor.name} rejected it: ${v.rejectedReason}`);
    return audit(s, ctx, "VOUCHER_REJECTED", v.id, `Voucher ${v.id} rejected`);
  }
  if ((v.type === "PAYMENT" || v.type === "JOURNAL") && v.category) {
    v.overBudget = wouldExceedBudget(s, v.projectId, v.category, v.amount);
    if (v.overBudget && !can.manage(ctx.actor)) conflict(`This voucher would push ${categoryLabel(v.category)} over its budget — Management must approve it`);
  }
  v.status = "APPROVED";
  v.approvedBy = stamp(ctx);
  note(ctx, v.history, `${ctx.actor.name} approved it`);
  return audit(s, ctx, "VOUCHER_APPROVED", v.id, `Voucher ${v.id} approved`);
}

export function postVoucher(s: FinanceState, ctx: Ctx, i: { voucherId: string }): Result {
  need(can.approve(ctx.actor), "Only the Finance Head can post vouchers to the ledger");
  const v = find(s.vouchers, i.voucherId, "Voucher");
  if (v.status !== "APPROVED") conflict("A voucher must be approved before it is posted");
  const base = { date: v.date, projectId: v.projectId, workOrderId: null, source: { type: "VOUCHER" as const, id: v.id }, reversesId: null };
  const instalmentNo = latestReleasedNo(s, v.projectId);
  const line = v.bankLineId ? find(s.bankLines, v.bankLineId, "Bank line") : null;
  if (line && !lineOpen(line)) conflict("The bank line this voucher clears has been matched elsewhere");
  const entries: LedgerEntry[] = [];
  if (v.type === "PAYMENT") {
    entries.push(
      post(
        s,
        ctx,
        { ...base, kind: line?.classification === "BANK_CHARGE" ? "BANK_CHARGE" : "PAYMENT", direction: "OUT", amount: v.amount, category: v.category, description: v.description, accountId: line?.accountId ?? defaultAccount(s), instalmentNo },
        "PM",
      ),
    );
  } else if (v.type === "RECEIPT") {
    if (!line) conflict("A receipt voucher must clear a bank line");
    entries.push(post(s, ctx, { ...base, kind: "RECEIPT", direction: "IN", amount: v.amount, category: null, description: v.description, accountId: line.accountId, instalmentNo: null }, "RCV"));
  } else if (v.type === "JOURNAL") {
    entries.push(post(s, ctx, { ...base, kind: "JOURNAL", direction: "IN", amount: v.amount, category: v.fromCategory, description: `${v.description} (moved out)`, accountId: null, instalmentNo }, "JV"));
    entries.push(post(s, ctx, { ...base, kind: "JOURNAL", direction: "OUT", amount: v.amount, category: v.category, description: `${v.description} (moved in)`, accountId: null, instalmentNo }, "JV"));
  } else if (v.type === "REVERSAL") {
    const orig = find(s.ledger, v.reversesLedgerId ?? "", "Ledger entry");
    if (orig.reversedById) conflict(`${orig.ref} is already reversed`);
    const e = post(
      s,
      ctx,
      {
        ...base,
        kind: "REVERSAL",
        direction: orig.direction === "IN" ? "OUT" : "IN",
        amount: orig.amount,
        category: orig.category,
        description: `Reverses ${orig.ref}: ${v.description}`,
        accountId: orig.accountId,
        instalmentNo: orig.instalmentNo,
        workOrderId: orig.workOrderId,
        reversesId: orig.id,
      },
      "RV",
    );
    orig.reversedById = e.id;
    entries.push(e);
  } else bad("This voucher type cannot be posted");
  if (line) matchLine(ctx, line, entries[0]);
  v.ledgerIds = entries.map((e) => e.id);
  v.status = "POSTED";
  v.postedBy = stamp(ctx);
  note(ctx, v.history, `${ctx.actor.name} posted it to the ledger (${entries.map((e) => e.ref).join(", ")})`);
  return audit(s, ctx, "VOUCHER_POSTED", v.id, `Voucher ${v.id} posted`);
}

// ---------- bank statement and reconciliation ----------

export type StatementLineInput = { date: string; description: string; reference: string; amount: number };

export function uploadStatement(s: FinanceState, ctx: Ctx, i: { accountId: string; month: string; fileName: string; lines: StatementLineInput[] }) {
  need(can.prepare(ctx.actor), "Only Finance can upload bank statements");
  find(s.accounts, i.accountId, "Bank account");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(i.month)) bad("Month must be YYYY-MM");
  if (i.month > monthKey(istDate(ctx.now))) bad("Cannot upload a statement for a future month");
  if (isLocked(s, i.month)) conflict(`${monthLabel(i.month)} is locked`);
  const fileName = text(i.fileName, 1, 120, "File name");
  if (!Array.isArray(i.lines) || i.lines.length === 0) bad("The statement has no lines");
  if (i.lines.length > 1000) bad("A statement can have at most 1000 lines");
  const clean = i.lines.map((l, n) => {
    const row = `Line ${n + 1}`;
    const date = isoDate(l.date, `${row}: date`);
    if (monthKey(date) !== i.month) bad(`${row}: ${date} is not in ${monthLabel(i.month)}`);
    if (!Number.isFinite(l.amount) || l.amount === 0 || !isValidAmount(Math.abs(l.amount))) bad(`${row}: amount must be a non-zero rupee amount`);
    return { date, description: text(l.description, 1, 120, `${row}: description`), reference: text(l.reference, 1, 40, `${row}: reference`), amount: roundRupee(l.amount) };
  });
  let added = 0;
  let skipped = 0;
  for (const l of clean) {
    const dup = s.bankLines.some((x) => x.accountId === i.accountId && x.date === l.date && x.amount === l.amount && sameText(x.reference, l.reference));
    if (dup) {
      skipped++;
      continue;
    }
    s.bankLines.push({ id: nextId(s, "BK"), accountId: i.accountId, month: i.month, ...l, ledgerId: null, receiptId: null, classification: "NONE", explanation: null, matchedBy: null });
    added++;
  }
  const up = s.uploads.find((u) => u.accountId === i.accountId && u.month === i.month);
  const total = s.bankLines.filter((x) => x.accountId === i.accountId && x.month === i.month).length;
  if (up) Object.assign(up, { lines: total, by: stamp(ctx), fileName });
  else s.uploads.push({ accountId: i.accountId, month: i.month, lines: total, by: stamp(ctx), fileName });
  audit(s, ctx, "STATEMENT_UPLOADED", `${i.accountId}:${i.month}`, `Statement ${fileName} for ${monthLabel(i.month)}: ${added} lines added, ${skipped} duplicates skipped`);
  return { added, skipped };
}

function editableLine(s: FinanceState, ctx: Ctx, lineId: string): BankLine {
  need(can.prepare(ctx.actor), "Only Finance can work on the bank reconciliation");
  const line = find(s.bankLines, lineId, "Bank line");
  if (isLocked(s, line.month)) conflict(`${monthLabel(line.month)} is locked`);
  return line;
}

export function confirmMatch(s: FinanceState, ctx: Ctx, i: { lineId: string }): Result {
  const line = editableLine(s, ctx, i.lineId);
  const view = reconciliation(s, line.accountId, line.month).lines.find((v) => v.line.id === line.id);
  const sug = view?.suggestion ?? conflict("There is no suggested match for this line");
  if (sug.type === "RECEIPT") return linkReceipt(s, ctx, { receiptId: sug.id, bankLineId: line.id });
  const entry = find(s.ledger, sug.id, "Ledger entry");
  matchLine(ctx, line, entry);
  return audit(s, ctx, "BANK_LINE_MATCHED", line.id, `Bank line ${line.reference} matched to ${entry.ref}`);
}

export function linkLine(s: FinanceState, ctx: Ctx, i: { lineId: string; targetType: "RECEIPT" | "LEDGER"; targetId: string }): Result {
  const line = editableLine(s, ctx, i.lineId);
  if (!lineOpen(line)) conflict("That bank line is already matched or explained");
  if (i.targetType === "RECEIPT") return linkReceipt(s, ctx, { receiptId: i.targetId, bankLineId: line.id });
  const entry = find(s.ledger, i.targetId, "Ledger entry");
  matchLine(ctx, line, entry);
  return audit(s, ctx, "BANK_LINE_MATCHED", line.id, `Bank line ${line.reference} matched by hand to ${entry.ref}`);
}

export function classifyLine(s: FinanceState, ctx: Ctx, i: { lineId: string; classification: "BANK_CHARGE" | "INTEREST" | "NONE" }): Result {
  const line = editableLine(s, ctx, i.lineId);
  if (!lineOpen(line)) conflict("That bank line is already matched or explained");
  if (i.classification === "BANK_CHARGE" && line.amount > 0) bad("A bank charge is money out");
  if (i.classification === "INTEREST" && line.amount < 0) bad("Interest is money in");
  if (!["BANK_CHARGE", "INTEREST", "NONE"].includes(i.classification)) bad("Choose bank charge or interest");
  line.classification = i.classification;
  return audit(s, ctx, "BANK_LINE_CLASSIFIED", line.id, `Bank line ${line.reference} marked ${i.classification.toLowerCase().replace("_", " ")}`);
}

export function explainLine(s: FinanceState, ctx: Ctx, i: { lineId: string; note: string }): Result {
  const line = editableLine(s, ctx, i.lineId);
  if (!lineOpen(line)) conflict("That bank line is already matched or explained");
  const memo = text(i.note, 10, 300, "Explanation");
  line.explanation = { note: memo, by: stamp(ctx) };
  return audit(s, ctx, "BANK_LINE_EXPLAINED", line.id, `Bank line ${line.reference} explained: ${memo}`);
}

/** Undo a wrong match. Records nothing new in the books; only the link is removed. */
export function unmatchLine(s: FinanceState, ctx: Ctx, i: { lineId: string; reason: string }): Result {
  const line = editableLine(s, ctx, i.lineId);
  need(can.approve(ctx.actor), "Only the Finance Head can undo a match");
  const reason = text(i.reason, 5, 300, "Reason");
  if (line.ledgerId) {
    const entry = find(s.ledger, line.ledgerId, "Ledger entry");
    if (entry.kind === "RECEIPT" && entry.source?.type === "RECEIPT") conflict(`${entry.ref} was verified against this line — reverse the receipt instead of unmatching it`);
    entry.bankLineId = null;
    line.ledgerId = null;
    line.matchedBy = null;
  } else if (line.receiptId) {
    const r = find(s.receipts, line.receiptId, "Receipt");
    r.bankLineId = null;
    r.linkedBy = null;
    note(ctx, r.history, `${ctx.actor.name} removed the bank match: ${reason}`);
    line.receiptId = null;
  } else if (line.explanation) line.explanation = null;
  else if (line.classification !== "NONE") line.classification = "NONE";
  else conflict("This line has no match to undo");
  return audit(s, ctx, "BANK_LINE_UNMATCHED", line.id, `Match on bank line ${line.reference} undone: ${reason}`);
}

// ---------- month-end close ----------

function closeFor(s: FinanceState, month: string) {
  let c = s.closes.find((x) => x.month === month);
  if (!c) {
    c = { month, signedOffBy: null, lockedBy: null, reopened: [] };
    s.closes.push(c);
  }
  return c;
}

export function signOff(s: FinanceState, ctx: Ctx, i: { accountId: string; month: string }): Result {
  need(can.approve(ctx.actor), "Only the Finance Head signs off the month");
  const c = closeChecklist(s, i.accountId, i.month);
  if (c.locked) conflict("The month is already locked");
  if (!c.canSignOff) conflict(`Not ready to sign off: ${c.items.filter((x) => x.status !== "DONE" && x.key !== "signoff" && x.key !== "lock").map((x) => x.label.toLowerCase()).join("; ") || "already signed off"}`);
  need(c.preparerId !== ctx.actor.id, "Sign-off needs a different person from the one who prepared the reconciliation");
  closeFor(s, i.month).signedOffBy = stamp(ctx);
  return audit(s, ctx, "MONTH_SIGNED_OFF", i.month, `${monthLabel(i.month)} signed off`);
}

export function lockMonth(s: FinanceState, ctx: Ctx, i: { accountId: string; month: string }): Result {
  need(can.approve(ctx.actor), "Only the Finance Head can lock a month");
  const c = closeChecklist(s, i.accountId, i.month);
  if (c.locked) conflict("The month is already locked");
  if (!c.canLock) conflict("Every checklist item and the Finance Head sign-off must be done before locking");
  closeFor(s, i.month).lockedBy = stamp(ctx);
  return audit(s, ctx, "MONTH_LOCKED", i.month, `${monthLabel(i.month)} locked`);
}

export function reopenMonth(s: FinanceState, ctx: Ctx, i: { month: string; reason: string }): Result {
  need(can.manage(ctx.actor), "Only Management can reopen a locked month");
  const reason = text(i.reason, 10, 300, "Reason");
  const c = s.closes.find((x) => x.month === i.month);
  if (!c?.lockedBy) conflict("The month is not locked");
  c.reopened.push({ by: stamp(ctx), reason });
  c.lockedBy = null;
  c.signedOffBy = null;
  return audit(s, ctx, "MONTH_REOPENED", i.month, `${monthLabel(i.month)} reopened: ${reason}`);
}
