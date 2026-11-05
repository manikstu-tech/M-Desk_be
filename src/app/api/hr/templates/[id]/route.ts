import { requireSession } from "@/lib/authorize";
import { templateAction } from "@/lib/hr-letters";
import { templateActSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { action } = templateActSchema.parse(await req.json());
    await templateAction(session, id, action);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
