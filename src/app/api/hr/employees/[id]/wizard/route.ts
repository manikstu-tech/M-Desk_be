import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { requireHr } from "@/lib/hr";
import { wizardOptions, wizardRecord } from "@/lib/hr-new-employee";
import { activePolicies } from "@/lib/hr-policies";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/employees/:id/wizard
 * The draft record, step states and options for the 5-step new employee wizard.
 * HR EDIT only: the wizard edits bank and identity fields, so they are returned unmasked.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.EDIT);
    const { id } = await params;
    const rec = await wizardRecord(session, id);
    if (!rec) throw new ApiError(404, "NOT_FOUND", "Not found");
    const [options, policies] = await Promise.all([wizardOptions(), activePolicies()]);
    return ok({ ...rec, options, policies });
  } catch (e) {
    return errorResponse(e);
  }
}
