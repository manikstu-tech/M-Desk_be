import { Action, type AttendanceStatus, type EmploymentType, type HolidayCategory } from "@prisma/client";
import { db } from "./db";
import type { Tx } from "./audit";
import type { AuthSession } from "./authorize";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { hrAudit, hrCan, hrDept, requireHr } from "./hr";
import { countLeaveDays, dayKey, hrHref, parseAllowances, type Allowance } from "./hr-catalogue";

const DAY = 24 * 60 * 60 * 1000;

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ───────────── holiday calendar (one company calendar, §8) ─────────────

/** Published holidays for an employee: the company calendar plus any older type-specific ones. */
export async function holidaysFor(type: EmploymentType, location: string | null, from: Date, to: Date) {
  const rows = await db.holiday.findMany({
    where: {
      calendar: {
        status: "PUBLISHED",
        OR: [{ employmentType: null }, { employmentType: type }],
        AND: [{ OR: [{ location: null }, ...(location ? [{ location }] : [])] }],
      },
      date: { lte: to },
      OR: [{ endDate: null, date: { gte: from } }, { endDate: { gte: from } }],
    },
    orderBy: { date: "asc" },
    include: { calendar: { select: { name: true } } },
  });
  return rows;
}

export async function holidayKeysFor(type: EmploymentType, location: string | null, from: Date, to: Date) {
  const keys = new Set<string>();
  for (const h of await holidaysFor(type, location, from, to)) {
    const end = h.endDate ?? h.date;
    for (let d = utcDay(h.date); d <= end; d = new Date(d.getTime() + DAY)) keys.add(dayKey(d));
  }
  return keys;
}

/** Holidays shown on the calendar page: everything published in the window. */
export async function companyHolidays(from: Date, to: Date) {
  return db.holiday.findMany({
    where: {
      calendar: { status: "PUBLISHED" },
      date: { lte: to },
      OR: [{ endDate: null, date: { gte: from } }, { endDate: { gte: from } }],
    },
    orderBy: { date: "asc" },
  });
}

/** The year's company calendar; created (published) on first use. */
async function companyCalendar(tx: Tx, year: number) {
  const existing = await tx.holidayCalendar.findFirst({
    where: { employmentType: null, location: null, year, status: "PUBLISHED" },
  });
  return (
    existing ??
    tx.holidayCalendar.create({
      data: {
        name: `Company holidays ${year}`,
        year,
        status: "PUBLISHED",
        effectiveFrom: new Date(Date.UTC(year, 0, 1)),
      },
    })
  );
}

/** Employees who see a calendar change get an in-app notice (§8). */
async function affectedUserIds() {
  const emps = await db.employee.findMany({
    where: { stage: { in: ["ACTIVE", "ONBOARDING_IN_PROGRESS"] }, userId: { not: null } },
    select: { userId: true },
  });
  return emps.flatMap((e) => (e.userId ? [e.userId] : []));
}

