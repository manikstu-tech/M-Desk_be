import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import type { AuthSession } from "@/lib/authorize";
import { ApiError } from "@/lib/validation";
import { financeAccess, requireFinance, runFinanceAction } from "@/lib/finance";
import { financeRepo } from "@/lib/finance-repo";
import { billCounts, closeChecklist, paidOut, periodByKey, reconciliation, summary } from "@/lib/finance-calc";
import { closePack, REPORTS, reportCsvRows } from "@/lib/finance-reports";
import { toCsv } from "@/lib/hr-reports";
import { parseStatementCsv } from "@/lib/finance-validation";

// Integration: the real service layer (role mapping, rules, audit rows in Postgres)
// driven by real users, the way POST /api/finance/actions drives it.

const D = "@fin-test.mdesk.test";
const ids: string[] = [];
const grants: string[] = [];
const FY = { projectId: "ajah", period: periodByKey("fy2026") };

async function mkUser(key: string, role: RoleName, dept: string | null) {
  const r = await db.role.findUniqueOrThrow({ where: { name: role } });
  const u = await db.user.create({ data: { email: `${key}${D}`, name: `Test ${key}`, passwordHash: "x", roleId: r.id } });
  ids.push(u.id);
  if (dept) {
    const d = await db.department.findUniqueOrThrow({ where: { slug: dept } });
    await db.departmentMembership.create({ data: { userId: u.id, departmentId: d.id } });
  }
  return u;
}

async function session(key: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email: `${key}${D}` }, include: { role: true } });
  return { id: "s", token: "x", userId: user.id, expiresAt: new Date(Date.now() + 1e9), userAgent: null, createdAt: new Date(), user } as unknown as AuthSession;
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    if (e instanceof ZodError) return 422;
    throw e;
  }
}

const run = async (who: string, body: Record<string, unknown>) => runFinanceAction(await session(who), body);

beforeAll(async () => {
  await mkUser("head", RoleName.ADMIN, "finance-accounts");
  await mkUser("acc", RoleName.OFFICER, "finance-accounts");
  await mkUser("acc2", RoleName.MANAGER, "finance-accounts");
  await mkUser("viewer", RoleName.DEPT_AUDITOR, "finance-accounts");
  await mkUser("field", RoleName.FIELD_STAFF, "finance-accounts");
  await mkUser("outsider", RoleName.OFFICER, "hr-administration");
  await mkUser("exec", RoleName.MANAGER, "executive-leadership-strategy");
  const granted = await mkUser("granted", RoleName.OFFICER, null);
  const fin = await db.department.findUniqueOrThrow({ where: { slug: "finance-accounts" } });
  const g = await db.delegationGrant.create({ data: { userId: granted.id, departmentId: fin.id, action: Action.EDIT, grantedById: granted.id, reason: "test" } });
  grants.push(g.id);
});

beforeEach(() => financeRepo().reset());

