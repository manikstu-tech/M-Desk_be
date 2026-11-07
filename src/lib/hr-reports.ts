import { Action, type EmploymentType, type Prisma } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { hrAudit, requireHr } from "./hr";
import {
  ATTENDANCE_LABEL,
  EMAIL_STATUS_LABEL,
  EMPLOYMENT_TYPE_LABEL,
  HOLIDAY_CATEGORY_LABEL,
  LETTER_STATUS_LABEL,
  LETTER_TYPE_LABEL,
  missingMandatoryDocs,
  OFFER_TYPES,
  STAGE_LABEL,
  dayKey,
} from "./hr-catalogue";
import { holidayKeysFor } from "./hr-time";

// §10 HR reports. Every report is built from live records with the same
// filters; compensation and personal contact details are never included
// (masked restricted fields). CSV export is audited with filters and counts.

export type ReportFilters = {
  from?: Date;
  to?: Date;
  employmentType?: EmploymentType;
  departmentId?: string;
};

export type ReportTable = { columns: string[]; rows: string[][] };

export type ReportDef = {
  key: string;
  title: string;
  description: string;
  build: (f: ReportFilters) => Promise<ReportTable>;
};

const d = (v: Date | null | undefined) => (v ? dayKey(v) : "");

function empWhere(f: ReportFilters): Prisma.EmployeeWhereInput {
  return {
    ...(f.employmentType ? { employmentType: f.employmentType } : {}),
    ...(f.departmentId ? { departmentId: f.departmentId } : {}),
  };
}

function range(f: ReportFilters): Prisma.DateTimeFilter | undefined {
  if (!f.from && !f.to) return undefined;
  return { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
}

const DAY = 24 * 60 * 60 * 1000;
const utcDay = (v: Date) => new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));

/** Attendance checks scan day records, so an open-ended filter defaults to the last 60 days. */
function attendanceWindow(f: ReportFilters) {
  const to = utcDay(f.to ?? new Date());
  const from = utcDay(f.from ?? new Date(to.getTime() - 60 * DAY));
  return { from, to };
}

const CORRECTION_SOURCE: Record<string, string> = {
  import: "Excel import",
  correction: "Employee request",
};

const empInclude = {
  position: { select: { title: true } },
  department: { select: { name: true } },
  manager: { select: { name: true } },
} satisfies Prisma.EmployeeInclude;

