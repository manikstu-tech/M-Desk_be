import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { techAccess } from "@/lib/tech";
import { listItems } from "@/lib/tech-items";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/it: IT service portal. Only items the user takes part in, even for staff and the Super Admin. */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await techAccess(session);
    const asRequester = { ...access, member: false, isSuper: false };
    const [open, closed, people] = await Promise.all([
      listItems(asRequester, { status: "open" }, 100),
      listItems(asRequester, { status: "closed", days: 90 }, 50),
      db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const strip = <T extends { watchers?: unknown }>(i: T) => ({ ...i, watchers: undefined });
    return ok({ open: open.map(strip), closed: closed.map(strip), people });
  } catch (e) {
    return errorResponse(e);
  }
}
