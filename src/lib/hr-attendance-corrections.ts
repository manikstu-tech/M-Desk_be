import { Action, RoleName, type AttendanceStatus } from "@prisma/client";
import type { AuthSession } from "./authorize";
import { db } from "./db";
import { hrAdminIds, hrAudit, hrCan, hrDept } from "./hr";
import { ATTENDANCE_LABEL, dayKey } from "./hr-catalogue";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";

// WF-ATT-05: an employee asks to fix one day's attendance; their reporting manager
// or HR (EDIT) approves or rejects; approval writes the record as an audited correction.

const DAY = 24 * 60 * 60 * 1000;
export const CORRECTION_WINDOW_DAYS = 60;

function utcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const row = {
  id: true,
  date: true,
  requestedStatus: true,
  previousStatus: true,
  reason: true,
  status: true,
  decisionNote: true,
  decidedAt: true,
  createdAt: true,
  employee: { select: { id: true, code: true, name: true, managerId: true } },
} as const;

async function ownEmployee(session: AuthSession) {
  const emp = await db.employee.findUnique({ where: { userId: session.user.id }, select: { id: true, name: true, managerId: true } });
  if (!emp) throw new ApiError(403, "FORBIDDEN", "Only employees can request attendance corrections");
  return emp;
}

/** Employee: request a change for one past day. */
export async function requestCorrection(session: AuthSession, input: { date: Date; status: AttendanceStatus; reason: string }) {
  const emp = await ownEmployee(session);
  const date = utcDay(input.date);
  const today = utcDay(new Date());
  if (date > today) throw new ApiError(422, "VALIDATION", "You can only correct today or a past day");
  if (date.getTime() < today.getTime() - CORRECTION_WINDOW_DAYS * DAY) {
    throw new ApiError(422, "VALIDATION", `Corrections can go back at most ${CORRECTION_WINDOW_DAYS} days; ask HR for older days`);
  }
  const [open, current] = await Promise.all([
    db.attendanceCorrection.findFirst({ where: { employeeId: emp.id, date, status: "PENDING" }, select: { id: true } }),
    db.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: emp.id, date } }, select: { status: true } }),
  ]);
  if (open) throw new ApiError(409, "CONFLICT", "You already have a pending request for this day");
  if (current?.status === input.status) {
    throw new ApiError(422, "VALIDATION", `This day is already recorded as ${ATTENDANCE_LABEL[input.status]}`);
  }

  const dept = await hrDept();
  const approvers = [...(emp.managerId ? [emp.managerId] : []), ...(await hrAdminIds())].filter((id) => id !== session.user.id);
  return db.$transaction(async (tx) => {
    const c = await tx.attendanceCorrection.create({
      data: {
        employeeId: emp.id,
        date,
        requestedStatus: input.status,
        previousStatus: current?.status ?? null,
        reason: input.reason,
        requestedById: session.user.id,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_ATTENDANCE_CORRECTION_REQUESTED",
      targetType: "AttendanceCorrection",
      targetId: c.id,
      detail: { date: dayKey(date), from: current?.status ?? null, to: input.status },
    });
    await notifyUsers(tx, approvers, {
      title: `Attendance correction: ${emp.name}`,
      body: `${dayKey(date)} → ${ATTENDANCE_LABEL[input.status]}`,
      link: "/my-hr#corrections",
    });
    return c;
  });
}

/** Can this user decide this employee's requests? Their reporting manager, or HR with EDIT. Never their own. */
async function canDecide(session: AuthSession, employee: { managerId: string | null; userId?: string | null }) {
  if (employee.userId && employee.userId === session.user.id) return false;
  if (employee.managerId === session.user.id) return true;
  return hrCan(session, Action.EDIT);
}

