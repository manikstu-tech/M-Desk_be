// Finance & Accounts domain model (design: Manikstu_Finance_Accounts_Design.pdf).
// The same types serve the demo repository today and a database/API-backed
// repository later — nothing in here knows where the rows come from.
// Amounts are whole or 2-decimal rupees (numbers), dates are ISO strings.

export const FIN_SLUG = "finance-accounts";
export const FIN_BASE = `/departments/${FIN_SLUG}`;

export type Category = "FABRICATOR" | "MATERIALS" | "CAMERA_LIGHT" | "TRANSPORT" | "ADMIN_OTHER";

/** Spend categories. In production these come from the chart of accounts (Finance owns the list). */
export const CATEGORIES: { key: Category; label: string }[] = [
  { key: "FABRICATOR", label: "Fabricator bills" },
  { key: "MATERIALS", label: "Materials" },
  { key: "CAMERA_LIGHT", label: "Camera and light" },
  { key: "TRANSPORT", label: "Transport" },
  { key: "ADMIN_OTHER", label: "Admin and other" },
];

export function categoryLabel(c: Category | null | undefined): string {
  return CATEGORIES.find((x) => x.key === c)?.label ?? "No category";
}

/** What a person may do in Finance. Mapped from M-DESK roles + department membership in lib/finance.ts. */
export type FinRole = "FINANCE_HEAD" | "ACCOUNTANT" | "VIEWER" | "MANAGEMENT" | "FIELD";

export type Actor = { id: string; name: string; role: FinRole; isSuper: boolean };
export type Stamp = { id: string; name: string; at: string };
export type HistoryEntry = { at: string; actorId: string; actorName: string; text: string };

export type Project = { id: string; name: string; scheme: string; sanctioned: number };
export type Vendor = { id: string; name: string };
export type BankAccount = { id: string; name: string; bank: string; last4: string };

export type WorkOrder = {
  id: string;
  projectId: string;
  vendorId: string;
  category: Category;
  description: string;
  shed: string | null;
  amount: number;
  approved: boolean;
  closed: boolean;
  instalmentNo: number;
  placedOn: string;
};

export type BillType = "FABRICATOR_BILL" | "VENDOR_INVOICE" | "INSTALLATION_BILL" | "EXPENSE";
export const BILL_TYPES: { key: BillType; label: string }[] = [
  { key: "FABRICATOR_BILL", label: "Fabricator bill" },
  { key: "VENDOR_INVOICE", label: "Vendor invoice" },
  { key: "INSTALLATION_BILL", label: "Installation bill" },
  { key: "EXPENSE", label: "Expense" },
];

export type BillStatus = "DRAFT" | "WITH_ACCOUNTANT" | "WITH_FINANCE_HEAD" | "APPROVED" | "PAID" | "REJECTED";
export const BILL_STATUS_LABEL: Record<BillStatus, string> = {
  DRAFT: "Draft",
  WITH_ACCOUNTANT: "With Accountant",
  WITH_FINANCE_HEAD: "With Finance Head",
  APPROVED: "Ready to pay",
  PAID: "Paid",
  REJECTED: "Rejected",
};

export type DocKind = "INVOICE" | "COMPLETION_PROOF" | "WORK_ORDER" | "OTHER";
export type FinDoc = { id: string; kind: DocKind; title: string; source: string; addedBy: string; addedAt: string };

export type Bill = {
  id: string;
  projectId: string;
  vendorId: string;
  type: BillType;
  category: Category;
  workOrderId: string | null;
  shed: string | null;
  /** What the payee asked for. Never changed after submission. */
  submittedAmount: number;
  /** Amount after review; null until someone sets a different figure. */
  finalAmount: number | null;
  amountReason: string | null;
  amountEditedBy: Stamp | null;
  /** Advance already paid against this bill's work order, deducted at payment. */
  advanceId: string | null;
  advanceDeduction: number;
  /** Acceptance of the completed work by the AVP — recorded outside Finance. */
  workAccepted: boolean;
  billDate: string;
  dueDate: string;
  status: BillStatus;
  createdBy: Stamp;
  submittedBy: Stamp | null;
  checkedBy: Stamp | null;
  approvedBy: Stamp | null;
  paidBy: Stamp | null;
  payment: { date: string; reference: string; ledgerId: string } | null;
  rejectedReason: string | null;
  overBudget: boolean;
  docs: FinDoc[];
  history: HistoryEntry[];
};

export type ReceiptStatus = "CLAIMED" | "VERIFIED" | "RETURNED";
export type Receipt = {
  id: string;
  projectId: string;
  from: string;
  purpose: string;
  amount: number;
  receivedOn: string;
  reference: string | null;
  instalmentNo: number | null;
  enteredBy: Stamp;
  bankLineId: string | null;
  linkedBy: Stamp | null;
  verifiedBy: Stamp | null;
  returnedReason: string | null;
  ledgerId: string | null;
  status: ReceiptStatus;
  history: HistoryEntry[];
};

export type Instalment = { projectId: string; no: number; purpose: string; dueNote: string; receiptId: string | null };

