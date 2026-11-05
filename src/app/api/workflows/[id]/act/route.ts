import { requireSession } from "@/lib/authorize";
import { actOnInstance } from "@/lib/workflows";
import { errorResponse, ok, wfActSchema } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { action, comment, amount, title } = wfActSchema.parse(await req.json());
    await actOnInstance(session, id, action, { comment, amount, title });
    return ok({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
