import { RoleName } from "@prisma/client";
import { requireSession, type AuthSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { isTaskParticipant, listMyTasks, nextTransitions, transitionLabel, type TaskRow } from "@/lib/tasks";
import { errorResponse, ok } from "@/lib/validation";

const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);

async function withTransitions(session: AuthSession, tasks: TaskRow[]) {
  return Promise.all(
    tasks.map(async (t) => {
      const rules =
        TERMINAL.has(t.status) || !isTaskParticipant(session.user.id, t)
          ? []
          : (await nextTransitions(session, t)).map((r) => ({ ...r, label: transitionLabel(r.to as never, { status: t.status as never }) }));
      return { task: t, transitions: rules };
    }),
  );
}

/** GET /api/my: My Desk. Task buckets with the moves I may make, my departments and their members (for assigning). */
export async function GET() {
  try {
    const session = await requireSession();
    const isSuper = session.user.role.name === RoleName.SUPER_ADMIN;
    const [{ assignedToMe, createdByMe, forReview, department }, memberships] = await Promise.all([
      listMyTasks(session),
      isSuper
        ? Promise.resolve([])
        : db.departmentMembership.findMany({ where: { userId: session.user.id }, include: { department: true } }),
    ]);
    const myDepts = isSuper
      ? await db.department.findMany({ where: { active: true }, orderBy: { number: "asc" } })
      : memberships.map((m) => m.department);
    const memberRows = await db.departmentMembership.findMany({
      where: { departmentId: { in: myDepts.map((d) => d.id) } },
      include: { user: { select: { id: true, name: true } } },
    });
    const membersByDept: Record<string, { id: string; name: string }[]> = {};
    for (const row of memberRows) (membersByDept[row.departmentId] ??= []).push({ id: row.user.id, name: row.user.name });

    const [assigned, created, review, dept] = await Promise.all([
      withTransitions(session, assignedToMe),
      withTransitions(session, createdByMe),
      withTransitions(session, forReview),
      withTransitions(session, department),
    ]);
    return ok({
      assignedToMe: assigned,
      createdByMe: created,
      forReview: review,
      department: dept.filter((row) => !isTaskParticipant(session.user.id, row.task)),
      departments: myDepts.map((d) => ({ id: d.id, name: d.name, number: d.number })),
      membersByDept,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