export const REPORTS: ReportDef[] = [
  {
    key: "employee-master",
    title: "Employee Master",
    description: "Employee ID, name, position, department, manager, location, type, status and dates.",
    async build(f) {
      const rows = await db.employee.findMany({
        where: { ...empWhere(f), ...(range(f) ? { joiningDate: range(f) } : {}) },
        include: empInclude,
        orderBy: { seq: "asc" },
      });
      return {
        columns: ["Employee ID", "Name", "Position", "Department", "Manager", "Location", "Type", "Status", "Start", "End"],
        rows: rows.map((e) => [
          e.code ?? "",
          e.name,
          e.position.title,
          e.department.name,
          e.manager?.name ?? "",
          e.location,
          EMPLOYMENT_TYPE_LABEL[e.employmentType],
          STAGE_LABEL[e.stage],
          d(e.joiningDate),
          d(e.endDate),
        ]),
      };
    },
  },
  {
    key: "intern-vs-permanent",
    title: "Intern vs Permanent",
    description: "Headcount, joiners, leavers and intern-to-permanent conversions by type.",
    async build(f) {
      const all = await db.employee.findMany({
        where: f.departmentId ? { departmentId: f.departmentId } : {},
        select: { employmentType: true, stage: true, joiningDate: true, email: true, updatedAt: true },
      });
      const inRange = (x: Date) => (!f.from || x >= f.from) && (!f.to || x <= f.to);
      const internEmails = new Set(all.filter((e) => e.employmentType === "INTERN").map((e) => e.email));
      const converted = all.filter((e) => e.employmentType === "PERMANENT" && internEmails.has(e.email)).length;
      return {
        columns: ["Type", "Active", "In onboarding", "Joined in range", "Exited in range", "Converted to permanent"],
        rows: (["INTERN", "PERMANENT", "CONTRACT"] as const).map((t) => {
          const of = all.filter((e) => e.employmentType === t);
          return [
            EMPLOYMENT_TYPE_LABEL[t],
            String(of.filter((e) => e.stage === "ACTIVE").length),
            String(of.filter((e) => e.stage === "ONBOARDING_IN_PROGRESS" || e.stage === "ACCEPTED").length),
            String(of.filter((e) => inRange(e.joiningDate)).length),
            String(of.filter((e) => e.stage === "EXITED" && inRange(e.updatedAt)).length),
            t === "INTERN" ? String(converted) : "",
          ];
        }),
      };
    },
  },
  {
    key: "onboarding-status",
    title: "Onboarding Status",
    description: "New joiners, task completion, overdue tasks and missing documents.",
    async build(f) {
      const now = new Date();
      const rows = await db.employee.findMany({
        where: { ...empWhere(f), stage: { in: ["APPROVED", "SENT", "AWAITING_ACCEPTANCE", "ACCEPTED", "ONBOARDING_IN_PROGRESS"] } },
        include: { tasks: true, documents: { select: { label: true, verification: true } }, position: { select: { title: true } } },
        orderBy: { joiningDate: "asc" },
      });
      return {
        columns: ["Employee ID", "Name", "Position", "Type", "Status", "Joining", "Tasks done", "Overdue tasks", "Missing documents"],
        rows: rows.map((e) => [
          e.code ?? "",
          e.name,
          e.position.title,
          EMPLOYMENT_TYPE_LABEL[e.employmentType],
          STAGE_LABEL[e.stage],
          d(e.joiningDate),
          `${e.tasks.filter((t) => t.done).length}/${e.tasks.length}`,
          String(e.tasks.filter((t) => !t.done && t.dueAt && t.dueAt < now).length),
          missingMandatoryDocs(e.employmentType, e.documents).join("; "),
        ]),
      };
    },
  },
  {
    key: "offer-register",
    title: "Offer Letter Register",
    description: "Offers by position and type with status, issue date and joining date.",
    async build(f) {
      const rows = await db.generatedLetter.findMany({
        where: { type: { in: OFFER_TYPES }, employee: empWhere(f), ...(range(f) ? { createdAt: range(f) } : {}) },
        include: { employee: { include: { position: { select: { title: true } } } } },
        orderBy: { createdAt: "desc" },
      });
      return {
        columns: ["Reference", "Employee", "Position", "Type", "Letter", "Status", "Generated", "Sent", "Responded", "Joining"],
        rows: rows.map((l) => [
          l.reference,
          l.employee.name,
          l.employee.position.title,
          EMPLOYMENT_TYPE_LABEL[l.employee.employmentType],
          LETTER_TYPE_LABEL[l.type],
          LETTER_STATUS_LABEL[l.status],
          d(l.createdAt),
          d(l.sentAt),
          d(l.respondedAt),
          d(l.employee.joiningDate),
        ]),
      };
    },
  },
  {
    key: "document-compliance",
    title: "Document Compliance",
    description: "Required documents received, verified, missing, rejected or expiring.",
    async build(f) {
      const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const rows = await db.employee.findMany({
        where: { ...empWhere(f), stage: { notIn: ["WITHDRAWN", "DECLINED", "REJECTED", "EXPIRED"] } },
        include: { documents: true },
        orderBy: { seq: "asc" },
      });
      return {
        columns: ["Employee ID", "Name", "Type", "Received", "Verified", "Pending", "Rejected", "Expiring (30d)", "Missing"],
        rows: rows.map((e) => [
          e.code ?? "",
          e.name,
          EMPLOYMENT_TYPE_LABEL[e.employmentType],
          String(e.documents.length),
          String(e.documents.filter((x) => x.verification === "VERIFIED").length),
          String(e.documents.filter((x) => x.verification === "PENDING").length),
          String(e.documents.filter((x) => x.verification === "REJECTED").length),
          String(e.documents.filter((x) => x.expiresAt && x.expiresAt <= soon).length),
          missingMandatoryDocs(e.employmentType, e.documents).join("; "),
        ]),
      };
    },
  },
  {
    key: "email-delivery",
    title: "Email Delivery",
    description: "Sent, delivered, bounced, failed and retried messages with failure reasons.",
    async build(f) {
      const rows = await db.emailLog.findMany({
        where: { ...(range(f) ? { createdAt: range(f) } : {}), ...(f.employmentType || f.departmentId ? { employee: empWhere(f) } : {}) },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });
      return {
        columns: ["Queued", "Subject", "Related", "Status", "Attempts", "Provider", "Sent", "Delivered", "Last failure"],
        rows: rows.map((e) => [
          d(e.createdAt),
          e.subject,
          e.relatedType,
          EMAIL_STATUS_LABEL[e.status],
          String(e.attempts),
          e.provider,
          d(e.sentAt),
          d(e.deliveredAt),
          e.lastError ?? "",
        ]),
      };
    },
  },
  {
    key: "holiday-calendar",
    title: "Holiday Calendar",
    description: "Holidays by date, calendar, employee type and category.",
    async build(f) {
      const rows = await db.holiday.findMany({
        where: {
          ...(range(f) ? { date: range(f) } : {}),
          calendar: {
            status: { not: "ARCHIVED" },
            ...(f.employmentType ? { OR: [{ employmentType: null }, { employmentType: f.employmentType }] } : {}),
          },
        },
        include: { calendar: true },
        orderBy: { date: "asc" },
      });
      return {
        columns: ["Date", "To", "Holiday", "Category", "Calendar", "Employee type", "Location", "Calendar status"],
        rows: rows.map((h) => [
          d(h.date),
          d(h.endDate),
          h.name,
          HOLIDAY_CATEGORY_LABEL[h.category],
          h.calendar.name,
          h.calendar.employmentType ? EMPLOYMENT_TYPE_LABEL[h.calendar.employmentType] : "All",
          h.calendar.location ?? "All",
          h.calendar.status,
        ]),
      };
    },
  },
  {
    key: "leave-summary",
    title: "Leave Summary",
    description: "Leave requests, approvals and days taken by type and employee type.",
    async build(f) {
      const rows = await db.leaveRequest.findMany({
        where: { employee: empWhere(f), ...(range(f) ? { startDate: range(f) } : {}) },
        include: { employee: { select: { code: true, name: true, employmentType: true } } },
        orderBy: { startDate: "desc" },
      });
      return {
        columns: ["Employee ID", "Name", "Type", "Leave type", "From", "To", "Days", "Status", "Decided"],
        rows: rows.map((l) => [
          l.employee.code ?? "",
          l.employee.name,
          EMPLOYMENT_TYPE_LABEL[l.employee.employmentType],
          l.leaveType,
          d(l.startDate),
          d(l.endDate),
          String(Number(l.days)),
          l.status,
          d(l.decidedAt),
        ]),
      };
    },
  },
  {
    key: "attendance-summary",
    title: "Attendance Summary",
    description: "Attendance percentage and exceptions by employee for the period.",
    async build(f) {
      const records = await db.attendanceRecord.findMany({
        where: { employee: empWhere(f), ...(range(f) ? { date: range(f) } : {}) },
        include: { employee: { select: { code: true, name: true, employmentType: true } } },
      });
      const byEmp = new Map<string, typeof records>();
      for (const r of records) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
      return {
        columns: ["Employee ID", "Name", "Type", "Days recorded", "Present %", ...Object.values(ATTENDANCE_LABEL)],
        rows: [...byEmp.values()].map((rs) => {
          const workDays = rs.filter((r) => r.status !== "HOLIDAY").length;
          const present = rs.filter((r) => r.status === "PRESENT").length + rs.filter((r) => r.status === "HALF_DAY").length / 2;
          return [
            rs[0].employee.code ?? "",
            rs[0].employee.name,
            EMPLOYMENT_TYPE_LABEL[rs[0].employee.employmentType],
            String(rs.length),
            workDays ? `${Math.round((present / workDays) * 100)}%` : "",
            ...Object.keys(ATTENDANCE_LABEL).map((s) => String(rs.filter((r) => r.status === s).length)),
          ];
        }),
      };
    },
  },
  {
    key: "attendance-conflicts",
    title: "Attendance Conflicts",
    description:
      "Days where attendance disagrees with approved leave or the holiday calendar, for HR review. Defaults to the last 60 days.",
    async build(f) {
      const { from, to } = attendanceWindow(f);
      const records = await db.attendanceRecord.findMany({
        where: { employee: empWhere(f), date: { gte: from, lte: to } },
        include: { employee: { select: { code: true, name: true, employmentType: true, location: true } } },
        orderBy: [{ date: "desc" }],
      });
      const leaves = await db.leaveRequest.findMany({
        where: {
          employeeId: { in: [...new Set(records.map((r) => r.employeeId))] },
          status: "APPROVED",
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { employeeId: true, startDate: true, endDate: true, days: true, leaveType: true },
      });
      const holidayCache = new Map<string, Promise<Set<string>>>();
      const holidays = (type: EmploymentType, location: string) => {
        const k = `${type}|${location}`;
        if (!holidayCache.has(k)) holidayCache.set(k, holidayKeysFor(type, location, from, to));
        return holidayCache.get(k)!;
      };

      const rows: string[][] = [];
      for (const r of records) {
        const leave = leaves.find((l) => l.employeeId === r.employeeId && l.startDate <= r.date && l.endDate >= r.date);
        const halfDayLeave = !!leave && Number(leave.days) % 1 !== 0 && +leave.startDate === +leave.endDate;
        const holiday = (await holidays(r.employee.employmentType, r.employee.location)).has(dayKey(r.date));
        const issues: string[] = [];
        if (leave && r.status === "PRESENT") issues.push(`Marked present on approved ${leave.leaveType} leave`);
        if (leave && r.status === "HALF_DAY" && !halfDayLeave) issues.push(`Half day on approved ${leave.leaveType} leave`);
        if (leave && r.status === "ABSENT") issues.push(`Absent on approved ${leave.leaveType} leave (should be On leave)`);
        if (!leave && r.status === "ON_LEAVE") issues.push("On leave without an approved leave request");
        if (holiday && r.status === "ABSENT") issues.push("Absent on a holiday");
        if (!holiday && r.status === "HOLIDAY") issues.push("Holiday marked on a day not in the holiday calendar");
        for (const issue of issues) {
          rows.push([
            d(r.date),
            r.employee.code ?? "",
            r.employee.name,
            EMPLOYMENT_TYPE_LABEL[r.employee.employmentType],
            ATTENDANCE_LABEL[r.status],
            issue,
          ]);
        }
      }
      return { columns: ["Day", "Employee ID", "Name", "Type", "Recorded", "Issue"], rows };
    },
  },
  {
    key: "attendance-corrections",
    title: "Attendance Corrections",
    description: "Every change to a recorded day: old and new status, reason, how it was changed and who changed or approved it.",
    async build(f) {
      const events = await db.auditEvent.findMany({
        where: { action: "HR_ATTENDANCE_CORRECTED", targetType: "Employee" },
        orderBy: { createdAt: "desc" },
        take: 5000,
        include: { actor: { select: { name: true } } },
      });
      const lo = f.from ? dayKey(f.from) : null;
      const hi = f.to ? dayKey(f.to) : null;
      const inRange = events.filter((e) => {
        const day = (e.detail as { date?: string } | null)?.date ?? "";
        return (!lo || day >= lo) && (!hi || day <= hi);
      });
      const employees = await db.employee.findMany({
        where: { ...empWhere(f), id: { in: [...new Set(inRange.map((e) => e.targetId ?? ""))] } },
        select: { id: true, code: true, name: true, employmentType: true },
      });
      const byId = new Map(employees.map((e) => [e.id, e]));
      const label = (s: unknown) => (typeof s === "string" && s in ATTENDANCE_LABEL ? ATTENDANCE_LABEL[s as keyof typeof ATTENDANCE_LABEL] : "Not recorded");
      return {
        columns: ["Day", "Employee ID", "Name", "Type", "From", "To", "Reason", "How", "Changed / approved by", "Changed on"],
        rows: inRange.flatMap((e) => {
          const emp = byId.get(e.targetId ?? "");
          if (!emp) return [];
          const det = (e.detail ?? {}) as { date?: string; from?: string | null; to?: string; reason?: string; source?: string };
          return [
            [
              det.date ?? "",
              emp.code ?? "",
              emp.name,
              EMPLOYMENT_TYPE_LABEL[emp.employmentType],
              label(det.from),
              label(det.to),
              det.reason ?? "",
              CORRECTION_SOURCE[det.source ?? ""] ?? "HR edit",
              e.actor?.name ?? e.actorEmail ?? "",
              d(e.createdAt),
            ],
          ];
        }),
      };
    },
  },
  {
    key: "employee-lifecycle",
    title: "Employee Lifecycle",
    description: "Joining, probation and end dates, completions, exits and onboarding completion.",
    async build(f) {
      const rows = await db.employee.findMany({
        where: empWhere(f),
        include: { tasks: { select: { done: true } } },
        orderBy: { joiningDate: "desc" },
      });
      return {
        columns: ["Employee ID", "Name", "Type", "Status", "Joining", "Probation (months)", "End date", "Onboarding complete"],
        rows: rows.map((e) => [
          e.code ?? "",
          e.name,
          EMPLOYMENT_TYPE_LABEL[e.employmentType],
          STAGE_LABEL[e.stage],
          d(e.joiningDate),
          e.probationMonths != null ? String(e.probationMonths) : "",
          d(e.endDate),
          e.tasks.length ? `${Math.round((e.tasks.filter((t) => t.done).length / e.tasks.length) * 100)}%` : "",
        ]),
      };
    },
  },
  {
    key: "audit",
    title: "Audit Report",
    description: "HR actions: changes, approvals, document access, exports and template changes.",
    async build(f) {
      const dept = await db.department.findUnique({ where: { slug: "hr-administration" }, select: { id: true } });
      const rows = await db.auditEvent.findMany({
        where: { departmentId: dept?.id, ...(range(f) ? { createdAt: range(f) } : {}) },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });
      return {
        columns: ["When", "Actor", "Action", "Object", "Object ID", "Result"],
        rows: rows.map((a) => [
          a.createdAt.toISOString().replace("T", " ").slice(0, 19),
          a.actorEmail ?? "",
          a.action,
          a.targetType,
          a.targetId ?? "",
          a.outcome,
        ]),
      };
    },
  },
];

export function reportDef(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

export async function runReport(session: AuthSession, key: string, f: ReportFilters) {
  await requireHr(session, Action.VIEW);
  const def = reportDef(key);
  if (!def) return null;
  return { def, table: await def.build(f) };
}

function csvCell(v: string): string {
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(t: ReportTable): string {
  return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export async function exportReport(session: AuthSession, key: string, f: ReportFilters) {
  const dept = await requireHr(session, Action.EXPORT);
  const def = reportDef(key);
  if (!def) return null;
  const table = await def.build(f);
  await db.$transaction((tx) =>
    hrAudit(tx, session, dept.id, {
      action: "HR_REPORT_EXPORTED",
      targetType: "Report",
      targetId: key,
      detail: {
        report: def.title,
        rows: table.rows.length,
        filters: {
          from: f.from ? dayKey(f.from) : null,
          to: f.to ? dayKey(f.to) : null,
          employmentType: f.employmentType ?? null,
          departmentId: f.departmentId ?? null,
        },
      },
    }),
  );
  return { def, csv: toCsv(table) };
}
