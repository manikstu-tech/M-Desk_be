import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { techAgents } from "@/lib/tech";
import { requireTechMember } from "@/lib/tech-api";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/settings: team, integration connections and this year's holiday count. */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const year = new Date().getFullYear();
    const [team, connections, holidays] = await Promise.all([
      techAgents(access.dept.id),
      db.integrationConnection.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, kind: true, status: true } }),
      db.holiday.count({ where: { date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } } }),
    ]);
    return ok({ team, connections, holidaysThisYear: holidays });
  } catch (e) {
    return errorResponse(e);
  }
}
