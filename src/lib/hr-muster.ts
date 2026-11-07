import type ExcelJS from "exceljs";
import type { AttendanceStatus } from "@prisma/client";

// The current HR app exports a "Muster Detailed Report (Individual)": one row per employee,
// one column per day of the month, and a short code in each cell. This reads that file so HR
// can load it as it is, without retyping it into the import template.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Daily codes seen in the company's Muster report.
 * R = weekly rest day (no record); the report counts ML and AL under paid leave (PL).
 * Anything not listed is reported back to HR instead of being guessed.
 */
const CODE_STATUS: Record<string, { status: AttendanceStatus | null; note?: string }> = {
  P: { status: "PRESENT" },
  A: { status: "ABSENT" },
  HLF: { status: "HALF_DAY" },
  PH: { status: "HOLIDAY" },
  PL: { status: "ON_LEAVE", note: "Muster: paid leave (PL)" },
  ML: { status: "ON_LEAVE", note: "Muster: leave (ML)" },
  AL: { status: "ON_LEAVE", note: "Muster: leave (AL)" },
  UL: { status: "ABSENT", note: "Muster: unpaid leave (UL)" },
  R: { status: null },
};

export type MusterRow = { row: number; code: string; name: string; date: Date; status: AttendanceStatus; note?: string };
export type MusterParse = {
  rows: MusterRow[];
  errors: { row: number; message: string }[];
  employees: { code: string; name: string }[];
  period: { from: string; to: string } | null;
};

function text(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return String(v.result ?? "");
  }
  return String(v);
}

/** Returns null when the sheet is not a Muster report, so the normal import template path runs. */
export function parseMuster(sheet: ExcelJS.Worksheet): MusterParse | null {
  let headerRow = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
    const row = sheet.getRow(r);
    if (text(row.getCell(2).value).trim().toLowerCase() === "employee code" && text(row.getCell(3).value).trim().toLowerCase() === "employee name") {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) return null;

  // "Period : 01-Nov-2026 To 30-Nov-2026" gives the month and year of the day columns.
  let year = 0;
  let month = 0;
  let period: MusterParse["period"] = null;
  for (let r = 1; r < headerRow; r++) {
    const m = /period\s*:\s*(\d{1,2})-([a-z]{3})[a-z]*-(\d{4})\s*to\s*(\d{1,2})-([a-z]{3})[a-z]*-(\d{4})/i.exec(text(sheet.getRow(r).getCell(1).value));
    if (m) {
      year = +m[3];
      month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
      period = { from: `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`, to: `${m[6]}-${String(MONTHS.indexOf(m[5].toLowerCase()) + 1).padStart(2, "0")}-${m[4].padStart(2, "0")}` };
      break;
    }
  }
  const errors: MusterParse["errors"] = [];
  if (!year || month < 1) {
    return { rows: [], errors: [{ row: headerRow, message: 'The "Period : 01-Nov-2026 To 30-Nov-2026" line is missing, so the month is unknown' }], employees: [], period };
  }

  // Day columns: header cells such as "01\nSun".
  const dayCols: { col: number; day: number }[] = [];
  sheet.getRow(headerRow).eachCell((cell, n) => {
    const m = /^(\d{1,2})\b/.exec(text(cell.value).trim());
    if (n >= 4 && m && +m[1] >= 1 && +m[1] <= 31) dayCols.push({ col: n, day: +m[1] });
  });

  const rows: MusterRow[] = [];
  const employees: MusterParse["employees"] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const code = text(row.getCell(2).value).trim().toUpperCase();
    const name = text(row.getCell(3).value).trim();
    if (!code) continue;
    employees.push({ code, name });
    for (const { col, day } of dayCols) {
      const raw = text(row.getCell(col).value).trim().toUpperCase();
      if (!raw) continue; // days after the report date are blank
      const map = CODE_STATUS[raw];
      if (!map) {
        errors.push({ row: r, message: `${code} day ${day}: unknown code "${raw}". Tell the developer what it means before importing` });
        continue;
      }
      if (!map.status) continue;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1) continue; // e.g. day 31 in a 30-day month
      rows.push({ row: r, code, name, date, status: map.status, note: map.note });
    }
  }
  return { rows, errors, employees, period };
}
