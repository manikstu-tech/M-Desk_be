import { requireSession } from "@/lib/authorize";
import { techAccess } from "@/lib/tech";
import { scanTech } from "@/lib/tech-items";
import { ApiError, errorResponse, ok } from "@/lib/validation";

// SLA 50/75/100, auto-close and renewal alerts (§8). Cron arrives with B6; until then
// the Tech & MIS Head or the Super Admin runs it (it also runs from /api/tasks/scan).
export async function POST() {
  try {
    const session = await requireSession();
    const access = await techAccess(session);
    if (!access.head) throw new ApiError(403, "FORBIDDEN", "Only the Tech & MIS Head or the Super Admin can run the scan");
    return ok(await scanTech());
  } catch (e) {
    return errorResponse(e);
  }
}
