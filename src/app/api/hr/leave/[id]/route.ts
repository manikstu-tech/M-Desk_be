import { requireSession } from "@/lib/authorize";
import { decideLeave } from "@/lib/hr-time";
import { leaveDecideSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { action, comment } = leaveDecideSchema.parse(await req.json());
    await decideLeave(session, id, action, comment);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
