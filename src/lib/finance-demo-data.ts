import {
  adjustAdvance,
  approveBill,
  attachDoc,
  classifyLine,
  createBill,
  createVoucher,
  decideAdvance,
  decideVoucher,
  editAmount,
  emptyState,
  linkLine,
  linkReceipt,
  lockMonth,
  markPaid,
  postVoucher,
  recordReceipt,
  rejectBill,
  requestAdvance,
  requestBudget,
  returnReceipt,
  signOff,
  submitBill,
  submitVoucher,
  uploadStatement,
  verifyReceipt,
  type Ctx,
  type StatementLineInput,
} from "./finance-rules";
import { monthKey } from "./finance-format";
import type { Actor, BillType, Category, DocKind, FinanceState, LedgerEntry } from "./finance-types";

// SAMPLE DATA ONLY. Two projects, June–November 2026, built by replaying what Finance
// would have done through the real rule functions (finance-rules.ts). Because every row
// is produced by the same rules the screens use, totals, counts and checklists agree by
// construction — nothing here is a hard-coded KPI. Names are roles, not real people.

export const DEMO_PERSONAS: Record<string, Actor> = {
  accountant: { id: "demo-accountant", name: "Accountant", role: "ACCOUNTANT", isSuper: false },
  assistant: { id: "demo-accounts-assistant", name: "Accounts assistant", role: "ACCOUNTANT", isSuper: false },
  head: { id: "demo-finance-head", name: "Finance Head", role: "FINANCE_HEAD", isSuper: false },
  field: { id: "demo-field-officer", name: "Field officer", role: "FIELD", isSuper: false },
  superAdmin: { id: "demo-super-admin", name: "Super Admin", role: "MANAGEMENT", isSuper: true },
};

const P = DEMO_PERSONAS;
const AJAH = "ajah";
const BHOR = "bhor";
const HDFC = "hdfc";

/** India time → ISO instant. */
const at = (date: string, time = "10:00") => new Date(`${date}T${time}:00+05:30`).toISOString();
const as = (actor: Actor, date: string, time?: string): Ctx => ({ actor, now: at(date, time) });

