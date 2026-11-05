import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/** GET /api/policies/:id: a company policy and my assignment. Retired policies stay readable only to people assigned them. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const [policy, assignment] = await Promise.all([
      db.companyPolicy.findUnique({ where: { id } }),
      db.policyAssignment.findFirst({ where: { policyId: id, employee: { userId: session.user.id } } }),
    ]);
    if (!policy || (!policy.active && !assignment)) throw new ApiError(404, "NOT_FOUND", "Not found");
    return ok({ policy, assignment });
  } catch (e) {
    return errorResponse(e);
  }
}
