import { requireSession } from "@/lib/authorize";
import { submitLeave } from "@/lib/hr-time";
import { leaveSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = leaveSchema.parse(await req.json());
    const r = await submitLeave(session, input);
    return ok({ id: r.id, days: Number(r.days) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
