import { requireSession } from "@/lib/authorize";
import { createEmployee } from "@/lib/hr-employees";
import { employeeSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = employeeSchema.parse(await req.json());
    const emp = await createEmployee(session, input);
    return ok({ id: emp.id, code: emp.code }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
