// Money and date helpers for Finance. Pure and shared by server and client code.

const LAKH = 100000;
/** Upper bound on any single amount (₹10 crore) — a typo guard, not a business limit. */
export const MAX_AMOUNT = 100000000;

export function roundRupee(n: number): number {
  // toPrecision strips binary noise first, so 1180.005 rounds up like it reads.
  // "+ 0" turns -0 into 0, so a fully recovered advance never shows as "-₹0".
  return Math.round(Number((n * 100).toPrecision(15))) / 100 + 0;
}

/** Positive, finite, at most 2 decimals and below the typo guard. */
export function isValidAmount(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return false;
  return Math.abs(roundRupee(n) - n) < 1e-9;
}

/** ₹1,86,000 — Indian digit grouping; paise only when there are any. */
export function formatINR(n: number): string {
  const v = roundRupee(n);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const hasPaise = Math.round(abs * 100) % 100 !== 0;
  const text = abs.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: hasPaise ? 2 : 0,
  });
  return `${sign}₹${text}`;
}

/** ₹48.60 L */
export function formatLakh(n: number): string {
  const l = Math.round((Math.abs(n) / LAKH) * 100) / 100;
  return `${n < 0 && l > 0 ? "-" : ""}₹${l.toFixed(2)} L`;
}

/** The calendar date in India for an ISO instant ("today" for date checks, not the UTC date). */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
}

/** "2026-10-31" or a full ISO timestamp → "2026-10" */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthShort(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1].slice(0, 3);
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (dates or timestamps), by calendar date. */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00.000Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00.000Z`);
  return Math.round((db - da) / 86400000);
}

/** "2 Nov" */
export function shortDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

/** "2 Nov 2026" */
export function longDate(date: string): string {
  return `${shortDate(date)} ${date.slice(0, 4)}`;
}

/** "3 Nov, 2:05 pm" in India time. */
export function stampTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
