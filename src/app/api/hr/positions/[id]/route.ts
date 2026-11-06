import { requireSession } from "@/lib/authorize";
import { setPositionActive } from "@/lib/hr-employees";
import { positionUpdateSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { active } = positionUpdateSchema.parse(await req.json());
    await setPositionActive(session, id, active);
    return ok({ id, active });
  } catch (e) {
    return errorResponse(e);
  }
}
