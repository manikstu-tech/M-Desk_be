import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { requireHr } from "@/lib/hr";
import { hrDashboardOptions, loadHrDashboard } from "@/lib/hr-dashboard";
import { errorResponse, ok } from "@/lib/validation";

function months(now: Date) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return {
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  });
}

/** GET /api/hr/dashboard?departmentId=&location=&managerId=&month=&week=this|last|month */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const dept = await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;
    const now = new Date();
    const options = await hrDashboardOptions();
    const monthList = months(now);
    const week = sp.get("week");
    const filters = {
      departmentId: options.departments.find((x) => x.id === sp.get("departmentId"))?.id,
      location: options.locations.find((x) => x === sp.get("location")),
      managerId: options.managers.find((x) => x.id === sp.get("managerId"))?.id,
      month: monthList.find((x) => x.value === sp.get("month"))?.value,
      range: week === "last" ? ("last" as const) : week === "month" ? ("month" as const) : ("this" as const),
    };
    const dashboard = await loadHrDashboard(dept, filters, now);
    return ok({ dashboard, filters, options: { ...options, months: monthList } });
  } catch (e) {
    return errorResponse(e);
  }
}