afterAll(async () => {
  await db.delegationGrant.deleteMany({ where: { id: { in: grants } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  // Other suites running at the same time may notify these users (e.g. workflow approvals to Finance managers).
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  // Audit events stay (append-only); their actor link is cleared when the user goes.
  await db.user.deleteMany({ where: { id: { in: ids } } });
});

describe("who gets which Finance role", () => {
  it("maps M-DESK roles, memberships and grants", async () => {
    const role = async (k: string) => (await financeAccess(await session(k)))?.actor.role ?? null;
    expect(await role("head")).toBe("FINANCE_HEAD");
    expect(await role("acc")).toBe("ACCOUNTANT");
    expect(await role("acc2")).toBe("ACCOUNTANT");
    expect(await role("viewer")).toBe("VIEWER");
    expect(await role("field")).toBe("FIELD");
    expect(await role("exec")).toBe("MANAGEMENT");
    expect(await role("granted")).toBe("ACCOUNTANT");
    expect(await role("outsider")).toBeNull();
    expect((await financeAccess(await session("viewer")))?.exporter).toBe(false);
  });

  it("refuses an outsider and records the denial", async () => {
    const s = await session("outsider");
    expect(await status(requireFinance(s))).toBe(403);
    const denied = await db.auditEvent.findFirst({ where: { actorId: s.user.id, action: "DENIED_FINANCE_ACTION" } });
    expect(denied?.outcome).toBe("DENIED");
  });

  it("refuses protected actions called directly, not just hidden buttons", async () => {
    expect(await status(run("viewer", { type: "bill.approve", billId: "BL-0424" }))).toBe(403);
    expect(await status(run("viewer", { type: "close.lock", accountId: "hdfc", month: "2026-10" }))).toBe(403);
    expect(await status(run("acc", { type: "close.reopen", month: "2026-09", reason: "I want to change September" }))).toBe(403);
    expect(await status(run("outsider", { type: "receipt.verify", receiptId: "RC-0222" }))).toBe(403);
    expect(await status(run("field", { type: "demo.reset" }))).toBe(403);
    const v = await session("viewer");
    expect(await db.auditEvent.count({ where: { actorId: v.user.id, action: "DENIED_FINANCE_ACTION" } })).toBeGreaterThanOrEqual(2);
  });

  it("rejects malformed and hostile input before any rule runs", async () => {
    expect(await status(run("acc", { type: "bill.pay", billId: "BL-0409" }))).toBe(422);
    expect(await status(run("acc", { type: "nope" }))).toBe(422);
    expect(await status(run("acc", { type: "bill.approve", billId: "x".repeat(500) }))).toBe(422);
    expect(await status(run("acc", { type: "bank.link", lineId: "BK-0001", target: "LEDGER:../../etc" }))).toBe(422);
    expect(await status(run("acc", { type: "bill.editAmount", billId: "BL-0421", amount: "1e400", reason: "overflow attempt" }))).toBe(422);
    expect(await status(run("acc", { type: "bill.editAmount", billId: "BL-0421", amount: -500, reason: "negative" }))).toBe(422);
  });
});

describe("journeys through the service", () => {
  it("bill: check → approve → pay moves the counts and the paid total, and writes audit rows", async () => {
    const before = financeRepo().snapshot();
    const paidBefore = paidOut(before, FY);
    await run("acc", { type: "bill.approve", billId: "BL-0421" });
    await run("head", { type: "bill.approve", billId: "BL-0421" });
    let s = financeRepo().snapshot();
    expect(billCounts(s.bills.filter((b) => b.projectId === "ajah"))).toMatchObject({ WAITING: billCounts(before.bills.filter((b) => b.projectId === "ajah")).WAITING - 1 });
    await run("acc", { type: "bill.pay", billId: "BL-0421", date: new Date().toISOString().slice(0, 10), reference: "UTR-IT-0421" });
    s = financeRepo().snapshot();
    expect(paidOut(s, FY)).toBe(paidBefore + 38500);
    const acc = await session("acc");
    expect(await db.auditEvent.count({ where: { actorId: acc.user.id, action: "FINANCE_BILL_PAY" } })).toBeGreaterThanOrEqual(1);
  });

  it("the checker of a bill cannot also approve it", async () => {
    await run("head", { type: "bill.approve", billId: "BL-0421" });
    expect(await status(run("head", { type: "bill.approve", billId: "BL-0421" }))).toBe(403);
  });

  it("two clicks on Mark as paid cannot both pay", async () => {
    const results = await Promise.allSettled([
      run("acc", { type: "bill.pay", billId: "BL-0409", date: new Date().toISOString().slice(0, 10), reference: "UTR-RACE-1" }),
      run("acc2", { type: "bill.pay", billId: "BL-0409", date: new Date().toISOString().slice(0, 10), reference: "UTR-RACE-2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason instanceof ApiError && rejected.reason.status).toBe(409);
    expect(financeRepo().snapshot().ledger.filter((e) => e.source?.id === "BL-0409")).toHaveLength(1);
  });

  it("a refused action leaves the records unchanged", async () => {
    const before = JSON.stringify(financeRepo().snapshot().bills);
    expect(await status(run("head", { type: "bill.pay", billId: "BL-0424", date: "2026-11-03", reference: "UTR-X" }))).toBe(409);
    expect(JSON.stringify(financeRepo().snapshot().bills)).toBe(before);
  });

  it("October: match, verify, voucher for the charge, explain, sign off, lock — then nothing dated October can change", async () => {
    const q = { accountId: "hdfc", month: "2026-10" };
    await run("acc", { type: "bank.confirmAll", ...q });
    await run("head", { type: "receipt.verify", receiptId: "RC-0222" });
    expect(await status(run("acc", { type: "receipt.verify", receiptId: "RC-0219" }))).toBe(0);
    let s = financeRepo().snapshot();
    const charge = s.bankLines.find((l) => l.month === "2026-10" && l.amount === -1180)!;
    const deposit = s.bankLines.find((l) => l.month === "2026-10" && l.amount === 40000)!;
    await run("acc", { type: "bank.classify", lineId: charge.id, classification: "BANK_CHARGE" });
    const v = await run("acc", { type: "voucher.create", voucherType: "PAYMENT", date: "2026-10-31", projectId: "ajah", category: "ADMIN_OTHER", description: "October bank charges", amount: 1180, bankLineId: charge.id });
    await run("acc", { type: "voucher.submit", voucherId: v.target });
    expect(await status(run("acc", { type: "voucher.decide", voucherId: v.target, approve: true, note: "" }))).toBe(403);
    await run("head", { type: "voucher.decide", voucherId: v.target, approve: true, note: "" });
    await run("head", { type: "voucher.post", voucherId: v.target });
    await run("acc", { type: "bank.explain", lineId: deposit.id, note: "Sender unknown — RC-0214 returned; chase in November" });
    s = financeRepo().snapshot();
    expect(reconciliation(s, "hdfc", "2026-10").counts.open).toBe(0);
    expect(await status(run("head", { type: "close.lock", ...q }))).toBe(409);
    await run("head", { type: "close.signoff", ...q });
    await run("head", { type: "close.lock", ...q });
    s = financeRepo().snapshot();
    expect(closeChecklist(s, "hdfc", "2026-10")).toMatchObject({ doneCount: 6, locked: true });
    expect(await status(run("acc", { type: "voucher.create", voucherType: "PAYMENT", date: "2026-10-20", projectId: "ajah", category: "ADMIN_OTHER", description: "Backdated", amount: 10 }))).toBe(409);
    expect(await status(run("head", { type: "close.reopen", month: "2026-10", reason: "Found a missing charge" }))).toBe(403);
    expect(await status(run("exec", { type: "close.reopen", month: "2026-10", reason: "Found a missing charge" }))).toBe(0);
    expect(closeChecklist(financeRepo().snapshot(), "hdfc", "2026-10").locked).toBe(false);
  });

  it("budget change waits for a different person; over-sanction needs Management", async () => {
    const big = await run("acc", { type: "budget.request", projectId: "ajah", category: "MATERIALS", proposed: 2000000, reason: "Feed store construction added" });
    expect(await status(run("head", { type: "budget.decide", requestId: big.target, approve: true, note: "" }))).toBe(403);
    await run("exec", { type: "budget.decide", requestId: big.target, approve: true, note: "Board approved" });
    expect(financeRepo().snapshot().budgets.find((b) => b.projectId === "ajah" && b.category === "MATERIALS")?.amount).toBe(2000000);
  });

  it("verified receipts only rise after bank match and a second person", async () => {
    const r = await run("field", { type: "receipt.record", projectId: "ajah", from: "Beneficiary share", purpose: "Contribution, 1 shed", amount: 35000, receivedOn: "2026-11-02", reference: "UPI-IT-1", instalmentNo: "" });
    const v0 = summary(financeRepo().snapshot(), FY).verified;
    expect(await status(run("acc", { type: "receipt.verify", receiptId: r.target }))).toBe(409);
    await run("acc", { type: "bank.upload", accountId: "hdfc", month: "2026-11", fileName: "nov.csv", csv: "date,description,reference,amount\n2026-11-02,UPI credit,UPI-IT-1,35000" });
    const line = financeRepo().snapshot().bankLines.find((l) => l.reference === "UPI-IT-1")!;
    await run("acc", { type: "receipt.link", receiptId: r.target, bankLineId: line.id });
    expect(summary(financeRepo().snapshot(), FY).verified).toBe(v0);
    expect(await status(run("field", { type: "receipt.verify", receiptId: r.target }))).toBe(403);
    await run("acc2", { type: "receipt.verify", receiptId: r.target });
    expect(summary(financeRepo().snapshot(), FY).verified).toBe(v0 + 35000);
  });

  it("demo reset is limited to the Finance Head / Super Admin and is audited", async () => {
    await run("acc", { type: "bill.submit", billId: "BL-0425" });
    expect(await status(run("acc", { type: "demo.reset" }))).toBe(403);
    await run("head", { type: "demo.reset" });
    expect(financeRepo().snapshot().bills.find((b) => b.id === "BL-0425")?.status).toBe("DRAFT");
  });
});

describe("reports and exports", () => {
  it("builds every report from the sample data", () => {
    const s = financeRepo().snapshot();
    for (const r of REPORTS) {
      const out = r.build(s, { scope: FY, accountId: "hdfc", month: "2026-10" });
      expect(out.columns.length, r.key).toBeGreaterThan(1);
      for (const row of out.rows) expect(row.length, r.key).toBe(out.columns.length);
    }
  });

  it("the close pack carries the summary, differences, ledger, bills, receipts and open items", () => {
    const sections = new Set(closePack(financeRepo().snapshot(), "hdfc", "2026-10").rows.map((r) => r[0]));
    expect([...sections]).toEqual(expect.arrayContaining(["Summary", "Differences", "Checklist", "Ledger", "Bills paid", "Receipts", "Open items"]));
  });

  it("CSV export neutralises spreadsheet formulas", () => {
    const csv = toCsv({ columns: reportCsvRows({ columns: [{ label: "A" }], rows: [] })[0], rows: [["=HYPERLINK(\"http://x\")"], ["-2+3"]] });
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"'-2+3"`);
  });

  it("reads statement CSVs in either column layout and rejects junk", () => {
    expect(parseStatementCsv("date,description,reference,debit,credit\n28/10/2026,\"UPI, field\",U1,,210000\n31-10-2026,Charges,C1,1180,")).toEqual([
      { date: "2026-10-28", description: "UPI, field", reference: "U1", amount: 210000 },
      { date: "2026-10-31", description: "Charges", reference: "C1", amount: -1180 },
    ]);
    expect(() => parseStatementCsv("foo,bar\n1,2")).toThrow(/Columns needed/);
    expect(() => parseStatementCsv("date,description,reference,amount\n2026-10-01,x,y,abc")).toThrow(/not a number/);
  });
});
