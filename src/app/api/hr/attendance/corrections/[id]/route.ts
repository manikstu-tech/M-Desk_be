import { requireSession } from "@/lib/authorize";
import { decideCorrection } from "@/lib/hr-attendance-corrections";
import { correctionDecisionSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

/** POST { action: APPROVE | REJECT | CANCEL, note }: manager / HR decide; the requester may cancel while pending. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const input = correctionDecisionSchema.parse(await req.json());
    return ok({ status: await decideCorrection(session, id, input) });
  } catch (e) {
    return errorResponse(e);
  }
}
