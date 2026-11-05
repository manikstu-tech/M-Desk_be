import { requireSession } from "@/lib/authorize";
import { createPosition } from "@/lib/hr-employees";
import { positionSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = positionSchema.parse(await req.json());
    const p = await createPosition(session, input);
    return ok({ id: p.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
