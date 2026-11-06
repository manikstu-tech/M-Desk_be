import { Action, type AttendanceStatus } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { dayKey } from "@/lib/hr-catalogue";
import { holidayKeysFor } from "@/lib/hr-time";
import { errorResponse, ok } from "@/lib/validation";

const WORKING = ["ACTIVE", "ONBOARDING_IN_PROGRESS", "SUSPENDED"] as const;

/**
 * GET /api/hr/attendance/team?date=YYYY-MM-DD&departmentId=
 * Every working employee's attendance for one day (HR VIEW).
 * `recorded` is what was saved; `suggested` fills unrecorded days from approved
 * leave, the employee's holiday calendar and weekends (otherwise Present).
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const d = sp.get("date");
    let date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : today;
    if (Number.isNaN(date.getTime()) || date > today) date = today;

    const departments = await db.department.findMany({
      where: { active: true },
      orderBy: { number: "asc" },
      select: { id: true, name: true },
    });
    const departmentId = departments.find((x) => x.id === sp.get("departmentId"))?.id;

    const [employees, canEdit] = await Promise.all([
      db.employee.findMany({
        where: { stage: { in: [...WORKING] }, ...(departmentId ? { departmentId } : {}) },
        orderBy: { seq: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          employmentType: true,
          location: true,
          department: { select: { name: true } },
          position: { select: { title: true } },
          attendance: { where: { date }, select: { status: true, note: true, updatedAt: true } },
          leaveRequests: {
            where: { status: "APPROVED", startDate: { lte: date }, endDate: { gte: date } },
            select: { id: true },
            take: 1,
          },
        },
      }),
      hrCan(session, Action.EDIT),
    ]);

    // Holiday keys depend on employment type + location; look each combination up once.
    const holidayCache = new Map<string, Promise<Set<string>>>();
    const isHoliday = (type: (typeof employees)[number]["employmentType"], location: string) => {
      const k = `${type}|${location}`;
      if (!holidayCache.has(k)) holidayCache.set(k, holidayKeysFor(type, location, date, date));
      return holidayCache.get(k)!.then((keys) => keys.has(dayKey(date)));
    };
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;

    const rows = await Promise.all(
      employees.map(async (e) => {
        const rec = e.attendance[0] ?? null;
        const suggested: AttendanceStatus | "WEEKEND" = e.leaveRequests.length
          ? "ON_LEAVE"
          : (await isHoliday(e.employmentType, e.location))
            ? "HOLIDAY"
            : weekend
              ? "WEEKEND"
              : "PRESENT";
        return {
          employeeId: e.id,
          code: e.code,
          name: e.name,
          employmentType: e.employmentType,
          department: e.department.name,
          position: e.position.title,
          recorded: rec?.status ?? null,
          note: rec?.note ?? null,
          updatedAt: rec?.updatedAt ?? null,
          suggested,
        };
      }),
    );

    const count = (s: AttendanceStatus) => rows.filter((r) => r.recorded === s).length;
    return ok({
      date: dayKey(date),
      today: dayKey(today),
      weekend,
      rows,
      summary: {
        total: rows.length,
        recorded: rows.filter((r) => r.recorded).length,
        present: count("PRESENT"),
        halfDay: count("HALF_DAY"),
        absent: count("ABSENT"),
        onLeave: count("ON_LEAVE"),
        holiday: count("HOLIDAY"),
      },
      departments,
      departmentId: departmentId ?? null,
      canEdit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
