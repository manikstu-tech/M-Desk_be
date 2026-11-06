import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { hrCan, requireHr } from "@/lib/hr";
import { hrDashboardOptions } from "@/lib/hr-dashboard";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/analytics
 * Access + filter options for every HR Analytics tab. The tab figures themselves
 * come from lib/hr-analytics-sample.ts (static sample data), which fe can keep importing.
 */
export async function GET() {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const [canExport, options] = await Promise.all([hrCan(session, Action.EXPORT), hrDashboardOptions()]);
    return ok({ canExport, options });
  } catch (e) {
    return errorResponse(e);
  }
}