export async function addHoliday(
  session: AuthSession,
  input: { name: string; date: Date; endDate?: Date; category: HolidayCategory },
) {
  const dept = await requireHr(session, Action.EDIT);
  if (input.endDate && input.endDate < input.date) throw new ApiError(422, "VALIDATION", "End date is before the start date");
  const date = utcDay(input.date);
  const dup = await db.holiday.findFirst({ where: { date, calendar: { status: "PUBLISHED" } } });
  if (dup) throw new ApiError(409, "CONFLICT", `${dup.name} is already on that date`);
  const recipients = await affectedUserIds();

  return db.$transaction(async (tx) => {
    const cal = await companyCalendar(tx, date.getUTCFullYear());
    const h = await tx.holiday.create({
      data: {
        calendarId: cal.id,
        name: input.name,
        date,
        endDate: input.endDate ? utcDay(input.endDate) : null,
        category: input.category,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_HOLIDAY_ADDED",
      targetType: "HolidayCalendar",
      targetId: cal.id,
      detail: { holiday: h.name, date: dayKey(h.date) },
    });
    await notifyUsers(tx, recipients, {
      title: `Holiday calendar updated: ${h.name}`,
      body: `${dayKey(h.date)} added`,
    });
    return h;
  });
}

export async function removeHoliday(session: AuthSession, holidayId: string) {
  const dept = await requireHr(session, Action.EDIT);
  const h = await db.holiday.findUnique({ where: { id: holidayId }, include: { calendar: true } });
  if (!h) throw new ApiError(404, "NOT_FOUND", "Holiday not found");
  if (h.calendar.status === "ARCHIVED") throw new ApiError(409, "CONFLICT", "Archived calendars cannot change");
  const recipients = await affectedUserIds();
  await db.$transaction(async (tx) => {
    await tx.holiday.delete({ where: { id: holidayId } });
    await hrAudit(tx, session, dept.id, {
      action: "HR_HOLIDAY_REMOVED",
      targetType: "HolidayCalendar",
      targetId: h.calendarId,
      detail: { holiday: h.name, date: dayKey(h.date) },
    });
    await notifyUsers(tx, recipients, {
      title: `Holiday calendar updated: ${h.name} removed`,
      body: `${dayKey(h.date)} removed`,
    });
  });
}

// ───────────── leave policies (effective-dated, §8) ─────────────

export async function policyFor(type: EmploymentType, location: string | null, at: Date) {
  const policies = await db.leavePolicy.findMany({
    where: {
      employmentType: type,
      active: true,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  return policies.find((p) => location && p.location === location) ?? policies.find((p) => !p.location) ?? null;
}

export async function createPolicy(
  session: AuthSession,
  input: {
    name: string;
    employmentType: EmploymentType;
    location?: string;
    effectiveFrom: Date;
    approval: string;
    allowances: Allowance[];
  },
) {
  const dept = await requireHr(session, Action.APPROVE);
  const location = input.location || null;
  return db.$transaction(async (tx) => {
    // The previous version stops the day before the new one takes effect.
    const superseded = await tx.leavePolicy.updateMany({
      where: {
        employmentType: input.employmentType,
        location,
        active: true,
        effectiveFrom: { lt: input.effectiveFrom },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
      },
      data: { effectiveTo: new Date(input.effectiveFrom.getTime() - DAY) },
    });
    const p = await tx.leavePolicy.create({
      data: { ...input, location, allowances: input.allowances },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_POLICY_CREATED",
      targetType: "LeavePolicy",
      targetId: p.id,
      detail: {
        employmentType: p.employmentType,
        effectiveFrom: dayKey(p.effectiveFrom),
        allowances: input.allowances,
        superseded: superseded.count,
      },
    });
    return p;
  });
}

// ───────────── leave requests & balances ─────────────

/** Per leave type: allowance, used (approved) and pending days in the calendar year. */
export async function leaveBalance(employeeId: string, year = new Date().getUTCFullYear()) {
  const emp = await db.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  const policy = await policyFor(emp.employmentType, emp.location, new Date());
  const requests = await db.leaveRequest.findMany({
    where: {
      employeeId,
      status: { in: ["APPROVED", "PENDING"] },
      startDate: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
    },
    select: { leaveType: true, days: true, status: true },
  });
  const rows = parseAllowances(policy?.allowances).map((a) => {
    const of = (s: string) =>
      requests.filter((r) => r.leaveType === a.type && r.status === s).reduce((n, r) => n + Number(r.days), 0);
    const used = of("APPROVED");
    const pending = of("PENDING");
    return { type: a.type, allowance: a.days, used, pending, remaining: a.days - used - pending };
  });
  return { policy, rows };
}

export async function submitLeave(
  session: AuthSession,
  input: { employeeId: string; leaveType: string; startDate: Date; endDate: Date; halfDay?: boolean; reason?: string },
) {
  const emp = await db.employee.findUnique({ where: { id: input.employeeId } });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  // Employees file their own leave; HR may file on someone's behalf.
  const dept = emp.userId === session.user.id ? await hrDept() : await requireHr(session, Action.EDIT);
  if (!["ACTIVE", "ONBOARDING_IN_PROGRESS"].includes(emp.stage)) {
    throw new ApiError(409, "CONFLICT", "Leave applies to active employees only");
  }
  const start = utcDay(input.startDate);
  const end = utcDay(input.endDate);
  if (start.getUTCFullYear() !== end.getUTCFullYear()) {
    throw new ApiError(422, "VALIDATION", "Split leave that crosses the year end into two requests");
  }
  const { policy, rows } = await leaveBalance(emp.id, start.getUTCFullYear());
  if (!policy) throw new ApiError(409, "CONFLICT", "No leave policy applies to this employee yet");
  const bucket = rows.find((r) => r.type === input.leaveType);
  if (!bucket) throw new ApiError(422, "VALIDATION", `${input.leaveType} leave is not in ${policy.name}`);

  const holidays = await holidayKeysFor(emp.employmentType, emp.location, start, end);
  const days = countLeaveDays(start, end, holidays, input.halfDay && start.getTime() === end.getTime());
  if (days === 0) throw new ApiError(422, "VALIDATION", "Those dates are all weekends or holidays");
  if (days > bucket.remaining) {
    throw new ApiError(409, "CONFLICT", `Only ${bucket.remaining} day(s) of ${input.leaveType} leave remain`);
  }
  const overlap = await db.leaveRequest.findFirst({
    where: { employeeId: emp.id, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: end }, endDate: { gte: start } },
  });
  if (overlap) throw new ApiError(409, "CONFLICT", "This overlaps another leave request");

  return db.$transaction(async (tx) => {
    const req = await tx.leaveRequest.create({
      data: {
        employeeId: emp.id,
        policyId: policy.id,
        leaveType: input.leaveType,
        startDate: start,
        endDate: end,
        days,
        reason: input.reason,
        createdById: session.user.id,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_LEAVE_SUBMITTED",
      targetType: "LeaveRequest",
      targetId: req.id,
      detail: { employeeId: emp.id, leaveType: req.leaveType, days },
    });
    if (emp.managerId) {
      await notifyUsers(tx, [emp.managerId], {
        title: `Leave request from ${emp.name}`,
        body: `${input.leaveType}, ${days} day(s) from ${dayKey(start)}`,
        link: hrHref("attendance-leave"),
      });
    }
    return req;
  });
}

/** Line manager or an HR approver decides; the requester or HR may cancel. */
export async function decideLeave(
  session: AuthSession,
  id: string,
  action: "APPROVE" | "REJECT" | "CANCEL",
  comment?: string,
) {
  const req = await db.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!req) throw new ApiError(404, "NOT_FOUND", "Leave request not found");
  const emp = req.employee;
  let deptId: string;

  if (action === "CANCEL") {
    if (!["PENDING", "APPROVED"].includes(req.status)) throw new ApiError(409, "CONFLICT", "Nothing to cancel");
    deptId = emp.userId === session.user.id ? (await hrDept()).id : (await requireHr(session, Action.EDIT)).id;
  } else {
    if (req.status !== "PENDING") throw new ApiError(409, "CONFLICT", "This request has already been decided");
    if (emp.userId === session.user.id) throw new ApiError(409, "CONFLICT", "You cannot decide your own leave");
    deptId = emp.managerId === session.user.id && !(await hrCan(session, Action.APPROVE))
      ? (await hrDept()).id
      : (await requireHr(session, Action.APPROVE)).id;
    if (action === "REJECT" && !comment) throw new ApiError(422, "VALIDATION", "Give a reason for rejecting");
  }

  const status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
  await db.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id },
      data: {
        status,
        comment: comment ?? req.comment,
        ...(action === "CANCEL" ? {} : { approverId: session.user.id, decidedAt: new Date() }),
      },
    });
    await hrAudit(tx, session, deptId, {
      action: `HR_LEAVE_${status}`,
      targetType: "LeaveRequest",
      targetId: id,
      detail: { employeeId: emp.id, days: Number(req.days), leaveType: req.leaveType, ...(comment ? { comment } : {}) },
    });
    const notify = [emp.userId, emp.managerId].filter((u): u is string => !!u && u !== session.user.id);
    await notifyUsers(tx, notify, {
      title: `Leave ${status.toLowerCase()}: ${emp.name}`,
      body: `${req.leaveType}, ${Number(req.days)} day(s) from ${dayKey(req.startDate)}`,
    });
  });
}

