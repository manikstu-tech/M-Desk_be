import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { ONBOARDING_STAGES } from "@/lib/hr-catalogue";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/hr/onboarding: everyone in the onboarding pipeline, with tasks and documents. fe computes the KPIs. */
export async function GET() {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const [employees, canEdit] = await Promise.all([
      db.employee.findMany({
        where: { stage: { in: [...ONBOARDING_STAGES, "ON_HOLD"] } },
        orderBy: { joiningDate: "asc" },
        select: {
          id: true,
          code: true,
          name: true,
          stage: true,
          employmentType: true,
          joiningDate: true,
          position: { select: { title: true } },
          department: { select: { name: true } },
          tasks: { select: { done: true, dueAt: true, mandatory: true } },
          documents: { select: { label: true, verification: true } },
        },
      }),
      hrCan(session, Action.EDIT),
    ]);
    return ok({ employees, canEdit });
  } catch (e) {
    return errorResponse(e);
  }
}
