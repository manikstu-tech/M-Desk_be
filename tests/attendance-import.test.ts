import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Database and HR gate are mocked: these tests cover file parsing and row validation.
const upserts: unknown[] = [];
const audits: { action: string }[] = [];
let existing: { employeeId: string; date: Date; status: string; note: string | null }[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    employee: {
      findMany: vi.fn(async () => [
        { id: "e1", code: "EMP-0001", name: "Asha" },
        { id: "e2", code: "INT-0002", name: "Ravi" },
      ]),
    },
    attendanceRecord: { findMany: vi.fn(async () => existing) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ attendanceRecord: { upsert: vi.fn(async (a: unknown) => upserts.push(a)) } }),
    ),
  },
}));
vi.mock("@/lib/hr", () => ({
  requireHr: vi.fn(async () => ({ id: "hr", name: "HR" })),
  hrAudit: vi.fn(async (_tx: unknown, _s: unknown, _d: unknown, ev: { action: string }) => audits.push(ev)),
}));

const { attendanceTemplate, importAttendance } = await import("@/lib/hr-attendance-io");
const session = { user: { id: "u1" } } as never;

async function xlsxFile(rows: unknown[][], header = ["Employee ID", "Employee name", "Date", "Status", "Note"]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("A");
  ws.addRow(header);
  rows.forEach((r) => ws.addRow(r));
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], "att.xlsx");
}

beforeEach(() => {
  upserts.length = 0;
  audits.length = 0;
  existing = [];
});

describe("attendance import", () => {
  it("saves a valid Excel sheet with Excel dates, text dates and status aliases", async () => {
    const r = await importAttendance(
      session,
      await xlsxFile([
        ["emp-0001", "A", new Date(Date.UTC(2026, 9, 1)), "Present"],
        ["INT-0002", "B", "02-10-2026", "half day"],
        ["EMP-0001", "A", "2026-10-02", "A"],
      ]),
    );
    expect(r).toEqual({ saved: true, rows: 3, dates: 2, employees: 2, corrections: 0 });
    expect(upserts).toHaveLength(3);
    expect(audits.map((a) => a.action)).toEqual(["HR_ATTENDANCE_IMPORTED"]);
  });

  it("reads CSV and ignores blank lines", async () => {
    const csv = "﻿Employee ID,Date,Status\nEMP-0001,2026-10-05,Absent\n,,\nINT-0002,05/10/2026,On Leave\n";
    const r = await importAttendance(session, new File([csv], "att.csv"));
    expect(r).toMatchObject({ saved: true, rows: 2 });
  });

  it("saves nothing and lists every bad row", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    const r = await importAttendance(
      session,
      await xlsxFile([
        ["EMP-0001", "", "2026-10-01", "Present"],
        ["EMP-9999", "", "2026-10-01", "Present"],
        ["EMP-0001", "", "31-02-2026", "Present"],
        ["EMP-0001", "", future, "Present"],
        ["EMP-0001", "", "2026-10-01", "Late"],
        ["EMP-0001", "", "2026-10-01", "Absent"],
      ]),
    );
    expect(r.saved).toBe(false);
    if (r.saved) return;
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 5, 6, 7]);
    expect(r.errors[0].message).toMatch(/No employee with ID EMP-9999/);
    expect(r.errors.find((e) => e.row === 7)?.message).toMatch(/already on row 2/);
    expect(upserts).toHaveLength(0);
  });

  it("needs a note to change an already recorded day, and audits the correction", async () => {
    existing = [{ employeeId: "e1", date: new Date(Date.UTC(2026, 9, 1)), status: "ABSENT", note: null }];
    const bad = await importAttendance(session, await xlsxFile([["EMP-0001", "", "2026-10-01", "Present"]]));
    expect(bad.saved).toBe(false);
    const good = await importAttendance(session, await xlsxFile([["EMP-0001", "", "2026-10-01", "Present", "Punch missed"]]));
    expect(good).toMatchObject({ saved: true, corrections: 1 });
    expect(audits.map((a) => a.action)).toEqual(["HR_ATTENDANCE_CORRECTED", "HR_ATTENDANCE_IMPORTED"]);
  });

  it("rejects missing headings and unsupported file types", async () => {
    await expect(importAttendance(session, await xlsxFile([["x"]], ["Name", "Day"]))).rejects.toThrow(/Employee ID, Date, Status/);
    await expect(importAttendance(session, new File(["hi"], "att.docx"))).rejects.toThrow(/\.xlsx.*\.csv/);
  });

  it("template round-trips: download, fill, upload", async () => {
    const buf = await attendanceTemplate(session, new Date(Date.UTC(2026, 9, 1)));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).values).toEqual([undefined, "Employee ID", "Employee name", "Date", "Status", "Note"]);
    expect(ws.getCell("A2").value).toBe("EMP-0001");
    expect(ws.getCell("D2").dataValidation?.type).toBe("list");
    const r = await importAttendance(session, new File([new Uint8Array(buf)], "filled.xlsx"));
    expect(r).toMatchObject({ saved: true, rows: 2 });
  });
});