// ───────────── attendance ─────────────

export async function recordAttendance(
  session: AuthSession,
  input: { date: Date; entries: { employeeId: string; status: AttendanceStatus; note?: string }[] },
) {
  const dept = await requireHr(session, Action.EDIT);
  const date = utcDay(input.date);
  if (date.getTime() > utcDay(new Date()).getTime()) throw new ApiError(422, "VALIDATION", "Attendance cannot be recorded ahead");
  const existing = await db.attendanceRecord.findMany({
    where: { date, employeeId: { in: input.entries.map((e) => e.employeeId) } },
  });
  const before = new Map(existing.map((r) => [r.employeeId, r]));
  const corrections = input.entries.filter((e) => {
    const prev = before.get(e.employeeId);
    return prev && prev.status !== e.status;
  });
  const missingReason = corrections.find((c) => !c.note);
  if (missingReason) throw new ApiError(422, "VALIDATION", "Corrections to recorded attendance need a reason");

  await db.$transaction(async (tx) => {
    for (const e of input.entries) {
      await tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: e.employeeId, date } },
        create: { employeeId: e.employeeId, date, status: e.status, note: e.note, recordedById: session.user.id },
        update: { status: e.status, note: e.note ?? before.get(e.employeeId)?.note, recordedById: session.user.id },
      });
    }
    for (const c of corrections) {
      await hrAudit(tx, session, dept.id, {
        action: "HR_ATTENDANCE_CORRECTED",
        targetType: "Employee",
        targetId: c.employeeId,
        detail: { date: dayKey(date), from: before.get(c.employeeId)?.status ?? null, to: c.status, reason: c.note ?? "" },
      });
    }
    await hrAudit(tx, session, dept.id, {
      action: "HR_ATTENDANCE_RECORDED",
      targetType: "AttendanceRecord",
      detail: { date: dayKey(date), entries: input.entries.length, corrections: corrections.length },
    });
  });
}
