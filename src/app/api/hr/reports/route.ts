import { Action, EmploymentType } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { REPORTS, runReport, type ReportFilters } from "@/lib/hr-reports";
import { errorResponse, ok } from "@/lib/validation";

function parseDay(v: string | null): Date | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : undefined;
}

/**
 * GET /api/hr/reports?report=&from=YYYY-MM-DD&to=YYYY-MM-DD&employmentType=&departmentId=
 * Runs one HR report on screen (restricted fields masked by runReport). CSV export stays at /api/hr/reports/:key.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;
    const key = REPORTS.find((r) => r.key === sp.get("report"))?.key ?? REPORTS[0].key;
    const to = parseDay(sp.get("to"));
    const filters: ReportFilters = {
      from: parseDay(sp.get("from")),
      to: to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined,
      employmentType: Object.values(EmploymentType).find((t) => t === sp.get("employmentType")),
      departmentId: sp.get("departmentId") || undefined,
    };
    const [result, departments, canExport] = await Promise.all([
      runReport(session, key, filters),
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
      hrCan(session, Action.EXPORT),
    ]);
    return ok({ report: key, reports: REPORTS, result, departments, canExport });
  } catch (e) {
    return errorResponse(e);
  }
}
