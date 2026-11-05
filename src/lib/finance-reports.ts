import {
  advanceOutstanding,
  billAmount,
  billPayable,
  budgetRows,
  byCategory,
  closeChecklist,
  filterBills,
  inPeriod,
  instalmentRows,
  projectName,
  reconciliation,
  summary,
  vendorName,
  type BillFilters,
  type Scope,
} from "./finance-calc";
import { formatINR, monthKey, monthLabel } from "./finance-format";
import { BILL_STATUS_LABEL, BILL_TYPES, LEDGER_KIND_LABEL, categoryLabel, type FinanceState } from "./finance-types";

// Report registers for the Reports & Exports tab and the CSV downloads. Each report is
// built only from records that exist; nothing is estimated or padded.

export type Cell = string | number;
export type Column = { label: string; money?: boolean };
export type FinReport = { columns: Column[]; rows: Cell[][]; note?: string };
export type ReportCtx = { scope: Scope; accountId: string; month: string; billFilters?: BillFilters; now?: string };

const inProj = (projectId: string, scope: Scope) => scope.projectId === "all" || projectId === scope.projectId;

export const REPORTS: { key: string; label: string; hint: string; build: (s: FinanceState, c: ReportCtx) => FinReport }[] = [
  {
    key: "bills",
    label: "Bills and payments register",
    hint: "Every bill in the period with both amounts, status and payment",
    build: (s, { scope, billFilters, now }) => ({
      columns: [
        { label: "Bill" },
        { label: "Project" },
        { label: "Payee" },
        { label: "Type" },
        { label: "Work order" },
        { label: "Bill date" },
        { label: "Due" },
        { label: "As submitted", money: true },
        { label: "Final", money: true },
        { label: "Advance deducted", money: true },
        { label: "Paid / payable", money: true },
        { label: "Status" },
        { label: "Payment ref" },
      ],
      rows: (billFilters ? filterBills(s, billFilters, now ?? new Date().toISOString()) : s.bills)
        .filter((b) => inProj(b.projectId, scope) && inPeriod(b.billDate, scope.period))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((b) => [
          b.id,
          projectName(s, b.projectId),
          vendorName(s, b.vendorId),
          BILL_TYPES.find((t) => t.key === b.type)?.label ?? b.type,
          b.workOrderId ?? "",
          b.billDate,
          b.dueDate,
          b.submittedAmount,
          billAmount(b),
          b.advanceDeduction,
          billPayable(b),
          BILL_STATUS_LABEL[b.status],
          b.payment?.reference ?? "",
        ]),
    }),
  },
  {
    key: "receipts",
    label: "Receipt register",
    hint: "Claimed, verified and returned receipts, with the bank line",
    build: (s, { scope }) => ({
      columns: [{ label: "Receipt" }, { label: "Project" }, { label: "From" }, { label: "Purpose" }, { label: "Received on" }, { label: "Amount", money: true }, { label: "Entered by" }, { label: "Verified by" }, { label: "Status" }],
      rows: s.receipts
        .filter((r) => inProj(r.projectId, scope) && inPeriod(r.receivedOn, scope.period))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => [r.id, projectName(s, r.projectId), r.from, r.purpose, r.receivedOn, r.amount, r.enteredBy.name, r.verifiedBy?.name ?? "", r.status.charAt(0) + r.status.slice(1).toLowerCase()]),
      note: "Only verified receipts are counted as money received.",
    }),
  },
  {
    key: "spending",
    label: "Project-wise spending",
    hint: "Paid and committed by category for each project",
    build: (s, { scope }) => {
      const projects = scope.projectId === "all" ? s.projects : s.projects.filter((p) => p.id === scope.projectId);
      return {
        columns: [{ label: "Project" }, { label: "Category" }, { label: "Paid", money: true }, { label: "Committed, not yet paid", money: true }, { label: "Total", money: true }],
        rows: projects.flatMap((p) => byCategory(s, { projectId: p.id, period: scope.period }).map((c) => [p.name, c.label, c.paid, c.committed, c.total])),
        note: "Committed is as of today; paid is within the selected period.",
      };
    },
  },
  {
    key: "budget",
    label: "Budget utilisation",
    hint: "Budget, paid, committed and what is left",
    build: (s, { scope }) => {
      const projects = scope.projectId === "all" ? s.projects : s.projects.filter((p) => p.id === scope.projectId);
      return {
        columns: [{ label: "Project" }, { label: "Category" }, { label: "Budget", money: true }, { label: "Paid", money: true }, { label: "Committed", money: true }, { label: "Left", money: true }, { label: "Used %" }, { label: "Flag" }],
        rows: projects.flatMap((p) =>
          budgetRows(s, p.id).map((r) => [p.name, r.label, r.budget, r.paid, r.committed, r.left, `${r.usePct}%`, r.flag === "OVER" ? "Over budget" : r.flag === "NEARLY_USED" ? "Nearly used" : "On track"]),
        ),
        note: "Left = budget − paid − committed.",
      };
    },
  },
  {
    key: "instalments",
    label: "Utilisation statement (scheme instalments)",
    hint: "Released, spent, committed and remaining per instalment",
    build: (s, { scope }) => {
      const projects = scope.projectId === "all" ? s.projects : s.projects.filter((p) => p.id === scope.projectId);
      return {
        columns: [{ label: "Project" }, { label: "Instalment" }, { label: "Released on" }, { label: "Released", money: true }, { label: "Spent", money: true }, { label: "Committed, not yet paid", money: true }, { label: "Remaining", money: true }, { label: "Status" }],
        rows: projects.flatMap((p) =>
          instalmentRows(s, p.id).map((i) => [p.name, `Instalment ${i.no}`, i.releasedOn ?? "Not released", i.released, i.spent, i.committed, i.remaining, i.status.replace(/_/g, " ").toLowerCase()]),
        ),
        note: "Remaining = released − spent − committed. Draft for Finance review; the scheme's own format is still to be confirmed.",
      };
    },
  },
  {
    key: "advances",
    label: "Advances and recoveries",
    hint: "Each advance with what is adjusted and what is still to recover",
    build: (s, { scope }) => ({
      columns: [{ label: "Advance" }, { label: "Project" }, { label: "Given to" }, { label: "Given on" }, { label: "Given", money: true }, { label: "Adjusted so far", money: true }, { label: "Still to recover", money: true }, { label: "Status" }],
      rows: s.advances
        .filter((a) => inProj(a.projectId, scope) && inPeriod(a.givenOn, scope.period))
        .map((a) => [a.id, projectName(s, a.projectId), a.givenTo, a.givenOn, a.amount, a.amount - advanceOutstanding(a), advanceOutstanding(a), a.status.replace(/_/g, " ").toLowerCase()]),
    }),
  },
  {
    key: "ledger",
    label: "Ledger register",
    hint: "Every posted entry with money in and out",
    build: (s, { scope }) => ({
      columns: [{ label: "Entry" }, { label: "Date" }, { label: "Voucher / ref" }, { label: "Kind" }, { label: "Project" }, { label: "Category" }, { label: "Description" }, { label: "In (debit bank)", money: true }, { label: "Out (credit bank)", money: true }, { label: "Bank line" }, { label: "Created by" }],
      rows: s.ledger
        .filter((e) => inProj(e.projectId, scope) && inPeriod(e.date, scope.period))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
        .map((e) => [e.id, e.date, e.ref, LEDGER_KIND_LABEL[e.kind], projectName(s, e.projectId), e.category ? categoryLabel(e.category) : "", e.description, e.direction === "IN" ? e.amount : "", e.direction === "OUT" ? e.amount : "", e.bankLineId ? "Matched" : e.accountId ? "Not on statement yet" : "No bank effect", e.createdBy.name]),
    }),
  },
  {
    key: "reconciliation",
    label: "Bank reconciliation summary",
    hint: "Statement vs books for one account and month, and why they differ",
    build: (s, { accountId, month }) => {
      const r = reconciliation(s, accountId, month);
      return {
        columns: [{ label: "Item" }, { label: "Lines" }, { label: "Amount", money: true }, { label: "What to do" }],
        rows: [
          ["Bank statement closing", "", r.bankClosing, r.uploaded ? `Uploaded by ${r.uploaded.by.name}` : "No statement uploaded"],
          ["Books closing", "", r.booksClosing, "Ledger entries on this account"],
          ["Difference to explain", "", r.difference, ""],
          ...r.rows.map((d) => [d.reason, `${d.items}`, d.amount, d.action]),
          ["Total explained", "", r.explainedTotal, r.explainedTotal === r.difference ? "Matches the difference" : "Does not match — investigate"],
        ],
        note: `${s.accounts.find((a) => a.id === accountId)?.name ?? accountId}, ${monthLabel(month)}`,
      };
    },
  },
  {
    key: "closepack",
    label: "Month-end close pack",
    hint: "Bank match, ledger, bills paid, receipts and open items for one month",
    build: (s, { accountId, month }) => closePack(s, accountId, month),
  },
  {
    key: "close",
    label: "Month-end close report",
    hint: "Checklist status for each month in the period",
    build: (s, { scope, accountId }) => {
      const months = [...new Set(s.bankLines.map((l) => l.month).concat(s.closes.map((c) => c.month)))]
        .filter((m) => inPeriod(`${m}-01`, scope.period) || inPeriod(`${m}-28`, scope.period))
        .sort();
      return {
        columns: [{ label: "Month" }, { label: "Step" }, { label: "Status" }, { label: "Detail" }],
        rows: months.flatMap((m) => closeChecklist(s, accountId, m).items.map((i) => [monthLabel(m), i.label, i.status.replace("_", " ").toLowerCase(), i.detail])),
      };
    },
  },
];

