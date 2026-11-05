import { addDays, addMonths, daysBetween, formatLakh, monthEnd, monthKey, monthLabel, roundRupee } from "./finance-format";
import {
  CATEGORIES,
  FIN_BASE,
  type Advance,
  type BankLine,
  type Bill,
  type BillStatus,
  type Category,
  type FinanceState,
  type LedgerEntry,
} from "./finance-types";

// Every figure the Finance screens show is computed here from the same records, so a
// KPI can never disagree with the table under it. Pure functions: no I/O, no clock
// (callers pass "now"), safe to unit test and to run on the client.

export type Period = { key: string; label: string; from: string; to: string };

export const PERIODS: Period[] = [
  { key: "fy2026", label: "FY 2026-27", from: "2026-04-01", to: "2027-03-31" },
  { key: "q3-2026", label: "Oct–Dec 2026", from: "2026-10-01", to: "2026-12-31" },
  { key: "q2-2026", label: "Jul–Sep 2026", from: "2026-07-01", to: "2026-09-30" },
  { key: "2026-11", label: "November 2026", from: "2026-11-01", to: "2026-11-30" },
  { key: "2026-10", label: "October 2026", from: "2026-10-01", to: "2026-10-31" },
  { key: "2026-09", label: "September 2026", from: "2026-09-01", to: "2026-09-30" },
  { key: "fy2025", label: "FY 2025-26", from: "2025-04-01", to: "2026-03-31" },
];

export function periodByKey(key: string | null | undefined): Period {
  return PERIODS.find((p) => p.key === key) ?? PERIODS[0];
}

export type Scope = { projectId: string; period: Period };

export function inPeriod(date: string, period: Period): boolean {
  const d = date.slice(0, 10);
  return d >= period.from && d <= period.to;
}

const inProject = (projectId: string, wanted: string) => wanted === "all" || projectId === wanted;

// ---------- the ledger: income vs spend ----------

/** Receipts (and their reversals) are money in; everything else is spend. */
function bucket(e: LedgerEntry, s: FinanceState): "INCOME" | "SPEND" {
  if (e.kind === "RECEIPT") return "INCOME";
  if (e.kind === "REVERSAL" && e.reversesId) {
    const orig = s.ledger.find((x) => x.id === e.reversesId);
    return orig?.kind === "RECEIPT" ? "INCOME" : "SPEND";
  }
  return "SPEND";
}

function sumSpend(s: FinanceState, keep: (e: LedgerEntry) => boolean): number {
  let n = 0;
  for (const e of s.ledger) if (bucket(e, s) === "SPEND" && keep(e)) n += e.direction === "OUT" ? e.amount : -e.amount;
  return roundRupee(n);
}

function sumIncome(s: FinanceState, keep: (e: LedgerEntry) => boolean): number {
  let n = 0;
  for (const e of s.ledger) if (bucket(e, s) === "INCOME" && keep(e)) n += e.direction === "IN" ? e.amount : -e.amount;
  return roundRupee(n);
}

const inScope = (scope: Scope) => (e: LedgerEntry) => inProject(e.projectId, scope.projectId) && inPeriod(e.date, scope.period);

/** Received and verified: only receipts that reached the ledger (bank-matched, second person). */
export function verifiedIn(s: FinanceState, scope: Scope): number {
  return sumIncome(s, inScope(scope));
}

/** Paid out, net of reversals and recoveries. */
export function paidOut(s: FinanceState, scope: Scope, category?: Category): number {
  const keep = inScope(scope);
  return sumSpend(s, (e) => keep(e) && (category === undefined || e.category === category));
}

export function receiptTotals(s: FinanceState, scope: Scope) {
  const rows = s.receipts.filter((r) => inProject(r.projectId, scope.projectId) && inPeriod(r.receivedOn, scope.period));
  const sum = (st: string) => roundRupee(rows.filter((r) => r.status === st).reduce((n, r) => n + r.amount, 0));
  return {
    verified: verifiedIn(s, scope),
    claimed: sum("CLAIMED"),
    claimedCount: rows.filter((r) => r.status === "CLAIMED").length,
    returned: sum("RETURNED"),
    returnedCount: rows.filter((r) => r.status === "RETURNED").length,
  };
}

