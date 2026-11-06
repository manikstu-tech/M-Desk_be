import { Action } from "@prisma/client";
import { hrCan, requireHr } from "@/lib/hr";
import { dayKey } from "@/lib/hr-catalogue";
import { companyHolidays } from "@/lib/hr-time";
import { requireSession } from "@/lib/authorize";
import { addHoliday } from "@/lib/hr-time";
import { holidaySchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = holidaySchema.parse(await req.json());
    const h = await addHoliday(session, input);
    return ok({ id: h.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** GET /api/hr/holidays?month=YYYY-MM: holidays covering the month's calendar grid. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const match = /^(\d{4})-(\d{2})$/.exec(new URL(req.url).searchParams.get("month") ?? "");
    const now = new Date();
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth();
    if (match && Number(match[1]) >= 2000 && Number(match[1]) <= 2100 && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
      y = Number(match[1]);
      m = Number(match[2]) - 1;
    }
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0));
    const gridStart = new Date(first.getTime() - first.getUTCDay() * DAY);
    const weeks = Math.ceil((first.getUTCDay() + last.getUTCDate()) / 7);
    const gridEnd = new Date(gridStart.getTime() + (weeks * 7 - 1) * DAY);

    const [holidays, canEdit] = await Promise.all([companyHolidays(gridStart, gridEnd), hrCan(session, Action.EDIT)]);
    return ok({
      month: { year: y, month: m + 1, first, last, gridStart, gridEnd },
      holidays,
      todayKey: dayKey(now),
      canEdit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
