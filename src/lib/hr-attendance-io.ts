import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { Action, AttendanceStatus } from "@prisma/client";
import type { AuthSession } from "./authorize";
import { db } from "./db";
import { hrAudit, requireHr } from "./hr";
import { dayKey } from "./hr-catalogue";
import { parseMuster } from "./hr-muster";
import { ApiError } from "./validation";

// Attendance import / export (WF-HR-06, interim): HR uploads an Excel or CSV sheet,
// every row is validated, and the whole file is saved only when no row has an error.

export const MAX_IMPORT_ROWS = 5000;
const DAY = 24 * 60 * 60 * 1000;

export const COLUMNS = ["Employee ID", "Employee name", "Date", "Status", "Note"] as const;

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  HALF_DAY: "Half Day",
  ON_LEAVE: "On Leave",
  HOLIDAY: "Holiday",
};

const STATUS_ALIASES: Record<string, AttendanceStatus> = {
  present: "PRESENT",
  p: "PRESENT",
  absent: "ABSENT",
  a: "ABSENT",
  "half day": "HALF_DAY",
  halfday: "HALF_DAY",
  "half-day": "HALF_DAY",
  half_day: "HALF_DAY",
  hd: "HALF_DAY",
  "on leave": "ON_LEAVE",
  on_leave: "ON_LEAVE",
  leave: "ON_LEAVE",
  l: "ON_LEAVE",
  holiday: "HOLIDAY",
  h: "HOLIDAY",
};

export type ImportRowError = { row: number; message: string };
export type ImportResult =
  | { saved: true; rows: number; dates: number; employees: number; corrections: number }
  | { saved: false; errors: ImportRowError[]; rows: number };

function utcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Plain text from an ExcelJS cell value (rich text, formulas, hyperlinks, numbers). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return v.result instanceof Date ? v.result.toISOString() : String(v.result ?? "");
  }
  return String(v);
}

/** Accepts Excel dates, YYYY-MM-DD and DD-MM-YYYY / DD/MM/YYYY (Indian order). */
function parseDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return utcDay(v);
  if (v && typeof v === "object" && "result" in v && v.result instanceof Date) return utcDay(v.result);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    // Excel serial day number (1900 date system).
    return utcDay(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY));
  }
  const s = cellText(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  return null;
}