// ---------- commitments ----------

export function billAmount(b: Pick<Bill, "finalAmount" | "submittedAmount">): number {
  return b.finalAmount ?? b.submittedAmount;
}

/** What is actually paid out for a bill: final amount less the advance already paid. */
export function billPayable(b: Pick<Bill, "finalAmount" | "submittedAmount" | "advanceDeduction">): number {
  return roundRupee(billAmount(b) - b.advanceDeduction);
}

export function paidAgainstWorkOrder(s: FinanceState, workOrderId: string): number {
  return sumSpend(s, (e) => e.workOrderId === workOrderId);
}

export function workOrderOutstanding(s: FinanceState, workOrderId: string): number {
  const wo = s.workOrders.find((w) => w.id === workOrderId);
  if (!wo || !wo.approved || wo.closed) return 0;
  return Math.max(0, roundRupee(wo.amount - paidAgainstWorkOrder(s, wo.id)));
}

/**
 * Committed, not yet paid (as of now): what approved work orders still owe, plus approved
 * bills with no work order that are waiting for payment. Bills under a work order are
 * already inside the order's figure, so they are not added twice.
 */
export function committed(s: FinanceState, projectId: string, category?: Category, instalmentNo?: number): number {
  let n = 0;
  for (const wo of s.workOrders) {
    if (!inProject(wo.projectId, projectId)) continue;
    if (category !== undefined && wo.category !== category) continue;
    if (instalmentNo !== undefined && wo.instalmentNo !== instalmentNo) continue;
    n += workOrderOutstanding(s, wo.id);
  }
  if (instalmentNo === undefined || instalmentNo === latestReleased(s, projectId)) {
    for (const b of s.bills) {
      if (b.status !== "APPROVED" || b.workOrderId) continue;
      if (!inProject(b.projectId, projectId)) continue;
      if (category !== undefined && b.category !== category) continue;
      n += billPayable(b);
    }
  }
  return roundRupee(n);
}

export type Summary = { verified: number; claimed: number; claimedCount: number; paid: number; committed: number; cash: number };

/** The five headline figures. Never added together: each is a different state of money. */
export function summary(s: FinanceState, scope: Scope): Summary {
  const r = receiptTotals(s, scope);
  const paid = paidOut(s, scope);
  return {
    verified: r.verified,
    claimed: r.claimed,
    claimedCount: r.claimedCount,
    paid,
    committed: committed(s, scope.projectId),
    cash: roundRupee(r.verified - paid),
  };
}

export type CategoryRow = { category: Category; label: string; paid: number; committed: number; total: number };

export function byCategory(s: FinanceState, scope: Scope): CategoryRow[] {
  return CATEGORIES.map((c) => {
    const paid = paidOut(s, scope, c.key);
    const com = committed(s, scope.projectId, c.key);
    return { category: c.key, label: c.label, paid, committed: com, total: roundRupee(paid + com) };
  });
}

export type MonthRow = { month: string; label: string; verifiedIn: number; paidOut: number };

export function monthlyInOut(s: FinanceState, projectId: string, endMonth: string, n = 6): MonthRow[] {
  const rows: MonthRow[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const month = addMonths(endMonth, -i);
    const scope: Scope = { projectId, period: { key: month, label: monthLabel(month), from: `${month}-01`, to: monthEnd(month) } };
    rows.push({ month, label: monthLabel(month), verifiedIn: verifiedIn(s, scope), paidOut: paidOut(s, scope) });
  }
  return rows;
}

// ---------- scheme instalments ----------

function latestReleased(s: FinanceState, projectId: string): number | undefined {
  const released = s.instalments
    .filter((i) => inProject(i.projectId, projectId) && i.receiptId && s.receipts.find((r) => r.id === i.receiptId)?.status === "VERIFIED")
    .map((i) => i.no);
  return released.length ? Math.max(...released) : undefined;
}

