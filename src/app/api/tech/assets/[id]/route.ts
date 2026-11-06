import { requireSession } from "@/lib/authorize";
import { moveAsset } from "@/lib/tech-registers";
import { assetMoveSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

// Custody moves: issue, transfer, return, repair, retire, dispose (append-only events).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const asset = await moveAsset(session, id, assetMoveSchema.parse(await req.json()));
    return ok({ id: asset.id, status: asset.status });
  } catch (e) {
    return errorResponse(e);
  }
}
