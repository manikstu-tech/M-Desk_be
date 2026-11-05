import { requireSession } from "@/lib/authorize";
import { techWorkspace } from "@/lib/tech";
import { createAsset, listAssets } from "@/lib/tech-registers";
import { createAssetSchema } from "@/lib/tech-validation";
import { ApiError, errorResponse, ok } from "@/lib/validation";

export async function GET() {
  try {
    const session = await requireSession();
    if (!(await techWorkspace(session))) throw new ApiError(403, "FORBIDDEN", "Technology & MIS members only");
    return ok(await listAssets());
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const asset = await createAsset(session, createAssetSchema.parse(await req.json()));
    return ok({ id: asset.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
