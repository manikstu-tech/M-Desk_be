import { requireSession } from "@/lib/authorize";
import { setTaskDone } from "@/lib/hr-employees";
import { taskToggleSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const session = await requireSession();
    const { id, taskId } = await params;
    const { done } = taskToggleSchema.parse(await req.json());
    await setTaskDone(session, id, taskId, done);
    return ok({ id: taskId, done });
  } catch (e) {
    return errorResponse(e);
  }
}
