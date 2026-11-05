import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { hrCan, requireHr } from "@/lib/hr";
import { wizardOptions } from "@/lib/hr-new-employee";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/hr/employees/new: dropdown options for the new employee wizard (HR EDIT only). */
export async function GET() {
  try {
    const session = await requireSession();
    await requireHr(session, Action.EDIT);
    const [options, canUpload] = await Promise.all([wizardOptions(), hrCan(session, Action.UPLOAD)]);
    return ok({ options, canUpload });
  } catch (e) {
    return errorResponse(e);
  }
}