export type InstalmentStatus = "NOT_RELEASED" | "IN_USE" | "FULLY_USED" | "OVER_COMMITTED";
export type InstalmentRow = {
  no: number;
  purpose: string;
  dueNote: string;
  releasedOn: string | null;
  released: number;
  spent: number;
  committed: number;
  remaining: number;
  status: InstalmentStatus;
};

/** Remaining = released − spent − committed, each counted once. */
export function instalmentRows(s: FinanceState, projectId: string): InstalmentRow[] {
  return s.instalments
    .filter((i) => i.projectId === projectId)
    .sort((a, b) => a.no - b.no)
    .map((i) => {
      const r = i.receiptId ? s.receipts.find((x) => x.id === i.receiptId) : undefined;
      if (!r || r.status !== "VERIFIED") {
        return { no: i.no, purpose: i.purpose, dueNote: i.dueNote, releasedOn: null, released: 0, spent: 0, committed: 0, remaining: 0, status: "NOT_RELEASED" as const };
      }
      const spent = sumSpend(s, (e) => e.projectId === projectId && e.instalmentNo === i.no);
      const com = committed(s, projectId, undefined, i.no);
      const remaining = roundRupee(r.amount - spent - com);
      const status: InstalmentStatus = remaining < 0 ? "OVER_COMMITTED" : remaining === 0 ? "FULLY_USED" : "IN_USE";
      return { no: i.no, purpose: i.purpose, dueNote: i.dueNote, releasedOn: r.receivedOn, released: r.amount, spent, committed: com, remaining, status };
    });
}

// ---------- budgets ----------

export type BudgetFlag = "OVER" | "NEARLY_USED" | "ON_TRACK";
export type BudgetRow = { category: Category; label: string; budget: number; paid: number; committed: number; left: number; usePct: number; flag: BudgetFlag };

const ALL_TIME: Period = { key: "all", label: "All time", from: "0000-01-01", to: "9999-12-31" };
export const NEARLY_USED_PCT = 85;

export function budgetFlag(budget: number, used: number): BudgetFlag {
  if (used > budget) return "OVER";
  if (budget > 0 && (used / budget) * 100 >= NEARLY_USED_PCT) return "NEARLY_USED";
  return "ON_TRACK";
}

export function budgetRows(s: FinanceState, projectId: string): BudgetRow[] {
  return CATEGORIES.map((c) => {
    const budget = roundRupee(s.budgets.filter((b) => inProject(b.projectId, projectId) && b.category === c.key).reduce((n, b) => n + b.amount, 0));
    const paid = paidOut(s, { projectId, period: ALL_TIME }, c.key);
    const com = committed(s, projectId, c.key);
    const used = roundRupee(paid + com);
    return {
      category: c.key,
      label: c.label,
      budget,
      paid,
      committed: com,
      left: roundRupee(budget - used),
      usePct: budget > 0 ? Math.round((used / budget) * 1000) / 10 : used > 0 ? 100 : 0,
      flag: budgetFlag(budget, used),
    };
  });
}

/** Would adding this much new spend push the category over its budget? */
export function wouldExceedBudget(s: FinanceState, projectId: string, category: Category, extra: number): boolean {
  const row = budgetRows(s, projectId).find((r) => r.category === category);
  return row ? roundRupee(row.paid + row.committed + extra) > row.budget : true;
}

// ---------- advances ----------

export function advanceOutstanding(a: Pick<Advance, "amount" | "adjustments">): number {
  return roundRupee(a.amount - a.adjustments.reduce((n, x) => n + x.amount, 0));
}

export function advanceStatusFor(a: Pick<Advance, "amount" | "adjustments" | "status">): Advance["status"] {
  if (a.status === "PENDING_APPROVAL" || a.status === "REJECTED") return a.status;
  const left = advanceOutstanding(a);
  if (left <= 0) return "CLEARED";
  return left < a.amount ? "PARTLY_ADJUSTED" : "OPEN";
}

// ---------- bills ----------