export type BudgetLine = { projectId: string; category: Category; amount: number };
export type BudgetRequestStatus = "PENDING" | "APPROVED" | "REJECTED";
export type BudgetRequest = {
  id: string;
  projectId: string;
  category: Category;
  current: number;
  proposed: number;
  reason: string;
  requestedBy: Stamp;
  status: BudgetRequestStatus;
  /** Total budget after the change would exceed the scheme sanction: Management must decide. */
  exceedsSanction: boolean;
  decidedBy: Stamp | null;
  decisionNote: string | null;
};

export type AdvanceStatus = "PENDING_APPROVAL" | "OPEN" | "PARTLY_ADJUSTED" | "CLEARED" | "REJECTED";
export type AdvanceAdjustment = {
  id: string;
  kind: "AGAINST_BILL" | "EXPENSE_SETTLED" | "CASH_RETURNED";
  amount: number;
  note: string;
  billId: string | null;
  ledgerId: string | null;
  by: Stamp;
};
export type Advance = {
  id: string;
  projectId: string;
  givenTo: string;
  vendorId: string | null;
  workOrderId: string | null;
  category: Category;
  purpose: string;
  amount: number;
  givenOn: string;
  requestedBy: Stamp;
  approvedBy: Stamp | null;
  ledgerId: string | null;
  status: AdvanceStatus;
  adjustments: AdvanceAdjustment[];
  history: HistoryEntry[];
};

export type LedgerKind = "RECEIPT" | "PAYMENT" | "ADVANCE" | "RECOVERY" | "REVERSAL" | "JOURNAL" | "BANK_CHARGE";
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  RECEIPT: "Receipt",
  PAYMENT: "Payment",
  ADVANCE: "Advance",
  RECOVERY: "Recovery",
  REVERSAL: "Reversal",
  JOURNAL: "Journal",
  BANK_CHARGE: "Bank charge",
};

/**
 * One line in the books. Single-entry against the bank account (or no bank effect for
 * journals): "IN" is money into the account, "OUT" money out. A full double-entry chart
 * of accounts is a Finance-team decision still pending.
 */
export type LedgerEntry = {
  id: string;
  ref: string;
  date: string;
  kind: LedgerKind;
  direction: "IN" | "OUT";
  amount: number;
  projectId: string;
  category: Category | null;
  description: string;
  accountId: string | null;
  instalmentNo: number | null;
  workOrderId: string | null;
  source: { type: "BILL" | "RECEIPT" | "ADVANCE" | "VOUCHER"; id: string } | null;
  reversesId: string | null;
  reversedById: string | null;
  bankLineId: string | null;
  createdBy: Stamp;
};

export type VoucherType = "RECEIPT" | "PAYMENT" | "JOURNAL" | "ADVANCE" | "REVERSAL";
export const VOUCHER_TYPES: { key: VoucherType; label: string; prefix: string }[] = [
  { key: "PAYMENT", label: "Payment voucher", prefix: "PMV" },
  { key: "RECEIPT", label: "Receipt voucher", prefix: "RCV" },
  { key: "JOURNAL", label: "Journal voucher", prefix: "JV" },
  { key: "ADVANCE", label: "Advance voucher", prefix: "ADV" },
  { key: "REVERSAL", label: "Reversal voucher", prefix: "RVV" },
];
export type VoucherStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "POSTED";
export type Voucher = {
  id: string;
  type: VoucherType;
  date: string;
  projectId: string;
  category: Category | null;
  /** Journal only: the category the amount moves out of. */
  fromCategory: Category | null;
  description: string;
  amount: number;
  related: string | null;
  reversesLedgerId: string | null;
  bankLineId: string | null;
  docs: { title: string; note: string }[];
  status: VoucherStatus;
  createdBy: Stamp;
  approvedBy: Stamp | null;
  postedBy: Stamp | null;
  rejectedReason: string | null;
  ledgerIds: string[];
  overBudget: boolean;
  history: HistoryEntry[];
};

export type BankLineClass = "NONE" | "BANK_CHARGE" | "INTEREST";
export type BankLine = {
  id: string;
  accountId: string;
  month: string;
  date: string;
  description: string;
  reference: string;
  /** Signed: credits positive, debits negative. */
  amount: number;
  ledgerId: string | null;
  /** A claimed receipt confirmed against this line, waiting for second-person verification. */
  receiptId: string | null;
  classification: BankLineClass;
  explanation: { note: string; by: Stamp } | null;
  matchedBy: Stamp | null;
};

export type StatementUpload = { accountId: string; month: string; lines: number; by: Stamp; fileName: string };
export type MonthClose = {
  month: string;
  signedOffBy: Stamp | null;
  lockedBy: Stamp | null;
  reopened: { by: Stamp; reason: string }[];
};

export type FinAudit = { at: string; actorId: string; actorName: string; action: string; target: string; text: string };

export type FinanceState = {
  projects: Project[];
  vendors: Vendor[];
  accounts: BankAccount[];
  workOrders: WorkOrder[];
  bills: Bill[];
  receipts: Receipt[];
  instalments: Instalment[];
  budgets: BudgetLine[];
  budgetRequests: BudgetRequest[];
  advances: Advance[];
  ledger: LedgerEntry[];
  vouchers: Voucher[];
  bankLines: BankLine[];
  uploads: StatementUpload[];
  closes: MonthClose[];
  audit: FinAudit[];
  seq: Record<string, number>;
};
