import { requireSession } from "@/lib/authorize";
import { listCorrections, requestCorrection } from "@/lib/hr-attendance-corrections";
import { correctionRequestSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

/** GET: my correction requests, plus pending ones I may decide (my team as manager, or all with HR EDIT). */
export async function GET() {
  try {
    const session = await requireSession();
    return ok(await listCorrections(session));
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { date, status, reason }: an employee asks to correct one day. */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = correctionRequestSchema.parse(await req.json());
    const c = await requestCorrection(session, input);
    return ok({ id: c.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