/** E7 close pack: everything Finance hands over for one month, as one sheet. */
export function closePack(s: FinanceState, accountId: string, month: string): FinReport {
  const r = reconciliation(s, accountId, month);
  const c = closeChecklist(s, accountId, month);
  const inMonth = (d: string) => monthKey(d) === month;
  const rows: Cell[][] = [
    ["Summary", "Bank statement closing", "", r.bankClosing, ""],
    ["Summary", "Books closing", "", r.booksClosing, ""],
    ["Summary", "Difference", "", r.difference, r.explainedTotal === r.difference ? "Fully explained" : "Not fully explained"],
    ...r.rows.map((d): Cell[] => ["Differences", d.reason, `${d.items} ${d.itemLabel}(s)`, d.amount, d.action]),
    ...c.items.map((i): Cell[] => ["Checklist", i.label, i.status.replace("_", " ").toLowerCase(), "", i.detail]),
    ...s.ledger
      .filter((e) => e.accountId === accountId && inMonth(e.date))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e): Cell[] => ["Ledger", `${e.ref} · ${e.description}`, e.date, e.direction === "IN" ? e.amount : -e.amount, e.bankLineId ? "Matched" : "Not on statement"]),
    ...s.bills.filter((b) => b.payment && inMonth(b.payment.date)).map((b): Cell[] => ["Bills paid", `${b.id} · ${vendorName(s, b.vendorId)}`, b.payment?.date ?? "", billPayable(b), `Ref ${b.payment?.reference}`]),
    ...s.receipts.filter((x) => inMonth(x.receivedOn)).map((x): Cell[] => ["Receipts", `${x.id} · ${x.from} — ${x.purpose}`, x.receivedOn, x.amount, x.status.toLowerCase()]),
    ...r.monthLines.filter((v) => v.status !== "MATCHED").map((v): Cell[] => ["Open items", `Bank line ${v.line.reference} · ${v.line.description}`, v.line.date, v.line.amount, v.status.replace("_", " ").toLowerCase()]),
  ];
  return {
    columns: [{ label: "Section" }, { label: "Item" }, { label: "Date / detail" }, { label: "Amount", money: true }, { label: "Note" }],
    rows,
    note: `${s.accounts.find((a) => a.id === accountId)?.name ?? accountId}, ${monthLabel(month)}${c.locked ? " — locked" : " — not locked yet"}`,
  };
}