function validYmd(y: number, mo: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

async function readSheet(file: File): Promise<ExcelJS.Worksheet> {
  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  try {
    if (name.endsWith(".csv")) {
      return await wb.csv.read(Readable.from(buffer.toString("utf8").replace(/^﻿/, "")));
    }
    if (name.endsWith(".xlsx")) {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheet = wb.worksheets[0];
      if (!sheet) throw new ApiError(422, "VALIDATION", "The Excel file has no sheets");
      return sheet;
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(422, "VALIDATION", "Could not read the file. Save it as .xlsx or .csv and try again.");
  }
  throw new ApiError(422, "VALIDATION", "Upload an Excel (.xlsx) or CSV (.csv) file. Old .xls and Word files are not supported.");
}

/** Validate every row; save all of them in one transaction only if none has an error. */
export async function importAttendance(session: AuthSession, file: File): Promise<ImportResult> {
  const dept = await requireHr(session, Action.EDIT);
  const sheet = await readSheet(file);

  type Parsed = { row: number; code: string; date: Date; status: AttendanceStatus; note?: string };
  const parsed: Parsed[] = [];
  const errors: ImportRowError[] = [];
  const today = utcDay(new Date());
  let dataRows = 0;

  // The current HR app's Muster report loads as it is; anything else uses the import template.
  const muster = parseMuster(sheet);
  if (muster) {
    errors.push(...muster.errors);
    dataRows = muster.rows.length + muster.errors.length;
    for (const m of muster.rows) {
      if (m.date > today) errors.push({ row: m.row, message: `${m.code} ${dayKey(m.date)} is in the future` });
      else parsed.push({ row: m.row, code: m.code, date: m.date, status: m.status, note: m.note });
    }
  } else {
    // Find columns by header name so extra or reordered columns are fine.
    const header = sheet.getRow(1);
    const col: Partial<Record<"code" | "date" | "status" | "note", number>> = {};
    header.eachCell((cell, n) => {
      const h = cellText(cell.value).trim().toLowerCase();
      if (["employee id", "employee code", "emp id", "code"].includes(h)) col.code = n;
      else if (h === "date") col.date = n;
      else if (h === "status") col.status = n;
      else if (["note", "reason", "remarks"].includes(h)) col.note = n;
    });
    const missing = [!col.code && "Employee ID", !col.date && "Date", !col.status && "Status"].filter(Boolean);
    if (missing.length) {
      throw new ApiError(422, "VALIDATION", `Row 1 must have these column headings: ${missing.join(", ")}. Download the template to see the format.`);
    }

    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const code = cellText(row.getCell(col.code!).value).trim().toUpperCase();
      const rawDate = row.getCell(col.date!).value;
      const rawStatus = cellText(row.getCell(col.status!).value).trim();
      const note = col.note ? cellText(row.getCell(col.note).value).trim().slice(0, 200) || undefined : undefined;
      if (!code && !cellText(rawDate).trim() && !rawStatus) continue; // blank line
      dataRows++;
      if (dataRows > MAX_IMPORT_ROWS) {
        throw new ApiError(422, "VALIDATION", `A file can have at most ${MAX_IMPORT_ROWS} rows. Split it and upload again.`);
      }
      const date = parseDate(rawDate);
      const status = STATUS_ALIASES[rawStatus.toLowerCase()];
      if (!code) errors.push({ row: r, message: "Employee ID is empty" });
      if (!date) errors.push({ row: r, message: `Date "${cellText(rawDate)}" is not a valid date (use YYYY-MM-DD or DD-MM-YYYY)` });
      else if (date > today) errors.push({ row: r, message: `${dayKey(date)} is in the future` });
      if (!status) errors.push({ row: r, message: `Status "${rawStatus}" is not one of: Present, Absent, Half Day, On Leave, Holiday` });
      if (code && date && date <= today && status) parsed.push({ row: r, code, date, status, note });
    }
  }
  if (dataRows === 0) throw new ApiError(422, "VALIDATION", "The file has no attendance rows under the heading row");

  // Employees by code.
  const codes = [...new Set(parsed.map((p) => p.code))];
  const employees = await db.employee.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const idByCode = new Map(employees.map((e) => [e.code!.toUpperCase(), e.id]));

  // Duplicates inside the file.
  const seen = new Map<string, number>();
  const missingReported = new Set<string>();
  const rows: (Parsed & { employeeId: string })[] = [];
  for (const p of parsed) {
    const employeeId = idByCode.get(p.code);
    if (!employeeId) {
      // One message per missing ID, not one per day.
      if (!missingReported.has(p.code)) errors.push({ row: p.row, message: `No employee with ID ${p.code}` });
      missingReported.add(p.code);
      continue;
    }
    const key = `${employeeId}|${dayKey(p.date)}`;
    const first = seen.get(key);
    if (first) {
      errors.push({ row: p.row, message: `${p.code} on ${dayKey(p.date)} is already on row ${first}` });
      continue;
    }
    seen.set(key, p.row);
    rows.push({ ...p, employeeId });
  }

  // Changing an already recorded day is a correction and needs a reason.
  const existing = rows.length
    ? await db.attendanceRecord.findMany({
        where: { OR: rows.map((r) => ({ employeeId: r.employeeId, date: r.date })) },
        select: { employeeId: true, date: true, status: true, note: true },
      })
    : [];
  const before = new Map(existing.map((e) => [`${e.employeeId}|${dayKey(e.date)}`, e]));
  const corrections = rows.filter((r) => {
    const prev = before.get(`${r.employeeId}|${dayKey(r.date)}`);
    return prev && prev.status !== r.status;
  });
  for (const c of corrections) {
    if (!c.note && muster) c.note = `Updated from Muster report${muster.period ? ` ${muster.period.from} to ${muster.period.to}` : ""}`;
    if (!c.note) {
      errors.push({ row: c.row, message: `${c.code} on ${dayKey(c.date)} is already recorded as ${STATUS_LABEL[before.get(`${c.employeeId}|${dayKey(c.date)}`)!.status]}; add a Note with the reason to change it` });
    }
  }

  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    return { saved: false, errors: errors.slice(0, 200), rows: dataRows };
  }

  await db.$transaction(
    async (tx) => {
      for (const r of rows) {
        const prev = before.get(`${r.employeeId}|${dayKey(r.date)}`);
        await tx.attendanceRecord.upsert({
          where: { employeeId_date: { employeeId: r.employeeId, date: r.date } },
          create: { employeeId: r.employeeId, date: r.date, status: r.status, note: r.note, recordedById: session.user.id },
          update: { status: r.status, note: r.note ?? prev?.note, recordedById: session.user.id },
        });
      }
      for (const c of corrections) {
        await hrAudit(tx, session, dept.id, {
          action: "HR_ATTENDANCE_CORRECTED",
          targetType: "Employee",
          targetId: c.employeeId,
          detail: { date: dayKey(c.date), from: before.get(`${c.employeeId}|${dayKey(c.date)}`)?.status ?? null, to: c.status, reason: c.note ?? "", source: "import" },
        });
      }
      await hrAudit(tx, session, dept.id, {
        action: "HR_ATTENDANCE_IMPORTED",
        targetType: "AttendanceRecord",
        detail: { file: file.name.slice(0, 120), rows: rows.length, corrections: corrections.length },
      });
    },
    { timeout: 60_000 },
  );

  return {
    saved: true,
    rows: rows.length,
    dates: new Set(rows.map((r) => dayKey(r.date))).size,
    employees: new Set(rows.map((r) => r.employeeId)).size,
    corrections: corrections.length,
  };
}

