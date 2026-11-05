import { requireSession } from "@/lib/authorize";
import { transitionTask } from "@/lib/tasks";
import { errorResponse, ok, taskTransitionSchema } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { to, note, blockedReason } = taskTransitionSchema.parse(await req.json());
    const task = await transitionTask(session, id, to, { note, blockedReason });
    return ok({ task });
  } catch (e) {
    return errorResponse(e);
  }
}
