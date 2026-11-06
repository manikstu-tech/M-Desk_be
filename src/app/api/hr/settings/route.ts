import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { EMAIL_FROM, EMAIL_PROVIDER } from "@/lib/hr-email";
import { companyDetails } from "@/lib/hr-letters";
import { errorResponse, ok } from "@/lib/validation";

const PAGE = 50;

/** GET /api/hr/settings?page= : positions, departments, HR audit trail and integration status. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const dept = await requireHr(session, Action.VIEW);
    const page = Math.max(1, Number(new URL(req.url).searchParams.get("page")) || 1);

    const [positions, departments, audit, total, canEdit] = await Promise.all([
      db.position.findMany({
        orderBy: [{ active: "desc" }, { title: "asc" }],
        include: { department: { select: { id: true, name: true } }, _count: { select: { employees: true } } },
      }),
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
      db.auditEvent.findMany({
        where: { departmentId: dept.id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: { id: true, action: true, targetType: true, outcome: true, createdAt: true, actorEmail: true },
      }),
      db.auditEvent.count({ where: { departmentId: dept.id } }),
      hrCan(session, Action.EDIT),
    ]);

    const company = companyDetails();
    return ok({
      positions,
      departments,
      audit: { rows: audit, total, page, pageSize: PAGE },
      company,
      missingCompany: Object.entries(company).filter(([, v]) => !v).map(([k]) => k),
      email: { provider: EMAIL_PROVIDER, from: EMAIL_FROM },
      canEdit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