export function summaryReport(s: FinanceState, scope: Scope): FinReport {
  const f = summary(s, scope);
  return {
    columns: [{ label: "Figure" }, { label: "Amount", money: true }, { label: "Meaning" }],
    rows: [
      ["Received and verified", f.verified, "Checked against the bank by Finance"],
      ["Claimed, not yet verified", f.claimed, `${f.claimedCount} receipts waiting; not counted above`],
      ["Paid out", f.paid, "Bills and expenses already paid"],
      ["Committed, not yet paid", f.committed, "Work orders and approved bills (as of today)"],
      ["Cash view", f.cash, "Verified receipts minus paid out; not the budget"],
    ],
    note: `${projectName(s, scope.projectId)}, ${scope.period.label}. Five separate figures — never add them together.`,
  };
}

export function reportByKey(key: string) {
  return REPORTS.find((r) => r.key === key);
}

/** Default reconciliation month for a period: the last month with a statement inside it. */
export function monthForPeriod(s: FinanceState, scope: Scope): string {
  const months = [...new Set(s.bankLines.map((l) => l.month))].filter((m) => inPeriod(`${m}-15`, scope.period)).sort();
  return months.at(-1) ?? monthKey(scope.period.to);
}

export function previewCell(c: Cell, col: Column): string {
  if (typeof c === "number" && col.money) return formatINR(c);
  return String(c);
}

export function reportCsvRows(r: FinReport): string[][] {
  return [r.columns.map((c) => c.label), ...r.rows.map((row) => row.map((c) => (typeof c === "number" ? c.toFixed(2) : c)))];
}
