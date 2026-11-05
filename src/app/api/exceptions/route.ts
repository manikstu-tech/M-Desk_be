import { RoleName, TaskStatus } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { errorResponse, ok } from "@/lib/validation";

const TERMINAL: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED];

/** GET /api/exceptions: overdue live tasks in the viewer's departments (all departments for the Super Admin). */
export async function GET() {
  try {
    const session = await requireSession();
    const isSuper = session.user.role.name === RoleName.SUPER_ADMIN;
    const memberships = isSuper
      ? []
      : await db.departmentMembership.findMany({ where: { userId: session.user.id }, select: { departmentId: true } });
    const overdueTasks = await db.task.findMany({
      where: {
        status: { notIn: TERMINAL },
        dueAt: { lt: new Date() },
        ...(isSuper ? {} : { departmentId: { in: memberships.map((m) => m.departmentId) } }),
      },
      include: {
        department: true,
        assignee: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: "asc" },
    });
    return ok({ overdueTasks });
  } catch (e) {
    return errorResponse(e);
  }
}