function styledBook(sheetName: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "M-DESK";
  const ws = wb.addWorksheet(sheetName);
  ws.columns = [
    { header: COLUMNS[0], key: "code", width: 14 },
    { header: COLUMNS[1], key: "name", width: 28 },
    { header: COLUMNS[2], key: "date", width: 13, style: { numFmt: "yyyy-mm-dd" } },
    { header: COLUMNS[3], key: "status", width: 12 },
    { header: COLUMNS[4], key: "note", width: 36 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return { wb, ws };
}

function addStatusDropdown(ws: ExcelJS.Worksheet, lastRow: number) {
  for (let r = 2; r <= lastRow; r++) {
    ws.getCell(`D${r}`).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"Present,Absent,Half Day,On Leave,Holiday"'],
      showErrorMessage: true,
      errorTitle: "Status",
      error: "Choose Present, Absent, Half Day, On Leave or Holiday",
    };
  }
}

/** Ready-to-fill sheet: one row per working employee for the given day. */
export async function attendanceTemplate(session: AuthSession, date: Date): Promise<Buffer> {
  await requireHr(session, Action.EDIT);
  const employees = await db.employee.findMany({
    where: { stage: { in: ["ACTIVE", "ONBOARDING_IN_PROGRESS", "SUSPENDED"] }, code: { not: null } },
    orderBy: { seq: "asc" },
    select: { code: true, name: true },
  });
  const { wb, ws } = styledBook("Attendance");
  const day = utcDay(date);
  for (const e of employees) ws.addRow({ code: e.code, name: e.name, date: day, status: "Present", note: "" });
  addStatusDropdown(ws, Math.max(2, employees.length + 1) + 200);
  const help = wb.addWorksheet("How to fill");
  help.columns = [{ width: 100 }];
  [
    "Fill one row per employee per day, then upload the file on Attendance & Leave → Import.",
    "Employee ID: as shown in M-DESK (e.g. EMP-0001, INT-0002). Employee name is only for reading.",
    "Date: YYYY-MM-DD or DD-MM-YYYY. Future dates are not allowed.",
    "Status: Present, Absent, Half Day, On Leave or Holiday.",
    "Note: optional, but required when you change a day that is already recorded (give the reason).",
    "If any row has a problem, nothing is saved and the rows to fix are listed.",
  ].forEach((line) => help.addRow([line]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Every recorded day in a month, for all employees. Audited (it lists named people). */
export async function exportAttendance(session: AuthSession, year: number, month: number): Promise<Buffer> {
  const dept = await requireHr(session, Action.EXPORT);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  const records = await db.attendanceRecord.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ employee: { seq: "asc" } }, { date: "asc" }],
    select: { date: true, status: true, note: true, employee: { select: { code: true, name: true } } },
  });
  const { wb, ws } = styledBook(`Attendance ${year}-${String(month).padStart(2, "0")}`);
  for (const r of records) {
    ws.addRow({ code: r.employee.code ?? "", name: r.employee.name, date: r.date, status: STATUS_LABEL[r.status], note: r.note ?? "" });
  }
  await db.$transaction((tx) =>
    hrAudit(tx, session, dept.id, {
      action: "HR_ATTENDANCE_EXPORTED",
      targetType: "AttendanceRecord",
      detail: { month: `${year}-${String(month).padStart(2, "0")}`, rows: records.length },
    }),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}
