import { requireSession } from "@/lib/authorize";
import { acknowledgePolicy } from "@/lib/hr-policies";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const a = await acknowledgePolicy(session, id);
    return ok({ id, acknowledgedAt: a.acknowledgedAt });
  } catch (e) {
    return errorResponse(e);
  }
}
