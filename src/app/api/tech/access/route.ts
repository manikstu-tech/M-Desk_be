import { requireSession } from "@/lib/authorize";
import { techAccess } from "@/lib/tech";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/access: what the signed-in user may do in Technology & MIS (layout, overview, workflows pages). */
export async function GET() {
  try {
    const session = await requireSession();
    const { dept, ...access } = await techAccess(session);
    return ok({ ...access, department: dept });
  } catch (e) {
    return errorResponse(e);
  }
}
