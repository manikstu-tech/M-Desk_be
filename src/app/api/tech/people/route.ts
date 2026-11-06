import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { requireTechMember } from "@/lib/tech-api";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/people: active users to pick as custodian or seat holder. Tech agents only (as on the assets and licences pages). */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const people = access.agent
      ? await db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : [];
    return ok({ people, agent: access.agent });
  } catch (e) {
    return errorResponse(e);
  }
}