function seed(): FinanceState {
  const s = emptyState();
  s.projects = [
    { id: AJAH, name: "Project AJAH", scheme: "State livestock shed scheme — cluster AJ", sanctioned: 5000000 },
    { id: BHOR, name: "Project BHOR", scheme: "State livestock shed scheme — cluster BH", sanctioned: 1000000 },
  ];
  s.vendors = [
    { id: "fab-a", name: "Fabricator A" },
    { id: "fab-b", name: "Fabricator B" },
    { id: "fab-c", name: "Fabricator C" },
    { id: "feeder", name: "Feeder tray supplier" },
    { id: "camera", name: "Camera installer" },
    { id: "transport", name: "Transport vendor" },
    { id: "paint", name: "Paint supplier" },
    { id: "cement", name: "Cement and steel traders" },
    { id: "lights", name: "Light fittings supplier" },
    { id: "vendor9", name: "Vendor 9" },
  ];
  s.accounts = [
    { id: HDFC, name: "HDFC current account", bank: "HDFC Bank", last4: "4821" },
    { id: "sbi", name: "SBI collections account", bank: "State Bank of India", last4: "1192" },
  ];
  const wo = (id: string, projectId: string, vendorId: string, category: Category, description: string, shed: string | null, amount: number, instalmentNo: number, placedOn: string) => ({
    id,
    projectId,
    vendorId,
    category,
    description,
    shed,
    amount,
    approved: true,
    closed: false,
    instalmentNo,
    placedOn,
  });
  s.workOrders = [
    wo("WO-0071", AJAH, "fab-a", "FABRICATOR", "Sheds, first batch", "AJ-0071", 1000000, 1, "2026-09-15"),
    wo("WO-0079", AJAH, "fab-c", "FABRICATOR", "Sheds, first batch (east)", "AJ-0079", 550000, 1, "2026-09-16"),
    wo("WO-0083", AJAH, "cement", "MATERIALS", "Cement and steel, first batch", null, 480000, 1, "2026-09-18"),
    wo("WO-0084", AJAH, "camera", "CAMERA_LIGHT", "Cameras and lights, first batch", null, 240000, 1, "2026-09-20"),
    wo("WO-0087", AJAH, "fab-a", "FABRICATOR", "Sheds, second batch", "AJ-0087", 520000, 2, "2026-10-31"),
    wo("WO-0091", AJAH, "fab-b", "FABRICATOR", "Sheds, second batch (west)", "AJ-0091", 260000, 2, "2026-10-31"),
    wo("WO-0093", AJAH, "feeder", "MATERIALS", "Feeder trays, second batch", null, 180000, 2, "2026-10-31"),
    wo("WO-0095", AJAH, "camera", "CAMERA_LIGHT", "Cameras, second batch (4 sheds)", null, 120000, 2, "2026-10-31"),
    wo("WO-0101", BHOR, "fab-c", "FABRICATOR", "Sheds, cluster BH", "BH-0101", 300000, 1, "2026-09-05"),
  ];
  s.instalments = [
    { projectId: AJAH, no: 1, purpose: "for the first batch of sheds", dueNote: "", receiptId: null },
    { projectId: AJAH, no: 2, purpose: "for the second batch and cameras", dueNote: "", receiptId: null },
    { projectId: AJAH, no: 3, purpose: "", dueNote: "Due after utilisation of instalment 2 is accepted", receiptId: null },
    { projectId: BHOR, no: 1, purpose: "for cluster BH sheds", dueNote: "", receiptId: null },
    { projectId: BHOR, no: 2, purpose: "", dueNote: "Due after utilisation of instalment 1 is accepted", receiptId: null },
  ];
  s.budgets = [
    { projectId: AJAH, category: "FABRICATOR", amount: 2600000 },
    { projectId: AJAH, category: "MATERIALS", amount: 1150000 },
    { projectId: AJAH, category: "CAMERA_LIGHT", amount: 450000 },
    { projectId: AJAH, category: "TRANSPORT", amount: 135000 },
    { projectId: AJAH, category: "ADMIN_OTHER", amount: 25000 },
    { projectId: BHOR, category: "FABRICATOR", amount: 400000 },
    { projectId: BHOR, category: "MATERIALS", amount: 150000 },
    { projectId: BHOR, category: "TRANSPORT", amount: 50000 },
    { projectId: BHOR, category: "ADMIN_OTHER", amount: 10000 },
  ];
  // IDs continue from the numbering Finance already uses.
  s.seq = { PM: 169, RV: 6, PMV: 30, JV: 11, LE: 0 };
  return s;
}

const setNextId = (s: FinanceState, prefix: string, n: number) => {
  s.seq[prefix] = n - 1;
};

// ---------- bill helper: enter → attach → submit → check → approve → pay ----------

type Step = [date: string, time?: string];
type BillPlan = {
  no: number;
  project: string;
  vendor: string;
  type: BillType;
  category: Category;
  wo: string | null;
  amount: number;
  billDate: string;
  due: string;
  docs?: DocKind[];
  accepted?: boolean;
  submit?: Step;
  check?: Step;
  approve?: Step;
  pay?: Step;
};

let utr = 7100;
const nextUtr = () => `N${++utr}`;

