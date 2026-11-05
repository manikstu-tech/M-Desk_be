import { requireSession } from "@/lib/authorize";
import { getEmbedConfig } from "@/lib/powerbi";
import { ok, errorResponse } from "@/lib/validation";

export async function GET() {
  try {
    await requireSession();
    return ok(await getEmbedConfig(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
