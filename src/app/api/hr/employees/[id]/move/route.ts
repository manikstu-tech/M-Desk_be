import { requireSession } from "@/lib/authorize";
import { moveEmployee } from "@/lib/hr-employees";
import { employeeMoveSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const input = employeeMoveSchema.parse(await req.json());
    const emp = await moveEmployee(session, id, input);
    return ok({ id, positionId: emp.positionId, departmentId: emp.departmentId });
  } catch (e) {
    return errorResponse(e);
  }
}
