import { requireSession } from "@/lib/authorize";
import { listWorkflows, startWorkflow } from "@/lib/workflows";
import { errorResponse, ok, startWorkflowSchema } from "@/lib/validation";

export async function GET() {
  try {
    const session = await requireSession();
    return ok(await listWorkflows(session));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = startWorkflowSchema.parse(await req.json());
    const instance = await startWorkflow(session, input);
    return ok({ instance }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
