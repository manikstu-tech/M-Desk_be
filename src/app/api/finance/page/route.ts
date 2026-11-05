import { requireSession } from "@/lib/authorize";
import { financePage } from "@/lib/finance";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/finance/page?project=&period=
 * Access, the finance state snapshot and the resolved scope, shared by every Finance & Accounts page.
 * fe runs the pure finance-calc / finance-reports helpers on this data.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const sp = Object.fromEntries(new URL(req.url).searchParams);
    const ctx = await financePage(session, sp);
    if (!ctx) throw new ApiError(403, "FORBIDDEN", "Finance & Accounts access required");
    return ok(ctx);
  } catch (e) {
    return errorResponse(e);
  }
}