/** Own requests, plus the requests this user may decide. */
export async function listCorrections(session: AuthSession) {
  const isHr = session.user.role.name === RoleName.SUPER_ADMIN || (await hrCan(session, Action.EDIT));
  const own = await db.employee.findUnique({ where: { userId: session.user.id }, select: { id: true } });
  const [mine, toDecide] = await Promise.all([
    own
      ? db.attendanceCorrection.findMany({ where: { employeeId: own.id }, orderBy: { createdAt: "desc" }, take: 20, select: row })
      : Promise.resolve([]),
    db.attendanceCorrection.findMany({
      where: {
        status: "PENDING",
        ...(own ? { employeeId: { not: own.id } } : {}),
        ...(isHr ? {} : { employee: { managerId: session.user.id } }),
      },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: row,
    }),
  ]);
  return { isEmployee: !!own, mine, toDecide };
}

/** Approve / reject (manager or HR), or cancel (the requester, while pending). */
export async function decideCorrection(
  session: AuthSession,
  id: string,
  input: { action: "APPROVE" | "REJECT" | "CANCEL"; note?: string },
) {
  const c = await db.attendanceCorrection.findUnique({
    where: { id },
    include: { employee: { select: { id: true, name: true, userId: true, managerId: true } } },
  });
  if (!c) throw new ApiError(404, "NOT_FOUND", "Not found");
  if (c.status !== "PENDING") throw new ApiError(409, "CONFLICT", "This request has already been decided");
  const dept = await hrDept();

  if (input.action === "CANCEL") {
    if (c.requestedById !== session.user.id) throw new ApiError(404, "NOT_FOUND", "Not found");
    await db.$transaction(async (tx) => {
      await tx.attendanceCorrection.update({ where: { id }, data: { status: "CANCELLED", decidedAt: new Date(), decidedById: session.user.id } });
      await hrAudit(tx, session, dept.id, { action: "HR_ATTENDANCE_CORRECTION_CANCELLED", targetType: "AttendanceCorrection", targetId: id });
    });
    return "CANCELLED" as const;
  }

  if (!(await canDecide(session, c.employee))) throw new ApiError(404, "NOT_FOUND", "Not found");
  const note = input.note?.trim();
  if (input.action === "REJECT" && !note) throw new ApiError(422, "VALIDATION", "Give a reason for rejecting");

  const approved = input.action === "APPROVE";
  await db.$transaction(async (tx) => {
    await tx.attendanceCorrection.update({
      where: { id },
      data: { status: approved ? "APPROVED" : "REJECTED", decidedById: session.user.id, decidedAt: new Date(), decisionNote: note || null },
    });
    if (approved) {
      const before = await tx.attendanceRecord.findUnique({
        where: { employeeId_date: { employeeId: c.employeeId, date: c.date } },
        select: { status: true },
      });
      await tx.attendanceRecord.upsert({
        where: { employeeId_date: { employeeId: c.employeeId, date: c.date } },
        create: { employeeId: c.employeeId, date: c.date, status: c.requestedStatus, note: `Correction: ${c.reason}`.slice(0, 200), recordedById: session.user.id },
        update: { status: c.requestedStatus, note: `Correction: ${c.reason}`.slice(0, 200), recordedById: session.user.id },
      });
      await hrAudit(tx, session, dept.id, {
        action: "HR_ATTENDANCE_CORRECTED",
        targetType: "Employee",
        targetId: c.employeeId,
        detail: { date: dayKey(c.date), from: before?.status ?? null, to: c.requestedStatus, reason: c.reason, source: "correction", requestId: id },
      });
    }
    await hrAudit(tx, session, dept.id, {
      action: approved ? "HR_ATTENDANCE_CORRECTION_APPROVED" : "HR_ATTENDANCE_CORRECTION_REJECTED",
      targetType: "AttendanceCorrection",
      targetId: id,
      detail: { date: dayKey(c.date), to: c.requestedStatus },
    });
    await notifyUsers(tx, [c.requestedById], {
      title: `Attendance correction ${approved ? "approved" : "rejected"}`,
      body: `${dayKey(c.date)} → ${ATTENDANCE_LABEL[c.requestedStatus]}${note ? ` · ${note}` : ""}`,
      link: "/my-hr#corrections",
    });
  });
  return approved ? ("APPROVED" as const) : ("REJECTED" as const);
}

