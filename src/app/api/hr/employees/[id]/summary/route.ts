import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/employees/:id/summary?lookups=1
 * Header data for the KRA (assign / review / yearly) and promote pages.
 * lookups=1 adds positions, departments and managers for the promote form.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const { id } = await params;
    const withLookups = new URL(req.url).searchParams.get("lookups") === "1";

    const employee = await db.employee.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        name: true,
        stage: true,
        joiningDate: true,
        departmentId: true,
        positionId: true,
        position: { select: { title: true, grade: true } },
        department: { select: { name: true } },
        manager: { select: { name: true } },
      },
    });
    if (!employee) throw new ApiError(404, "NOT_FOUND", "Not found");

    const [canEdit, lookups] = await Promise.all([
      hrCan(session, Action.EDIT),
      withLookups
        ? Promise.all([
            db.position.findMany({
              where: { active: true },
              orderBy: { title: "asc" },
              select: { id: true, title: true, grade: true, departmentId: true },
            }),
            db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
            db.user.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
          ]).then(([positions, departments, managers]) => ({ positions, departments, managers }))
        : Promise.resolve(null),
    ]);

    return ok({ employee, canEdit, lookups });
  } catch (e) {
    return errorResponse(e);
  }
}
