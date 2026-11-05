import { describe, expect, it } from "vitest";
import { buildDemoState } from "@/lib/finance-demo-data";
import {
  billCounts,
  budgetRows,
  byCategory,
  closeChecklist,
  instalmentRows,
  isLocked,
  needsAttention,
  paidOut,
  periodByKey,
  reconciliation,
  receiptTotals,
  summary,
  verifiedIn,
} from "@/lib/finance-calc";
import { advanceOutstanding } from "@/lib/finance-calc";

const s = buildDemoState();
const FY = periodByKey("fy2026");
const ajah = { projectId: "ajah", period: FY };
const ALL_TIME = { key: "x", label: "x", from: "0000-01-01", to: "9999-12-31" };

describe("sample data is internally consistent", () => {
  it("builds through the real rules without errors", () => {
    expect(s.bills.length).toBeGreaterThan(20);
    expect(s.ledger.length).toBeGreaterThan(20);
  });

  it("keeps verified, claimed and returned receipts apart (worked out by hand)", () => {
    // 1.50 + 1.25 + 1.00 + 24.00 + 20.85 lakh verified; 2.10 + 1.40 + 0.25 claimed; 0.40 returned
    expect(receiptTotals(s, ajah)).toEqual({ verified: 4860000, claimed: 375000, claimedCount: 3, returned: 40000, returnedCount: 1 });
  });

  it("pays out what the bills, advances and vouchers say", () => {
    // Instalment 1: 21,88,000. Instalment 2: AD-0031 40,000 + BL-0403 21,750 + BL-0408 60,000 + BL-0410 90,000.
    expect(paidOut(s, ajah)).toBe(2188000 + 211750);
    const cats = byCategory(s, ajah);
    expect(cats.reduce((n, c) => n + c.paid, 0)).toBe(paidOut(s, ajah));
    expect(cats.find((c) => c.category === "ADMIN_OTHER")?.paid).toBe(15000);
  });

  it("cash view equals the books balance when every entry is on one bank account", () => {
    const everything = { projectId: "all", period: ALL_TIME };
    const books = s.ledger.filter((e) => e.accountId === "hdfc").reduce((n, e) => n + (e.direction === "IN" ? e.amount : -e.amount), 0);
    expect(verifiedIn(s, everything) - paidOut(s, everything)).toBe(books);
    expect(summary(s, everything).cash).toBe(books);
  });

  it("uses instalment 1 fully and leaves instalment 3 unreleased", () => {
    const [i1, i2, i3] = instalmentRows(s, "ajah");
    expect(i1).toMatchObject({ released: 2400000, spent: 2188000, committed: 212000, remaining: 0, status: "FULLY_USED" });
    expect(i2.released).toBe(2085000);
    expect(i2.remaining).toBe(i2.released - i2.spent - i2.committed);
    expect(i2.status).toBe("IN_USE");
    expect(i3.status).toBe("NOT_RELEASED");
  });

  it("explains the whole October difference and stops at 3 of 6", () => {
    const r = reconciliation(s, "hdfc", "2026-10");
    // 2,10,000 + 25,000 claimed receipts − 1,180 bank charge + 40,000 unknown deposit
    expect(r.difference).toBe(273820);
    expect(r.explainedTotal).toBe(r.difference);
    expect(r.counts).toMatchObject({ suggested: 2, notMatched: 2, open: 4 });
    const c = closeChecklist(s, "hdfc", "2026-10");
    expect(c.doneCount).toBe(3);
    expect(isLocked(s, "2026-09")).toBe(true);
    expect(isLocked(s, "2026-10")).toBe(false);
  });

  it("shows every status and the attention items the design calls for", () => {
    const counts = billCounts(s.bills.filter((b) => b.projectId === "ajah"));
    expect(counts.DRAFT).toBe(2);
    expect(counts.WAITING).toBe(5);
    expect(counts.APPROVED).toBe(2);
    expect(counts.REJECTED).toBe(1);
    const bl412 = s.bills.find((b) => b.id === "BL-0412");
    expect(bl412).toMatchObject({ submittedAmount: 186000, finalAmount: 179500, advanceDeduction: 40000, status: "WITH_FINANCE_HEAD" });
    const att = needsAttention(s, ajah, "2026-11-03T10:00:00.000Z");
    expect(att.find((a) => a.key === "claimed")?.count).toBe(3);
    expect(att.find((a) => a.key === "unmatched")?.count).toBe(4);
    // BL-0418 plus the two drafts, which have no invoice attached yet
    expect(att.find((a) => a.key === "missing")?.count).toBe(3);
    expect(s.bills.find((b) => b.id === "BL-0424")?.overBudget).toBe(true);
  });

  it("has advances in each state and a budget near its limit", () => {
    const left = Object.fromEntries(s.advances.map((a) => [a.id, [advanceOutstanding(a), a.status]]));
    expect(left).toEqual({ "AD-0028": [0, "CLEARED"], "AD-0033": [5800, "PARTLY_ADJUSTED"], "AD-0031": [40000, "OPEN"] });
    expect(budgetRows(s, "ajah").find((r) => r.category === "TRANSPORT")?.flag).toBe("NEARLY_USED");
  });
});
