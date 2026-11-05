import { requireSession } from "@/lib/authorize";
import { requireTechMember } from "@/lib/tech-api";
import { loadCommandCentre } from "@/lib/tech-insights";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/command-centre: tiles, charts and lists for the Tech command centre and reports pages. */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    return ok(await loadCommandCentre(access));
  } catch (e) {
    return errorResponse(e);
  }
}
