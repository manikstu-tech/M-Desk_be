import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { dayKey, missingMandatoryDocs } from "./hr-catalogue";
import { isFeedSafe, type HrDept } from "./hr";

const DAY = 24 * 60 * 60 * 1000;
const PRE_ACTIVE = ["ACCEPTED", "ONBOARDING_IN_PROGRESS"] as const;
// Seeded sample people use this domain; the dashboard flags figures built on them.
const DEMO_DOMAIN = "@demo.manikstu.local";

export type HrDashboardFilters = {
  departmentId?: string;
  location?: string;
  managerId?: string;
  month?: string; // YYYY-MM
  range?: "this" | "last" | "month";
};

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The day the dashboard is "as of": today, or the last day of a past month. */
export function referenceDay(month: string | undefined, now = new Date()): Date {
  const today = utcDay(now);
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!m) return today;
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
  return end < today ? end : today;
}

/** §6 HR dashboard — every figure from live records, narrowed by the filter bar. */
export async function loadHrDashboard(dept: HrDept, f: HrDashboardFilters = {}, now = new Date()) {
  const emp: Prisma.EmployeeWhereInput = {
    ...(f.departmentId ? { departmentId: f.departmentId } : {}),
    ...(f.location ? { location: f.location } : {}),
    ...(f.managerId ? { managerId: f.managerId } : {}),
  };
  const ref = referenceDay(f.month, now);
  const range = f.range ?? "this";
  // Attendance window: a 7-day week (this/last), or the whole reference month.
  const monthStart = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const weekEnd = range === "last" ? new Date(ref.getTime() - 7 * DAY) : ref;
  const weekStart = new Date(weekEnd.getTime() - 6 * DAY);
  const windowStart = range === "month" ? monthStart : weekStart;
  const in30 = new Date(now.getTime() + 30 * DAY);

  const [
    activeByType,
    onboardingTasks,
    onboarding,
    expiringDocs,
    expiringContracts,
    pendingLeave,
    upcomingHolidays,
    attendance,
    recentLetters,
    activity,
    demoPeople,
  ] = await Promise.all([
    db.employee.groupBy({ by: ["employmentType"], where: { ...emp, stage: { in: ["ACTIVE", "SUSPENDED"] } }, _count: true }),
    db.onboardingTask.findMany({
      where: { employee: { ...emp, stage: { in: [...PRE_ACTIVE] } } },
      select: { done: true, dueAt: true },
    }),
    db.employee.findMany({
      where: { ...emp, stage: { in: [...PRE_ACTIVE, "ACTIVE"] } },
      select: { employmentType: true, documents: { select: { label: true, verification: true } } },
    }),
    db.hrDocument.count({ where: { employee: emp, expiresAt: { gte: now, lte: in30 } } }),
    db.employee.count({ where: { ...emp, stage: "ACTIVE", endDate: { gte: now, lte: in30 } } }),
    db.leaveRequest.count({ where: { employee: emp, status: "PENDING" } }),
    db.holiday.findMany({
      where: { date: { gte: utcDay(now) }, calendar: { status: "PUBLISHED" } },
      orderBy: { date: "asc" },
      take: 4,
    }),
    db.attendanceRecord.findMany({
      where: { employee: emp, date: { gte: windowStart, lte: ref } },
      select: { date: true, status: true, employee: { select: { email: true } } },
    }),
    db.generatedLetter.findMany({
      where: { employee: emp },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { id: true, reference: true, type: true, status: true, createdAt: true, employee: { select: { id: true, name: true } } },
    }),
    db.auditEvent.findMany({
      where: { departmentId: dept.id, outcome: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, action: true, createdAt: true, actorEmail: true, actor: { select: { name: true } } },
    }),
    db.employee.count({ where: { ...emp, stage: { in: ["ACTIVE", "SUSPENDED"] }, email: { endsWith: DEMO_DOMAIN } } }),
  ]);
  const demoAttendance = attendance.filter((r) => r.employee.email.endsWith(DEMO_DOMAIN)).length;

  const activeOf = (t: string) => activeByType.find((c) => c.employmentType === t)?._count ?? 0;

  // Attendance: share of recorded working entries marked present.
  const bucket = (rows: typeof attendance) => {
    const working = rows.filter((r) => r.status !== "HOLIDAY");
    const present =
      working.filter((r) => r.status === "PRESENT").length +
      working.filter((r) => r.status === "HALF_DAY").length / 2;
    return {
      pct: working.length ? Math.round((present / working.length) * 100) : 0,
      recorded: working.length,
    };
  };

  type AttendanceBar = { day: string; longDay: string; pct: number; recorded: number };
  let attendanceWeek: AttendanceBar[];
  if (range === "month") {
    // One bar per calendar week of the reference month (1–7, 8–14, …).
    const monthShort = ref.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
    const lastDay = ref.getUTCDate();
    attendanceWeek = [];
    for (let s = 1; s <= lastDay; s += 7) {
      const e = Math.min(s + 6, lastDay);
      const rows = attendance.filter((r) => {
        const sameMonth =
          r.date.getUTCFullYear() === ref.getUTCFullYear() && r.date.getUTCMonth() === ref.getUTCMonth();
        const dd = r.date.getUTCDate();
        return sameMonth && dd >= s && dd <= e;
      });
      attendanceWeek.push({ day: `${s}–${e}`, longDay: `${s}–${e} ${monthShort}`, ...bucket(rows) });
    }
  } else {
    // One bar per day of the 7-day week shown.
    const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY));
    attendanceWeek = days.map((d) => ({
      day: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
      longDay: d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }),
      ...bucket(attendance.filter((r) => dayKey(r.date) === dayKey(d))),
    }));
  }
  const refRows = attendance.filter((r) => dayKey(r.date) === dayKey(ref) && r.status !== "HOLIDAY");

  return {
    asOf: ref,
    range,
    // Demo flags per figure: label a number "demo" only when it really contains seeded demo records.
    demo: {
      people: demoPeople > 0,
      attendance: demoAttendance > 0,
      attendanceOnly: attendance.length > 0 && demoAttendance === attendance.length,
    },
    people: {
      total: activeByType.reduce((n, c) => n + c._count, 0),
      permanent: activeOf("PERMANENT"),
      interns: activeOf("INTERN"),
      contract: activeOf("CONTRACT"),
    },
    attendanceToday: {
      present: refRows.filter((r) => r.status === "PRESENT" || r.status === "HALF_DAY").length,
      recorded: refRows.length,
      exceptions: refRows.filter((r) => r.status === "ABSENT").length,
    },
    action: {
      missingMandatory: onboarding.reduce((n, e) => n + missingMandatoryDocs(e.employmentType, e.documents).length, 0),
      overdueTasks: onboardingTasks.filter((t) => !t.done && t.dueAt && t.dueAt < now).length,
      expiring: expiringDocs + expiringContracts,
      pendingLeave,
    },
    attendanceWeek,
    upcomingHolidays,
    recentLetters,
    activity: activity.filter((a) => isFeedSafe(a.action)).slice(0, 3),
  };
}

/** Choices for the dashboard filter bar. */
export async function hrDashboardOptions() {
  const [departments, locations, managers] = await Promise.all([
    db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
    db.employee.findMany({ distinct: ["location"], orderBy: { location: "asc" }, select: { location: true } }),
    db.user.findMany({
      where: { hrReports: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { departments, locations: locations.map((l) => l.location), managers };
}