export function missingForApproval(s: FinanceState, b: Bill): string[] {
  const out: string[] = [];
  if (b.workOrderId) {
    const wo = s.workOrders.find((w) => w.id === b.workOrderId);
    if (!wo || !wo.approved) out.push("Work order is not approved");
    if (!b.workAccepted) out.push("AVP has not accepted the completed work");
  }
  if (!b.docs.some((d) => d.kind === "INVOICE")) out.push("Invoice is not attached");
  if (b.workOrderId && !b.docs.some((d) => d.kind === "COMPLETION_PROOF")) out.push("Completion proof is not attached");
  return out;
}

export function missingDocument(b: Bill): boolean {
  return !b.docs.some((d) => d.kind === "INVOICE") || (b.workOrderId !== null && !b.docs.some((d) => d.kind === "COMPLETION_PROOF"));
}

export type BillCheck = { label: string; state: "YES" | "NO" | "NOTE" };

export function billChecks(s: FinanceState, b: Bill): BillCheck[] {
  const checks: BillCheck[] = [];
  if (b.workOrderId) {
    const wo = s.workOrders.find((w) => w.id === b.workOrderId);
    checks.push({ label: "Work order is approved", state: wo?.approved ? "YES" : "NO" });
    checks.push({ label: "AVP accepted the completed work", state: b.workAccepted ? "YES" : "NO" });
  }
  const invoice = b.docs.some((d) => d.kind === "INVOICE");
  const proof = !b.workOrderId || b.docs.some((d) => d.kind === "COMPLETION_PROOF");
  checks.push({ label: b.workOrderId ? "Invoice and completion proof attached" : "Invoice attached", state: invoice && proof ? "YES" : "NO" });
  if (b.advanceDeduction > 0) checks.push({ label: `An advance is already paid against this order`, state: "NOTE" });
  return checks;
}

const OPEN_BILL: BillStatus[] = ["DRAFT", "WITH_ACCOUNTANT", "WITH_FINANCE_HEAD"];
const CLOSED_BILL: BillStatus[] = ["PAID", "REJECTED"];

export type BillCounts = { ALL: number; DRAFT: number; WAITING: number; APPROVED: number; PAID: number; REJECTED: number };

export function billCounts(bills: Bill[]): BillCounts {
  const c: BillCounts = { ALL: bills.length, DRAFT: 0, WAITING: 0, APPROVED: 0, PAID: 0, REJECTED: 0 };
  for (const b of bills) {
    if (b.status === "WITH_ACCOUNTANT" || b.status === "WITH_FINANCE_HEAD") c.WAITING++;
    else c[b.status]++;
  }
  return c;
}

export type BillFilters = { q?: string; type?: string; wo?: string; due?: string; status?: string; projectId?: string };

export function filterBills(s: FinanceState, f: BillFilters, now: string): Bill[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  const today = now.slice(0, 10);
  return s.bills.filter((b) => {
    if (f.projectId && !inProject(b.projectId, f.projectId)) return false;
    if (q) {
      const vendor = s.vendors.find((v) => v.id === b.vendorId)?.name ?? "";
      const hay = [b.id, vendor, b.workOrderId ?? "", b.shed ?? ""].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.type && b.type !== f.type) return false;
    if (f.wo && b.workOrderId !== f.wo && b.shed !== f.wo) return false;
    if (f.due && f.due !== "any") {
      if (CLOSED_BILL.includes(b.status)) return false;
      if (f.due === "overdue" && !(b.dueDate < today)) return false;
      if (f.due === "week" && !(b.dueDate >= today && b.dueDate <= addDays(today, 7))) return false;
      if (f.due === "month" && !(b.dueDate >= today && b.dueDate <= addDays(today, 30))) return false;
    }
    if (f.status && f.status !== "ALL") {
      if (f.status === "WAITING") return b.status === "WITH_ACCOUNTANT" || b.status === "WITH_FINANCE_HEAD";
      return b.status === f.status;
    }
    return true;
  });
}

export function isOpenBill(b: Bill): boolean {
  return OPEN_BILL.includes(b.status);
}

// ---------- reconciliation ----------

