import { requireSession } from "@/lib/authorize";
import { licenceAction } from "@/lib/tech-registers";
import { licenceActionSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

// Seat assignment / revocation and renewal (WF-TM-09).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    await licenceAction(session, id, licenceActionSchema.parse(await req.json()));
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
