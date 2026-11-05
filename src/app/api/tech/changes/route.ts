import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { visibleItemsWhere } from "@/lib/tech";
import { requireTechMember } from "@/lib/tech-api";
import { ALL_TERMINAL } from "@/lib/tech-catalogue";
import { errorResponse, ok } from "@/lib/validation";

const DAY = 24 * 60 * 60 * 1000;

/** GET /api/tech/changes: open changes plus anything touched in the last 90 days, visible to this user. */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const now = new Date();
    const changes = await db.techItem.findMany({
      where: {
        AND: [
          visibleItemsWhere(access),
          { type: "CHANGE" },
          { OR: [{ status: { notIn: ALL_TERMINAL } }, { updatedAt: { gte: new Date(now.getTime() - 90 * DAY) } }] },
        ],
      },
      select: { key: true, title: true, status: true, type: true, details: true, createdAt: true },
    });
    return ok({ changes });
  } catch (e) {
    return errorResponse(e);
  }
}
