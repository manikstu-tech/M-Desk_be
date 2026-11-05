import { requireSession } from "@/lib/authorize";
import { letterAction } from "@/lib/hr-letters";
import { letterActSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { action, comment } = letterActSchema.parse(await req.json());
    await letterAction(session, id, action, comment);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
