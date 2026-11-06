import { requireSession } from "@/lib/authorize";
import { verifyHrDocument } from "@/lib/hr-docs";
import { docVerifySchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { verification, comment } = docVerifySchema.parse(await req.json());
    await verifyHrDocument(session, id, verification, comment);
    return ok({ id, verification });
  } catch (e) {
    return errorResponse(e);
  }
}
