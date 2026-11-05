import { requireSession } from "@/lib/authorize";
import { transitionItem } from "@/lib/tech-items";
import { transitionSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

// Per-type state machine; illegal moves → 409 + DENIED_TECH_TRANSITION audit (§4.5).
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const row = await transitionItem(session, key.toUpperCase(), transitionSchema.parse(await req.json()));
    return ok({ key: row.key, status: row.status });
  } catch (e) {
    return errorResponse(e);
  }
}
