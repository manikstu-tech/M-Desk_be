import { TechItemType } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { canAssign, techAgents } from "@/lib/tech";
import { requireTechMember } from "@/lib/tech-api";
import { listItems } from "@/lib/tech-items";
import { filtersFromParams } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/tech/desk?scope=INCIDENT,REQUEST&<list filters>
 * One workspace list section (service desk, backlog, changes, MIS, security):
 * the filtered items, the section's open items for chip counts, and who may be picked as assignee.
 * scope = the section's item types; ?types= may narrow it but never widen it.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const sp = Object.fromEntries(new URL(req.url).searchParams);
    const scope = (sp.scope ?? "").split(",").filter((t): t is TechItemType => t in TechItemType);
    delete sp.scope;

    const filters = filtersFromParams(sp, { types: scope });
    if (filters.types) filters.types = filters.types.filter((t) => scope.includes(t));
    if (!filters.types?.length) filters.types = scope;

    const listKeys = Object.keys(sp).filter((k) => k !== "sel" && k !== "new" && sp[k]);
    const [items, staff] = await Promise.all([
      listItems(access, filters),
      access.agent ? techAgents(access.dept.id) : Promise.resolve([]),
    ]);
    const openAll = listKeys.length === 0 ? items : await listItems(access, filtersFromParams({}, { types: scope }));
    // only the Super Admin / Tech Head give work to others; staff may log work for themselves
    const agents = canAssign(access) ? staff : staff.filter((a) => a.id === session.user.id);
    const strip = <T extends { watchers?: unknown }>(i: T) => ({ ...i, watchers: undefined });

    return ok({
      items: items.map(strip),
      openAll: openAll.map(strip),
      agents,
      types: filters.types,
      access: { agent: access.agent, lead: access.lead, head: access.head, exporter: access.exporter },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