function bill(s: FinanceState, b: BillPlan): string {
  setNextId(s, "BL", b.no);
  const vendor = s.vendors.find((v) => v.id === b.vendor)?.name ?? "Vendor";
  const made = createBill(s, as(P.assistant, b.billDate, "11:00"), {
    projectId: b.project,
    vendorId: b.vendor,
    type: b.type,
    category: b.category,
    workOrderId: b.wo,
    amount: b.amount,
    billDate: b.billDate,
    dueDate: b.due,
  });
  const docs = b.docs ?? (b.wo ? ["INVOICE", "COMPLETION_PROOF", "WORK_ORDER"] : ["INVOICE"]);
  for (const kind of docs) {
    const title = kind === "INVOICE" ? `${vendor} invoice.pdf` : kind === "COMPLETION_PROOF" ? "Completion photos" : kind === "WORK_ORDER" ? `Work order ${b.wo}` : "Supporting note";
    attachDoc(s, as(P.assistant, b.billDate, "11:05"), { billId: made.id, kind, title });
    const doc = made.docs[made.docs.length - 1];
    doc.source = kind === "INVOICE" ? "Documents" : kind === "COMPLETION_PROOF" ? `Shed ${made.shed ?? "site"} record` : kind === "WORK_ORDER" ? "Work orders" : "Documents";
  }
  // AVP acceptance of the work is recorded by Operations, outside Finance.
  made.workAccepted = b.accepted ?? true;
  const sub = b.submit ?? [b.billDate, "11:10"];
  submitBill(s, as(P.assistant, sub[0], sub[1]), { billId: made.id });
  if (b.check) approveBill(s, as(P.accountant, b.check[0], b.check[1] ?? "11:20"), { billId: made.id });
  if (b.approve) approveBill(s, as(P.head, b.approve[0], b.approve[1] ?? "15:00"), { billId: made.id });
  if (b.pay) markPaid(s, as(P.accountant, b.pay[0], b.pay[1] ?? "12:00"), { billId: made.id, date: b.pay[0], reference: nextUtr() });
  return made.id;
}

function receipt(
  s: FinanceState,
  no: number,
  who: Actor,
  entered: Step,
  r: { project: string; from: string; purpose: string; amount: number; on: string; ref: string | null; inst?: number },
) {
  setNextId(s, "RC", no);
  return recordReceipt(s, as(who, entered[0], entered[1]), {
    projectId: r.project,
    from: r.from,
    purpose: r.purpose,
    amount: r.amount,
    receivedOn: r.on,
    reference: r.ref,
    instalmentNo: r.inst ?? null,
  });
}

function voucherFlow(
  s: FinanceState,
  v: { type: "PAYMENT"; date: string; project: string; category: Category; description: string; amount: number; bankLineId?: string | null },
  steps: { create: Step; approve: Step },
) {
  const made = createVoucher(s, as(P.accountant, steps.create[0], steps.create[1]), {
    type: v.type,
    date: v.date,
    projectId: v.project,
    category: v.category,
    fromCategory: null,
    description: v.description,
    amount: v.amount,
    related: null,
    reversesLedgerId: null,
    bankLineId: v.bankLineId ?? null,
    docs: [{ title: "Bill or bank advice (scan)", note: "" }],
  });
  submitVoucher(s, as(P.accountant, steps.create[0], steps.create[1]), { voucherId: made.id });
  decideVoucher(s, as(P.head, steps.approve[0], steps.approve[1]), { voucherId: made.id, approve: true, note: "" });
  postVoucher(s, as(P.head, steps.approve[0], steps.approve[1]), { voucherId: made.id });
  return made;
}

// ---------- bank statements ----------

const describe = (s: FinanceState, e: LedgerEntry) => {
  if (e.kind === "REVERSAL") return "Payment returned by bank";
  const bill = e.source?.type === "BILL" ? s.bills.find((b) => b.id === e.source?.id) : undefined;
  const party = bill ? s.vendors.find((v) => v.id === bill.vendorId)?.name : e.description.split(",")[0];
  return `${e.direction === "IN" ? "NEFT credit" : "NEFT debit"}, ${party}`;
};

/**
 * Upload the month's statement: one line per book entry still waiting for the bank, plus the
 * given extra lines (credits for receipts, charges, deposits). Book entries are matched by a
 * person straight after, the way the Accountant would tick them off.
 */
function statement(s: FinanceState, month: string, when: Step, extra: StatementLineInput[], opts: { matchBooks?: boolean } = {}) {
  const books = s.ledger.filter((e) => e.accountId === HDFC && monthKey(e.date) === month && !e.bankLineId);
  const fromBooks = books.map((e) => ({ entry: e, line: { date: e.date, description: describe(s, e), reference: `UTR …${7700 + Number(e.id.slice(3))}`, amount: e.direction === "IN" ? e.amount : -e.amount } }));
  uploadStatement(s, as(P.accountant, when[0], when[1]), { accountId: HDFC, month, fileName: `HDFC-${month}.csv`, lines: [...fromBooks.map((x) => x.line), ...extra] });
  if (opts.matchBooks === false) return;
  for (const { entry, line } of fromBooks) {
    const l = s.bankLines.find((x) => x.reference === line.reference && x.date === line.date);
    if (l) linkLine(s, as(P.accountant, when[0], when[1]), { lineId: l.id, targetType: "LEDGER", targetId: entry.id });
  }
}

