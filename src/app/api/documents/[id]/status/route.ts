import { requireSession } from "@/lib/authorize";
import { transitionDocument } from "@/lib/documents";
import { documentStatusSchema, errorResponse, ok } from "@/lib/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { status } = documentStatusSchema.parse(await req.json());
    await transitionDocument(session, id, status);
    return ok({ status });
  } catch (e) {
    return errorResponse(e);
  }
}
