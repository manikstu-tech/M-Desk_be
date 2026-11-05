import { requireSession } from "@/lib/authorize";
import { assignPolicies } from "@/lib/hr-policies";
import { policyAssignSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { policyIds } = policyAssignSchema.parse(await req.json());
    return ok(await assignPolicies(session, id, policyIds));
  } catch (e) {
    return errorResponse(e);
  }
}
