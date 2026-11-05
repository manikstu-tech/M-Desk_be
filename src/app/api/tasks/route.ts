import { requireSession } from "@/lib/authorize";
import { createTask, listMyTasks } from "@/lib/tasks";
import { createTaskSchema, errorResponse, ok } from "@/lib/validation";

export async function GET() {
  try {
    const session = await requireSession();
    const buckets = await listMyTasks(session);
    return ok(buckets);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = createTaskSchema.parse(await req.json());
    const task = await createTask(session, input);
    return ok({ task }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
