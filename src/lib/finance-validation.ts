import { z } from "zod";
import type { StatementLineInput } from "./finance-rules";

// Request shapes for POST /api/finance/actions. zod checks types and sizes; the business
// rules (who, when, how much) live in finance-rules.ts so the UI and tests share them.

const id = z.string().trim().min(1).max(40);
const money = z.coerce.number();
const date = z.string().trim().max(10);
const words = (max: number) => z.string().max(max).default("");
const category = z.enum(["FABRICATOR", "MATERIALS", "CAMERA_LIGHT", "TRANSPORT", "ADMIN_OTHER"]);
const nullableId = z.preprocess((v) => (v === "" || v === undefined ? null : v), id.nullable());

export const financeActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bill.create"),
    projectId: id,
    vendorId: id,
    billType: z.enum(["FABRICATOR_BILL", "VENDOR_INVOICE", "INSTALLATION_BILL", "EXPENSE"]),
    category,
    workOrderId: nullableId,
    amount: money,
    billDate: date,
    dueDate: date,
    invoiceTitle: words(120),
  }),
  z.object({ type: z.literal("bill.submit"), billId: id }),
  z.object({ type: z.literal("bill.attach"), billId: id, kind: z.enum(["INVOICE", "COMPLETION_PROOF", "WORK_ORDER", "OTHER"]), title: words(120) }),
  z.object({ type: z.literal("bill.approve"), billId: id }),
  z.object({ type: z.literal("bill.editAmount"), billId: id, amount: money, reason: words(300) }),
  z.object({ type: z.literal("bill.reject"), billId: id, reason: words(300) }),
  z.object({ type: z.literal("bill.pay"), billId: id, date, reference: words(40) }),

  z.object({
    type: z.literal("receipt.record"),
    projectId: id,
    from: words(120),
    purpose: words(160),
    amount: money,
    receivedOn: date,
    reference: z.string().max(40).nullable().default(null),
    instalmentNo: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.coerce.number().int().positive().nullable()),
  }),
  z.object({ type: z.literal("receipt.link"), receiptId: id, bankLineId: id }),
  z.object({ type: z.literal("receipt.verify"), receiptId: id }),
  z.object({ type: z.literal("receipt.return"), receiptId: id, reason: words(300) }),

  z.object({ type: z.literal("budget.request"), projectId: id, category, proposed: money, reason: words(300) }),
  z.object({ type: z.literal("budget.decide"), requestId: id, approve: z.boolean(), note: words(300) }),

  z.object({
    type: z.literal("advance.request"),
    projectId: id,
    givenTo: words(120),
    vendorId: nullableId,
    workOrderId: nullableId,
    category,
    purpose: words(160),
    amount: money,
    givenOn: date,
  }),
  z.object({ type: z.literal("advance.decide"), advanceId: id, approve: z.boolean(), note: words(300) }),
  z.object({ type: z.literal("advance.adjust"), advanceId: id, kind: z.enum(["EXPENSE_SETTLED", "CASH_RETURNED"]), amount: money, note: words(200) }),

  z.object({
    type: z.literal("voucher.create"),
    voucherType: z.enum(["RECEIPT", "PAYMENT", "JOURNAL", "ADVANCE", "REVERSAL"]),
    date,
    projectId: id,
    category: category.nullable().default(null),
    fromCategory: category.nullable().default(null),
    description: words(200),
    amount: money,
    related: z.string().max(40).nullable().default(null),
    reversesLedgerId: nullableId,
    bankLineId: nullableId,
    docs: z.array(z.object({ title: words(120), note: words(200) })).max(5).default([]),
  }),
  z.object({ type: z.literal("voucher.edit"), voucherId: id, description: words(200), amount: money }),
  z.object({ type: z.literal("voucher.delete"), voucherId: id }),
  z.object({ type: z.literal("voucher.submit"), voucherId: id }),
  z.object({ type: z.literal("voucher.decide"), voucherId: id, approve: z.boolean(), note: words(300) }),
  z.object({ type: z.literal("voucher.post"), voucherId: id }),

  z.object({ type: z.literal("bank.upload"), accountId: id, month: z.string().max(7), fileName: words(120), csv: z.string().max(200_000, "Statement file is too large (max 200 KB)") }),
  z.object({ type: z.literal("bank.confirm"), lineId: id }),
  z.object({ type: z.literal("bank.confirmAll"), accountId: id, month: z.string().max(7) }),
  // target is "RECEIPT:<id>" or "LEDGER:<id>" — one dropdown in the UI offers both kinds.
  z.object({ type: z.literal("bank.link"), lineId: id, target: z.string().max(60).regex(/^(RECEIPT|LEDGER):[\w-]+$/, "Choose a book entry or receipt") }),
  z.object({ type: z.literal("bank.classify"), lineId: id, classification: z.enum(["BANK_CHARGE", "INTEREST", "NONE"]) }),
  z.object({ type: z.literal("bank.explain"), lineId: id, note: words(300) }),
  z.object({ type: z.literal("bank.unmatch"), lineId: id, reason: words(300) }),

  z.object({ type: z.literal("close.signoff"), accountId: id, month: z.string().max(7) }),
  z.object({ type: z.literal("close.lock"), accountId: id, month: z.string().max(7) }),
  z.object({ type: z.literal("close.reopen"), month: z.string().max(7), reason: words(300) }),

  z.object({ type: z.literal("demo.reset") }),
]);

export type FinanceAction = z.infer<typeof financeActionSchema>;

// ---------- bank statement CSV ----------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

/** 2026-10-28, 28-10-2026 or 28/10/2026 → 2026-10-28; anything else is returned as-is for the rules to reject. */
function normaliseDate(v: string): string {
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return v;
}

/**
 * Bank statement CSV with a header row: date, description, reference, and either `amount`
 * (credits positive, debits negative) or separate `debit` / `credit` columns.
 * Throws a plain message for the route to return as a 422.
 */
export function parseStatementCsv(csv: string): StatementLineInput[] {
  const rows = csv.replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim() !== "");
  if (rows.length < 2) throw new Error("The file needs a header row and at least one line");
  const head = splitCsvLine(rows[0]).map((h) => h.toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const [d, desc, ref, amt, dr, cr] = ["date", "description", "reference", "amount", "debit", "credit"].map(col);
  if (d < 0 || desc < 0 || ref < 0 || (amt < 0 && (dr < 0 || cr < 0))) {
    throw new Error("Columns needed: date, description, reference, and amount (or debit and credit)");
  }
  const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? 0 : Number(v.replace(/[₹,\s]/g, "")));
  return rows.slice(1).map((r, n) => {
    const c = splitCsvLine(r);
    const amount = amt >= 0 ? num(c[amt]) : num(c[cr]) - num(c[dr]);
    if (!Number.isFinite(amount)) throw new Error(`Line ${n + 1}: amount is not a number`);
    return { date: normaliseDate(c[d] ?? ""), description: c[desc] ?? "", reference: c[ref] ?? "", amount };
  });
}
