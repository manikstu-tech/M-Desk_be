import { TaskStatus, UserStatus } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import {
  approvalBacklog,
  ccFilterBacklog,
  ccFilterHeadcount,
  ccFilterInstances,
  ccFilterStages,
  ccFilterTasks,
  ccPeriodKey,
  FINANCE_DEPT,
  headcountByDept,
  KPI_REGISTER,
  maySeeKpi,
  overdueTasksByDept,
  paymentBacklog,
  periodStart,
  type KpiViewer,
} from "@/lib/command-centre";
import { db } from "@/lib/db";
import { documentListWhere } from "@/lib/documents";
import { WF_TERMINAL } from "@/lib/workflows";
import { errorResponse, ok } from "@/lib/validation";

const kpi = (id: string) => KPI_REGISTER.find((e) => e.id === id)!;

/**
 * GET /api/command-centre?dept=<slug>|all&period=
 * Company Command Centre (reports page). Aggregates are computed here and each
 * KPI section is returned only if the viewer's tier may see it (maySeeKpi),
 * so raw tasks, workflow amounts and user lists never reach the browser.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const sp = new URL(req.url).searchParams;
    const now = new Date();

    const [depts, tasks, instances, users, memberships, viewerMships, docCount] = await Promise.all([
      db.department.findMany({ select: { id: true, name: true, slug: true } }),
      db.task.findMany({
        where: { dueAt: { lt: now }, status: { notIn: [TaskStatus.COMPLETED, TaskStatus.CANCELLED] } },
        select: { id: true, departmentId: true, dueAt: true, status: true },
      }),
      db.workflowInstance.findMany({
        where: { status: { notIn: WF_TERMINAL } },
        select: {
          id: true,
          currentStep: true,
          amount: true,
          dueAt: true,
          status: true,
          createdAt: true,
          definition: { select: { key: true, name: true, steps: true } },
        },
      }),
      db.user.findMany({ where: { status: UserStatus.ACTIVE }, select: { id: true, status: true, role: { select: { name: true } } } }),
      db.departmentMembership.findMany({ select: { userId: true, departmentId: true } }),
      db.departmentMembership.findMany({
        where: { userId: session.user.id },
        select: { department: { select: { id: true, name: true, slug: true } } },
      }),
      documentListWhere(session, {}).then((w) => db.document.count({ where: w })),
    ]);

    const viewer: KpiViewer = {
      role: session.user.role.name,
      financeMember: viewerMships.some((m) => m.department.slug === FINANCE_DEPT),
    };
    const sees = (id: string) => maySeeKpi(kpi(id), viewer);

    const period = ccPeriodKey(sp.get("period") ?? undefined);
    const start = periodStart(period, now);
    const deptParam = sp.get("dept");
    const deptSel = deptParam && deptParam !== "all" ? (depts.find((d) => d.slug === deptParam) ?? null) : null;
    const deptId = deptSel?.id ?? null;
    const deptSlug = deptSel?.slug ?? null;
    const fInstances = ccFilterInstances(instances, start);
    const pay = paymentBacklog(fInstances, now);

    return ok({
      asOf: now,
      viewer,
      filters: { period, dept: deptSlug },
      departments: depts,
      visibleKpis: KPI_REGISTER.filter((e) => maySeeKpi(e, viewer)).map((e) => e.id),
      overdue: sees("overdue_tasks") ? overdueTasksByDept(ccFilterTasks(tasks, deptId, start), depts, now) : null,
      approvals: sees("approval_backlog") ? ccFilterBacklog(approvalBacklog(fInstances, now), deptSlug) : null,
      payments: sees("payment_backlog") ? { ...pay, byStage: ccFilterStages(pay.byStage, deptSlug) } : null,
      headcount: sees("headcount") ? ccFilterHeadcount(headcountByDept(users, memberships, depts), deptId) : null,
      documentCount: docCount,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
