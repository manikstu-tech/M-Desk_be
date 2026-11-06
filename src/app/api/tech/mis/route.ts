import { requireSession } from "@/lib/authorize";
import { requireTechMember } from "@/lib/tech-api";
import { misCatalogue } from "@/lib/tech-mis";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/mis: data catalogue and quality checks. */
export async function GET() {
  try {
    const session = await requireSession();
    await requireTechMember(session);
    return ok(await misCatalogue());
  } catch (e) {
    return errorResponse(e);
  }
}
