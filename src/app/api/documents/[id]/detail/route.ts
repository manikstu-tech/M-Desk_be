import { Action, RoleName } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { activeGrant, requireDocView, TRANSITIONS } from "@/lib/documents";
import { ApiError, errorResponse, ok } from "@/lib/validation";

const REVIEW_OUTCOMES = ["APPROVED", "CHANGES_REQUESTED"];
const person = { select: { id: true, name: true, email: true } } as const;

/**
 * GET /api/documents/:id/detail
 * One document with its versions and the status moves this user may make.
 * Not visible and not found both answer 404, so existence is never revealed.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const doc = await db.document.findUnique({
      where: { id },
      include: {
        department: true,
        createdBy: person,
        versions: { orderBy: { version: "desc" }, include: { createdBy: person } },
      },
    });
    if (!doc) throw new ApiError(404, "NOT_FOUND", "Not found");
    try {
      await requireDocView(session, doc);
    } catch (e) {
      if (e instanceof ApiError) throw new ApiError(404, "NOT_FOUND", "Not found");
      throw e;
    }

    const isSuper = session.user.role.name === RoleName.SUPER_ADMIN;
    const grants = isSuper
      ? []
      : await db.delegationGrant.findMany({
          where: { userId: session.user.id, departmentId: doc.departmentId, action: { in: [Action.EDIT, Action.APPROVE] }, ...activeGrant() },
          select: { action: true },
        });
    const canEdit = isSuper || grants.some((g) => g.action === Action.EDIT);
    const canApprove = isSuper || grants.some((g) => g.action === Action.APPROVE);
    const transitions = TRANSITIONS[doc.status].filter((to) => (REVIEW_OUTCOMES.includes(to) ? canApprove : canEdit));
    return ok({ document: doc, canEdit, canApprove, transitions });
  } catch (e) {
    return errorResponse(e);
  }
}