export type LineStatus = "MATCHED" | "EXPLAINED" | "LINKED" | "CLASSIFIED" | "SUGGESTED" | "NOT_MATCHED";
export type Suggestion = { type: "RECEIPT" | "LEDGER"; id: string };
export type LineView = { line: BankLine; status: LineStatus; suggestion: Suggestion | null };
export type DiffRow = { key: string; reason: string; items: number; itemLabel: string; amount: number; action: string };

const SUGGEST_DAYS = 5;
const signed = (e: LedgerEntry) => (e.direction === "IN" ? e.amount : -e.amount);

export function reconciliation(s: FinanceState, accountId: string, month: string) {
  const end = monthEnd(month);
  const lines = s.bankLines.filter((l) => l.accountId === accountId && l.date <= end).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const books = s.ledger.filter((e) => e.accountId === accountId && e.date <= end);
  const bankClosing = roundRupee(lines.reduce((n, l) => n + l.amount, 0));
  const booksClosing = roundRupee(books.reduce((n, e) => n + signed(e), 0));

  // Suggestions: closest unmatched record with the same amount within a few days; each record used once.
  const taken = new Set<string>();
  const views: LineView[] = lines.map((line) => {
    let status: LineStatus;
    let suggestion: Suggestion | null = null;
    if (line.ledgerId) status = "MATCHED";
    else if (line.explanation) status = "EXPLAINED";
    else if (line.receiptId) status = "LINKED";
    else if (line.classification !== "NONE") status = "CLASSIFIED";
    else {
      const near = (d: string) => Math.abs(daysBetween(d, line.date)) <= SUGGEST_DAYS;
      const rc =
        line.amount > 0
          ? s.receipts.find((r) => r.status === "CLAIMED" && !r.bankLineId && r.amount === line.amount && near(r.receivedOn) && !taken.has(r.id))
          : undefined;
      const le = rc ? undefined : s.ledger.find((e) => e.accountId === accountId && !e.bankLineId && signed(e) === line.amount && near(e.date) && !taken.has(e.id));
      if (rc) suggestion = { type: "RECEIPT", id: rc.id };
      else if (le) suggestion = { type: "LEDGER", id: le.id };
      if (suggestion) taken.add(suggestion.id);
      status = suggestion ? "SUGGESTED" : "NOT_MATCHED";
    }
    return { line, status, suggestion };
  });

  const monthViews = views.filter((v) => v.line.month === month);
  const counts = {
    matched: monthViews.filter((v) => v.status === "MATCHED").length,
    suggested: monthViews.filter((v) => v.status === "SUGGESTED").length,
    notMatched: monthViews.filter((v) => !["MATCHED", "SUGGESTED", "EXPLAINED"].includes(v.status)).length,
    open: monthViews.filter((v) => v.status !== "MATCHED" && v.status !== "EXPLAINED").length,
  };
  const explainedCount = monthViews.filter((v) => v.status === "EXPLAINED").length;

  const bookOnly = books.filter((e) => !e.bankLineId);
  const rows: DiffRow[] = [];
  const add = (key: string, reason: string, itemLabel: string, action: string, items: { amount: number }[]) => {
    if (items.length) rows.push({ key, reason, items: items.length, itemLabel, amount: roundRupee(items.reduce((n, i) => n + i.amount, 0)), action });
  };
  const open = views.filter((v) => v.status !== "MATCHED");
  const receiptish = (v: LineView) => v.status === "LINKED" || (v.status === "SUGGESTED" && v.suggestion?.type === "RECEIPT");
  add("receipts", "Receipts claimed, bank credit not yet verified", "receipt", "Confirm the match, then a second person verifies", open.filter(receiptish).map((v) => v.line));
  add("ledger", "Bank line has a likely book entry", "line", "Confirm the suggested match", open.filter((v) => v.status === "SUGGESTED" && v.suggestion?.type === "LEDGER").map((v) => v.line));
  add("charges", "Bank charges with no voucher", "line", "Post a bank charge voucher", open.filter((v) => v.status === "CLASSIFIED" && v.line.classification === "BANK_CHARGE").map((v) => v.line));
  add("interest", "Bank interest with no voucher", "line", "Post a receipt voucher for the interest", open.filter((v) => v.status === "CLASSIFIED" && v.line.classification === "INTEREST").map((v) => v.line));
  add("unknown-in", "Money in with no record (sender unknown)", "line", "Find the sender, or explain and keep it open", open.filter((v) => v.status === "NOT_MATCHED" && v.line.amount > 0).map((v) => v.line));
  add("unknown-out", "Money out with no book entry", "line", "Find the bill or post a voucher", open.filter((v) => v.status === "NOT_MATCHED" && v.line.amount < 0).map((v) => v.line));
  add("explained", "Explained and carried forward", "line", "Already explained — review at the next close", open.filter((v) => v.status === "EXPLAINED").map((v) => v.line));
  add("book-only", "In the books, not yet on the statement", "entry", "Usually timing — check the next statement", bookOnly.map((e) => ({ amount: -signed(e) })));

  return {
    accountId,
    month,
    uploaded: s.uploads.find((u) => u.accountId === accountId && u.month === month) ?? null,
    bankClosing,
    booksClosing,
    difference: roundRupee(bankClosing - booksClosing),
    lines: views,
    monthLines: monthViews,
    counts,
    explainedCount,
    bookOnly,
    rows,
    explainedTotal: roundRupee(rows.reduce((n, r) => n + r.amount, 0)),
  };
}

