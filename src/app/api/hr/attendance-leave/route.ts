import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { holidayKeysFor, leaveBalance } from "@/lib/hr-time";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/attendance-leave?month=YYYY-MM
 * The signed-in employee's attendance, leave and holidays for one month.
 * fe builds the calendar grid from this.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;

    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    const m = sp.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      const [y, mm] = m.split("-").map(Number);
      if (y >= 2024 && y <= 2030 && mm >= 1 && mm <= 12) {
        year = y;
        month = mm - 1;
      }
    }
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));

    const emp = await db.employee.findUnique({
      where: { userId: session.user.id },
      select: {
        id: true,
        name: true,
        code: true,
        location: true,
        employmentType: true,
        position: { select: { title: true } },
        department: { select: { name: true } },
      },
    });

    const [attendance, leaveRequests, balance, canEdit, holidays] = await Promise.all([
      emp
        ? db.attendanceRecord.findMany({
            where: { employeeId: emp.id, date: { gte: monthStart, lte: monthEnd } },
            orderBy: { date: "desc" },
          })
        : Promise.resolve([]),
      emp
        ? db.leaveRequest.findMany({ where: { employeeId: emp.id }, orderBy: { startDate: "desc" }, take: 10 })
        : Promise.resolve([]),
      emp ? leaveBalance(emp.id, year) : Promise.resolve({ policy: null, rows: [] }),
      hrCan(session, Action.EDIT),
      emp ? holidayKeysFor(emp.employmentType, emp.location, monthStart, monthEnd) : Promise.resolve(new Set<string>()),
    ]);

    return ok({
      month: { year, month: month + 1, start: monthStart, end: monthEnd },
      employee: emp,
      attendance,
      leaveRequests,
      leaveBalance: balance,
      holidayKeys: [...holidays],
      canEdit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
