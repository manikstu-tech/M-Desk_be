import { requireSession } from "@/lib/authorize";
import { updateEmployee } from "@/lib/hr-employees";
import { employeeUpdateSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const input = employeeUpdateSchema.parse(await req.json());
    await updateEmployee(session, id, input);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