export type CheckStatus = "DONE" | "WAITING" | "NOT_STARTED";
export type CloseItem = { key: string; label: string; detail: string; status: CheckStatus };

export function isLocked(s: FinanceState, month: string): boolean {
  return Boolean(s.closes.find((c) => c.month === month)?.lockedBy);
}

export function closeChecklist(s: FinanceState, accountId: string, month: string) {
  const r = reconciliation(s, accountId, month);
  const close = s.closes.find((c) => c.month === month);
  const openBills = s.bills.filter((b) => monthKey(b.billDate) === month && isOpenBill(b)).length;
  const openReceipts = s.receipts.filter((x) => monthKey(x.receivedOn) === month && x.status === "CLAIMED").length;
  const bookOnlyInMonth = r.bookOnly.filter((e) => monthKey(e.date) === month).length;
  const reconciled = r.uploaded !== null && r.counts.open === 0 && bookOnlyInMonth === 0;

  const items: CloseItem[] = [
    {
      key: "uploaded",
      label: "Bank statement uploaded",
      status: r.uploaded ? "DONE" : "WAITING",
      detail: r.uploaded ? `${r.uploaded.by.name} · ${r.uploaded.lines} lines` : "No statement for this month yet",
    },
    {
      key: "bills",
      label: "All bills in the month are approved or rejected",
      status: openBills === 0 ? "DONE" : "WAITING",
      detail: openBills === 0 ? "No bill left open" : `${openBills} bill${openBills === 1 ? "" : "s"} still open`,
    },
    {
      key: "receipts",
      label: "Every receipt is verified, returned, or listed as open",
      status: "DONE",
      detail: openReceipts === 0 ? "No open receipts" : `${openReceipts} open receipt${openReceipts === 1 ? "" : "s"} listed`,
    },
    {
      key: "reconciled",
      label: "Bank lines matched and the difference explained",
      status: !r.uploaded ? "NOT_STARTED" : reconciled ? "DONE" : "WAITING",
      detail: reconciled
        ? "Every line matched or explained"
        : `${r.counts.open} line${r.counts.open === 1 ? "" : "s"} open${bookOnlyInMonth ? ` · ${bookOnlyInMonth} book entr${bookOnlyInMonth === 1 ? "y" : "ies"} not on the statement` : ""} · ${formatLakh(r.difference)} difference`,
    },
  ];
  const ready = items.every((i) => i.status === "DONE");
  items.push({
    key: "signoff",
    label: "Finance Head reviews and signs off",
    status: close?.signedOffBy ? "DONE" : ready ? "WAITING" : "NOT_STARTED",
    detail: close?.signedOffBy ? `${close.signedOffBy.name}` : "Needs a different person from the preparer",
  });
  items.push({
    key: "lock",
    label: "Lock the month and create the pack",
    status: close?.lockedBy ? "DONE" : close?.signedOffBy ? "WAITING" : "NOT_STARTED",
    detail: close?.lockedBy ? `Locked by ${close.lockedBy.name}` : "Management can reopen, with a reason on record",
  });

  return {
    month,
    items,
    doneCount: items.filter((i) => i.status === "DONE").length,
    canSignOff: ready && !close?.signedOffBy,
    canLock: Boolean(close?.signedOffBy) && !close?.lockedBy,
    locked: Boolean(close?.lockedBy),
    preparerId: r.uploaded?.by.id ?? null,
    reconciliation: r,
  };
}

