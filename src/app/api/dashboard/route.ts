import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { transitionTarget } from "@/lib/dashboard-stats";
import { documentListWhere } from "@/lib/documents";
import { isPowerBIConfigured } from "@/lib/powerbi";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/dashboard: digital office home. Every document figure is limited to what this viewer may see. */
export async function GET() {
  try {
    const session = await requireSession();
    const visible = await documentListWhere(session, {});
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [departmentTotal, departments, docs, recent, transitions] = await Promise.all([
      db.department.count(),
      db.department.findMany({
        where: { active: true },
        orderBy: { number: "asc" },
        include: { _count: { select: { memberships: true } } },
      }),
      db.document.findMany({ where: visible, select: { id: true, departmentId: true, status: true, createdAt: true } }),
      db.document.findMany({
        where: visible,
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: {
          department: { select: { name: true } },
          createdBy: { select: { name: true } },
          versions: { orderBy: { version: "desc" }, take: 1, select: { mimeType: true, createdBy: { select: { name: true } } } },
        },
      }),
      db.auditEvent.findMany({
        where: { action: "DOCUMENT_STATUS_CHANGED", createdAt: { gte: weekAgo } },
        select: { targetId: true, detail: true, createdAt: true },
      }),
    ]);

    // Only transitions of documents this viewer can see; detail is reduced to the target status.
    const visibleIds = new Set(docs.map((d) => d.id));
    const visibleTransitions = transitions
      .filter((t) => t.targetId && visibleIds.has(t.targetId))
      .map((t) => ({ targetId: t.targetId, to: transitionTarget(t.detail), createdAt: t.createdAt }));

    return ok({
      departmentTotal,
      departments,
      documents: docs,
      recent,
      transitions: visibleTransitions,
      powerBI: isPowerBIConfigured(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
