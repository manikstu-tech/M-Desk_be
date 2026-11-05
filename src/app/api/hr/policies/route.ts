import { requireSession } from "@/lib/authorize";
import { createPolicy } from "@/lib/hr-time";
import { policySchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = policySchema.parse(await req.json());
    const p = await createPolicy(session, input);
    return ok({ id: p.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