function lineFor(s: FinanceState, reference: string) {
  const l = s.bankLines.find((x) => x.reference === reference);
  if (!l) throw new Error(`demo data: no bank line ${reference}`);
  return l;
}

/** Accountant matches the credit, a second person verifies (verifier ≠ the person who entered it). */
function matchAndVerify(s: FinanceState, receiptId: string, reference: string, when: Step, verifier: Actor) {
  linkReceipt(s, as(P.accountant, when[0], when[1]), { receiptId, bankLineId: lineFor(s, reference).id });
  verifyReceipt(s, as(verifier, when[0], when[1]), { receiptId });
}

function close(s: FinanceState, month: string, when: Step) {
  signOff(s, as(P.head, when[0], when[1]), { accountId: HDFC, month });
  lockMonth(s, as(P.head, when[0], when[1]), { accountId: HDFC, month });
}

const credit = (date: string, description: string, reference: string, amount: number): StatementLineInput => ({ date, description, reference, amount });

export function buildDemoState(): FinanceState {
  utr = 7100;
  const s = seed();
  const ben = (purpose: string, amount: number, on: string, ref: string, project = AJAH) => ({ project, from: "Beneficiary share", purpose, amount, on, ref });

  // ---- June – August: beneficiary contributions, BH instalment 1 ----
  receipt(s, 201, P.field, ["2026-06-12", "17:00"], ben("Contribution, 5 sheds", 150000, "2026-06-12", "UPI-0612"));
  statement(s, "2026-06", ["2026-07-03"], [credit("2026-06-12", "UPI credit, field collection", "UPI-0612", 150000)]);
  matchAndVerify(s, "RC-0201", "UPI-0612", ["2026-07-03", "11:00"], P.accountant);
  close(s, "2026-06", ["2026-07-04"]);

  receipt(s, 204, P.field, ["2026-07-10", "17:00"], ben("Contribution, 4 sheds", 125000, "2026-07-10", "UPI-0710"));
  statement(s, "2026-07", ["2026-08-03"], [credit("2026-07-10", "UPI credit, field collection", "UPI-0710", 125000)]);
  matchAndVerify(s, "RC-0204", "UPI-0710", ["2026-08-03", "11:00"], P.accountant);
  close(s, "2026-07", ["2026-08-04"]);

  receipt(s, 207, P.field, ["2026-08-08", "17:00"], ben("Contribution, 3 sheds", 100000, "2026-08-08", "UPI-0808"));
  receipt(s, 209, P.accountant, ["2026-08-20", "16:00"], { project: BHOR, from: "Scheme department", purpose: "Instalment 1", amount: 800000, on: "2026-08-20", ref: "UTR-0820", inst: 1 });
  statement(s, "2026-08", ["2026-08-21"], [credit("2026-08-20", "NEFT credit, scheme department", "UTR-0820", 800000)]);
  matchAndVerify(s, "RC-0209", "UTR-0820", ["2026-08-21", "11:00"], P.head);
  statement(s, "2026-08", ["2026-09-03"], [credit("2026-08-08", "UPI credit, field collection", "UPI-0808", 100000), credit("2026-08-20", "NEFT credit, scheme department", "UTR-0820", 800000)]);
  matchAndVerify(s, "RC-0207", "UPI-0808", ["2026-09-03", "11:00"], P.accountant);
  close(s, "2026-08", ["2026-09-04"]);

  // ---- September: AJ instalment 1, first batch ----
  bill(s, { no: 377, project: BHOR, vendor: "transport", type: "EXPENSE", category: "TRANSPORT", wo: null, amount: 20000, billDate: "2026-09-08", due: "2026-09-15", check: ["2026-09-09"], approve: ["2026-09-09", "16:00"], pay: ["2026-09-10"] });
  receipt(s, 211, P.accountant, ["2026-09-14", "16:00"], { project: AJAH, from: "Scheme department", purpose: "Instalment 1", amount: 2400000, on: "2026-09-14", ref: "UTR-0914", inst: 1 });
  statement(s, "2026-09", ["2026-09-15", "09:30"], [credit("2026-09-14", "NEFT credit, scheme department", "UTR-0914", 2400000)], { matchBooks: false });
  matchAndVerify(s, "RC-0211", "UTR-0914", ["2026-09-15", "11:00"], P.head);

  setNextId(s, "AD", 28);
  const ad28 = requestAdvance(s, as(P.accountant, "2026-09-17", "10:00"), { projectId: AJAH, givenTo: "Fabricator C", vendorId: "fab-c", workOrderId: "WO-0079", category: "FABRICATOR", purpose: "Mobilisation for WO-0079", amount: 60000, givenOn: "2026-09-17" });
  decideAdvance(s, as(P.head, "2026-09-17", "12:00"), { advanceId: ad28.id, approve: true, note: "" });

  voucherFlow(s, { type: "PAYMENT", date: "2026-09-22", project: AJAH, category: "ADMIN_OTHER", description: "Site office stationery and registers", amount: 5910 }, { create: ["2026-09-22", "10:00"], approve: ["2026-09-22", "15:00"] });

  bill(s, { no: 371, project: AJAH, vendor: "fab-a", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0071", amount: 400000, billDate: "2026-09-25", due: "2026-10-02", check: ["2026-09-26"], approve: ["2026-09-27"], pay: ["2026-09-30"] });
  bill(s, { no: 374, project: AJAH, vendor: "transport", type: "EXPENSE", category: "TRANSPORT", wo: null, amount: 48000, billDate: "2026-09-26", due: "2026-10-03", check: ["2026-09-27"], approve: ["2026-09-28"], pay: ["2026-10-01"] });
  bill(s, { no: 378, project: AJAH, vendor: "cement", type: "VENDOR_INVOICE", category: "MATERIALS", wo: "WO-0083", amount: 240000, billDate: "2026-09-28", due: "2026-10-05", check: ["2026-09-29"], approve: ["2026-09-30"], pay: ["2026-10-02"] });
  bill(s, { no: 385, project: AJAH, vendor: "fab-c", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0079", amount: 213000, billDate: "2026-09-30", due: "2026-10-07", check: ["2026-10-01"], approve: ["2026-10-02"], pay: ["2026-10-05"] });

  statement(s, "2026-09", ["2026-10-06", "10:00"], [credit("2026-09-14", "NEFT credit, scheme department", "UTR-0914", 2400000), credit("2026-09-30", "Bank charges", "CHG-0930", -590)]);
  const sepCharge = lineFor(s, "CHG-0930");
  classifyLine(s, as(P.accountant, "2026-10-06", "10:30"), { lineId: sepCharge.id, classification: "BANK_CHARGE" });
  voucherFlow(s, { type: "PAYMENT", date: "2026-09-30", project: AJAH, category: "ADMIN_OTHER", description: "September bank charges", amount: 590, bankLineId: sepCharge.id }, { create: ["2026-10-06", "10:40"], approve: ["2026-10-06", "12:00"] });
  close(s, "2026-09", ["2026-10-06", "16:00"]);

  // ---- October ----
  receipt(s, 214, P.accountant, ["2026-10-04", "11:00"], { project: AJAH, from: "Unknown sender", purpose: "Could not identify", amount: 40000, on: "2026-10-03", ref: "DEP-6618" });
  bill(s, { no: 380, project: AJAH, vendor: "fab-a", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0071", amount: 300000, billDate: "2026-10-08", due: "2026-10-15", check: ["2026-10-09"], approve: ["2026-10-10"], pay: ["2026-10-12"] });
  const rent = voucherFlow(s, { type: "PAYMENT", date: "2026-10-09", project: AJAH, category: "ADMIN_OTHER", description: "Site office rent, October", amount: 8500 }, { create: ["2026-10-09", "09:30"], approve: ["2026-10-09", "12:00"] });
  bill(s, { no: 386, project: AJAH, vendor: "camera", type: "INSTALLATION_BILL", category: "CAMERA_LIGHT", wo: "WO-0084", amount: 240000, billDate: "2026-10-10", due: "2026-10-17", check: ["2026-10-11"], approve: ["2026-10-13"], pay: ["2026-10-16"] });
  // The bank returned the rent (wrong account number): reverse it, then pay again correctly.
  setNextId(s, "RVV", 3);
  const rv = createVoucher(s, as(P.accountant, "2026-10-13", "10:00"), {
    type: "REVERSAL",
    date: "2026-10-13",
    projectId: AJAH,
    category: null,
    fromCategory: null,
    description: "Bank returned the rent payment — wrong account number",
    amount: 8500,
    related: rent.id,
    reversesLedgerId: rent.ledgerIds[0],
    bankLineId: null,
    docs: [{ title: "Bank return advice", note: "" }],
  });
  submitVoucher(s, as(P.accountant, "2026-10-13", "10:00"), { voucherId: rv.id });
  decideVoucher(s, as(P.head, "2026-10-13", "12:00"), { voucherId: rv.id, approve: true, note: "" });
  postVoucher(s, as(P.head, "2026-10-13", "12:00"), { voucherId: rv.id });
  voucherFlow(s, { type: "PAYMENT", date: "2026-10-15", project: AJAH, category: "ADMIN_OTHER", description: "Site office rent, October (paid again, correct account)", amount: 8500 }, { create: ["2026-10-15", "09:30"], approve: ["2026-10-15", "11:00"] });

  bill(s, { no: 388, project: AJAH, vendor: "transport", type: "EXPENSE", category: "TRANSPORT", wo: null, amount: 52000, billDate: "2026-10-14", due: "2026-10-21", check: ["2026-10-15"], approve: ["2026-10-16"], pay: ["2026-10-18"] });
  bill(s, { no: 389, project: AJAH, vendor: "cement", type: "VENDOR_INVOICE", category: "MATERIALS", wo: "WO-0083", amount: 240000, billDate: "2026-10-15", due: "2026-10-22", check: ["2026-10-16"], approve: ["2026-10-17"], pay: ["2026-10-20"] });
  receipt(s, 216, P.field, ["2026-10-12", "17:00"], ben("Contribution, 2 sheds", 60000, "2026-10-12", "UPI-1012", BHOR));
  bill(s, { no: 393, project: BHOR, vendor: "fab-c", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0101", amount: 150000, billDate: "2026-10-18", due: "2026-10-25", check: ["2026-10-19"], approve: ["2026-10-20"], pay: ["2026-10-22"] });

  setNextId(s, "AD", 33);
  const ad33 = requestAdvance(s, as(P.accountant, "2026-10-20", "09:00"), { projectId: AJAH, givenTo: "Site team travel", vendorId: null, workOrderId: null, category: "TRANSPORT", purpose: "Travel for shed inspections", amount: 15000, givenOn: "2026-10-20" });
  decideAdvance(s, as(P.head, "2026-10-20", "10:00"), { advanceId: ad33.id, approve: true, note: "" });

  bill(s, { no: 390, project: AJAH, vendor: "fab-a", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0071", amount: 300000, billDate: "2026-10-20", due: "2026-10-27", check: ["2026-10-21"], approve: ["2026-10-22"], pay: ["2026-10-24"] });
  bill(s, { no: 391, project: AJAH, vendor: "fab-c", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0079", amount: 125000, billDate: "2026-10-22", due: "2026-10-29", check: ["2026-10-23"], approve: ["2026-10-24"], pay: ["2026-10-27"] });

  const b396 = bill(s, { no: 396, project: AJAH, vendor: "vendor9", type: "EXPENSE", category: "ADMIN_OTHER", wo: null, amount: 9800, billDate: "2026-10-25", due: "2026-11-01", docs: [] });
  rejectBill(s, as(P.accountant, "2026-10-27", "11:00"), { billId: b396, reason: "No invoice from the vendor" });

  bill(s, { no: 403, project: AJAH, vendor: "paint", type: "VENDOR_INVOICE", category: "MATERIALS", wo: null, amount: 21750, billDate: "2026-10-26", due: "2026-11-02", check: ["2026-10-28"], approve: ["2026-10-31", "16:00"] });
  receipt(s, 222, P.field, ["2026-10-29", "09:00"], ben("Contribution, 6 sheds", 210000, "2026-10-28", "UPI-1192"));
  receipt(s, 219, P.accountant, ["2026-10-30", "10:00"], { project: AJAH, from: "Vendor refund", purpose: "Returned excess payment", amount: 25000, on: "2026-10-29", ref: "UTR-3305" });
  adjustAdvance(s, as(P.accountant, "2026-10-31", "10:00"), { advanceId: ad33.id, kind: "EXPENSE_SETTLED", amount: 9200, note: "Bus fares and fuel, receipts filed" });

  // AJ instalment 2
  receipt(s, 218, P.accountant, ["2026-10-30", "16:00"], { project: AJAH, from: "Scheme department", purpose: "Instalment 2", amount: 2085000, on: "2026-10-30", ref: "UTR-4821", inst: 2 });
  statement(s, "2026-10", ["2026-10-31", "10:00"], [credit("2026-10-30", "NEFT credit, scheme department", "UTR-4821", 2085000)], { matchBooks: false });
  matchAndVerify(s, "RC-0218", "UTR-4821", ["2026-10-31", "11:30"], P.head);

  bill(s, { no: 408, project: AJAH, vendor: "fab-b", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0091", amount: 60000, billDate: "2026-10-31", due: "2026-11-07", check: ["2026-11-01", "10:30"], approve: ["2026-11-02", "11:00"], pay: ["2026-11-03", "09:30"] });
  bill(s, { no: 409, project: AJAH, vendor: "fab-c", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0079", amount: 152000, billDate: "2026-10-31", due: "2026-11-05", check: ["2026-11-01", "10:40"], approve: ["2026-11-01", "16:00"] });
  bill(s, { no: 410, project: AJAH, vendor: "feeder", type: "VENDOR_INVOICE", category: "MATERIALS", wo: "WO-0093", amount: 90000, billDate: "2026-10-31", due: "2026-11-07", check: ["2026-11-01", "10:50"], approve: ["2026-11-01", "16:10"], pay: ["2026-11-01", "17:00"] });

  // ---- 1 November: October statement (close in progress) ----
  statement(s, "2026-10", ["2026-11-01", "10:00"], [
    credit("2026-10-03", "Cash deposit", "DEP …6618", 40000),
    credit("2026-10-12", "UPI credit, field collection", "UPI-1012", 60000),
    credit("2026-10-28", "UPI credit, field collection", "UPI …1192", 210000),
    credit("2026-10-29", "NEFT credit, vendor refund", "UTR …3305", 25000),
    credit("2026-10-30", "NEFT credit, scheme department", "UTR-4821", 2085000),
    credit("2026-10-31", "Bank charges", "CHG …0031", -1180),
  ]);
  matchAndVerify(s, "RC-0216", "UPI-1012", ["2026-11-01", "10:30"], P.accountant);

  // ---- 1 – 3 November: live work ----
  bill(s, { no: 406, project: AJAH, vendor: "transport", type: "EXPENSE", category: "TRANSPORT", wo: null, amount: 14500, billDate: "2026-11-01", due: "2026-11-06", check: ["2026-11-01", "15:00"], approve: ["2026-11-02", "10:30"] });
  bill(s, { no: 415, project: AJAH, vendor: "fab-b", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0091", amount: 92400, billDate: "2026-11-01", due: "2026-11-09", accepted: false, submit: ["2026-11-01", "15:30"] });
  bill(s, { no: 418, project: AJAH, vendor: "feeder", type: "VENDOR_INVOICE", category: "MATERIALS", wo: null, amount: 64800, billDate: "2026-11-01", due: "2026-11-10", docs: [], submit: ["2026-11-01", "16:00"] });
  bill(s, { no: 420, project: BHOR, vendor: "fab-c", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0101", amount: 100000, billDate: "2026-11-01", due: "2026-11-10", submit: ["2026-11-01", "16:30"] });

  setNextId(s, "AD", 31);
  const ad31 = requestAdvance(s, as(P.accountant, "2026-11-02", "09:30"), { projectId: AJAH, givenTo: "Fabricator A", vendorId: "fab-a", workOrderId: "WO-0087", category: "FABRICATOR", purpose: "Mobilisation for WO-0087", amount: 40000, givenOn: "2026-11-02" });
  decideAdvance(s, as(P.head, "2026-11-02", "10:00"), { advanceId: ad31.id, approve: true, note: "" });
  markPaid(s, as(P.accountant, "2026-11-02", "12:00"), { billId: "BL-0403", date: "2026-11-02", reference: nextUtr() });
  returnReceipt(s, as(P.head, "2026-11-02", "11:00"), { receiptId: "RC-0214", reason: "Sender could not be identified (cash deposit, HDFC 3 Oct)" });
  receipt(s, 223, P.field, ["2026-11-02", "17:30"], ben("Contribution, 4 sheds", 140000, "2026-11-02", "UPI-1102"));

  bill(s, { no: 421, project: AJAH, vendor: "camera", type: "INSTALLATION_BILL", category: "CAMERA_LIGHT", wo: "WO-0095", amount: 38500, billDate: "2026-11-02", due: "2026-11-10", submit: ["2026-11-02", "12:30"] });
  bill(s, { no: 424, project: AJAH, vendor: "transport", type: "EXPENSE", category: "TRANSPORT", wo: null, amount: 12300, billDate: "2026-11-02", due: "2026-11-12", submit: ["2026-11-02", "09:10"], check: ["2026-11-02", "15:00"] });
  bill(s, { no: 412, project: AJAH, vendor: "fab-a", type: "FABRICATOR_BILL", category: "FABRICATOR", wo: "WO-0087", amount: 186000, billDate: "2026-11-02", due: "2026-11-08", submit: ["2026-11-02", "16:10"], check: ["2026-11-03", "11:20"] });
  editAmount(s, as(P.superAdmin, "2026-11-03", "14:05"), { billId: "BL-0412", amount: 179500, reason: "Rework on the shed floor" });

  // Drafts and pending decisions left for the team.
  const draft = (no: number, vendor: string, type: BillType, category: Category, wo: string | null, amount: number) => {
    setNextId(s, "BL", no);
    createBill(s, as(P.assistant, "2026-11-03", "09:45"), { projectId: AJAH, vendorId: vendor, type, category, workOrderId: wo, amount, billDate: "2026-11-03", dueDate: "2026-11-17" });
  };
  draft(425, "lights", "VENDOR_INVOICE", "CAMERA_LIGHT", null, 27600);
  draft(426, "fab-b", "FABRICATOR_BILL", "FABRICATOR", "WO-0091", 107600);

  const net = createVoucher(s, as(P.accountant, "2026-11-02", "15:30"), {
    type: "PAYMENT",
    date: "2026-11-02",
    projectId: AJAH,
    category: "ADMIN_OTHER",
    fromCategory: null,
    description: "Internet and phone, site office (October)",
    amount: 5410,
    related: null,
    reversesLedgerId: null,
    bankLineId: null,
    docs: [{ title: "Telecom bill, October", note: "" }],
  });
  submitVoucher(s, as(P.accountant, "2026-11-02", "15:31"), { voucherId: net.id });
  createVoucher(s, as(P.accountant, "2026-11-03", "09:50"), {
    type: "JOURNAL",
    date: "2026-11-03",
    projectId: AJAH,
    category: "MATERIALS",
    fromCategory: "TRANSPORT",
    description: "Tarpaulin booked under transport belongs to materials",
    amount: 3200,
    related: "BL-0388",
    reversesLedgerId: null,
    bankLineId: null,
    docs: [],
  });
  requestBudget(s, as(P.accountant, "2026-11-03", "10:00"), { projectId: AJAH, category: "TRANSPORT", proposed: 160000, reason: "Second batch of sheds needs two more truck trips" });

  // New IDs continue after the highest used.
  for (const [prefix, rows] of Object.entries({ BL: s.bills, RC: s.receipts, AD: s.advances })) {
    const max = rows.reduce((m, r) => Math.max(m, Number(r.id.split("-")[1])), 0);
    s.seq[prefix] = Math.max(s.seq[prefix] ?? 0, max);
  }
  return s;
}

/** The moment the sample history ends; the screens show "today" from the real clock. */
export const DEMO_AS_OF = at("2026-11-03", "14:10");
