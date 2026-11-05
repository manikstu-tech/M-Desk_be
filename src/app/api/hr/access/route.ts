import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { hrCan, hrWorkspace } from "@/lib/hr";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/access: whether the signed-in user may open the HR workspace, and which HR grants they hold.
 * Never 403s, so fe can decide between the page and its no-access card in one call.
 */
export async function GET() {
  try {
    const session = await requireSession();
    const dept = await hrWorkspace(session);
    if (!dept) return ok({ member: false, canEdit: false, canApprove: false, canUpload: false, canExport: false });
    const [canEdit, canApprove, canUpload, canExport] = await Promise.all([
      hrCan(session, Action.EDIT),
      hrCan(session, Action.APPROVE),
      hrCan(session, Action.UPLOAD),
      hrCan(session, Action.EXPORT),
    ]);
    return ok({ member: true, department: dept, canEdit, canApprove, canUpload, canExport });
  } catch (e) {
    return errorResponse(e);
  }
}