// ---------- overview helpers ----------

export type Attention = { key: string; count: number; label: string; detail: string; href: string };

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function openBankLines(s: FinanceState): BankLine[] {
  return s.bankLines.filter((l) => !l.ledgerId && !l.explanation);
}

export function needsAttention(s: FinanceState, scope: Scope, now: string): Attention[] {
  const bills = s.bills.filter((b) => inProject(b.projectId, scope.projectId));
  const waiting = bills.filter((b) => b.status === "WITH_ACCOUNTANT" || b.status === "WITH_FINANCE_HEAD");
  const oldest = waiting.reduce((m, b) => Math.max(m, daysBetween(b.submittedBy?.at ?? b.billDate, now)), 0);
  const claimed = s.receipts.filter((r) => inProject(r.projectId, scope.projectId) && r.status === "CLAIMED");
  const today = now.slice(0, 10);
  const due = bills.filter((b) => b.status === "APPROVED" && b.dueDate <= addDays(today, 7));
  const missing = bills.filter((b) => isOpenBill(b) && missingDocument(b));
  const p = `project=${encodeURIComponent(scope.projectId)}&period=${scope.period.key}`;
  return [
    {
      key: "waiting",
      count: waiting.length,
      label: "Bills waiting for approval",
      detail: waiting.length ? `Oldest has waited ${plural(oldest, "day")}` : "Nothing waiting",
      href: `${FIN_BASE}/bills?${p}&status=WAITING`,
    },
    { key: "claimed", count: claimed.length, label: "Receipts claimed, not verified", detail: "Match each one with a bank line", href: `${FIN_BASE}/receipts?${p}&rstatus=CLAIMED#receipts` },
    { key: "unmatched", count: openBankLines(s).length, label: "Bank lines without a match", detail: "Blocks the month-end close", href: `${FIN_BASE}/reconciliation?${p}` },
    { key: "due", count: due.length, label: "Vendor payments due this week", detail: "Approved and ready to pay", href: `${FIN_BASE}/bills?${p}&status=APPROVED&due=week` },
    { key: "missing", count: missing.length, label: "Bills missing a document", detail: "Invoice or completion proof not attached", href: `${FIN_BASE}/bills?${p}&missing=1` },
  ];
}

export function waitingForApproval(s: FinanceState, projectId: string, now: string) {
  return s.bills
    .filter((b) => inProject(b.projectId, projectId) && (b.status === "WITH_ACCOUNTANT" || b.status === "WITH_FINANCE_HEAD"))
    .map((b) => ({ bill: b, waited: daysBetween(b.submittedBy?.at ?? b.billDate, now), missing: missingDocument(b) }))
    .sort((a, b) => b.waited - a.waited || a.bill.id.localeCompare(b.bill.id));
}

export function latestActivity(s: FinanceState, projectId: string, n = 5): LedgerEntry[] {
  return s.ledger
    .filter((e) => inProject(e.projectId, projectId))
    .sort((a, b) => b.createdBy.at.localeCompare(a.createdBy.at) || b.id.localeCompare(a.id))
    .slice(0, n);
}

export function vendorName(s: FinanceState, id: string | null): string {
  return s.vendors.find((v) => v.id === id)?.name ?? "—";
}

export function projectName(s: FinanceState, id: string): string {
  return id === "all" ? "All projects" : (s.projects.find((p) => p.id === id)?.name ?? "Unknown project");
}
