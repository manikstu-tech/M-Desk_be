import { requireSession } from "@/lib/authorize";
import { transitionEmployee } from "@/lib/hr-employees";
import { stageSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { to, reason } = stageSchema.parse(await req.json());
    await transitionEmployee(session, id, to, reason);
    return ok({ id, stage: to });
  } catch (e) {
    return errorResponse(e);
  }
}
