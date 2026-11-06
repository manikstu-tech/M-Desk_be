import { requireSession } from "@/lib/authorize";
import { leaveToDecide, submitLeave } from "@/lib/hr-time";
import { leaveSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

/** Pending leave requests the signed-in user can approve or reject. */
export async function GET() {
  try {
    const session = await requireSession();
    const rows = await leaveToDecide(session);
    return ok({ toDecide: rows.map((r) => ({ ...r, days: Number(r.days) })) });
  } catch (e) {
    return errorResponse(e);
  }
}

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
