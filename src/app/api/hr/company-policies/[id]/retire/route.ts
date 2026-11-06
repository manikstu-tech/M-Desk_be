import { requireSession } from "@/lib/authorize";
import { retirePolicy } from "@/lib/hr-policies";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    await retirePolicy(session, id);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
