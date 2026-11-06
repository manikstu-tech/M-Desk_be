import { Action } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr, timelineFor } from "@/lib/hr";
import { LETTERS_FOR_TYPE, maskId } from "@/lib/hr-catalogue";
import { updateEmployee } from "@/lib/hr-employees";
import { activeTemplate, letterSuggestions } from "@/lib/hr-letters";
import { leaveBalance } from "@/lib/hr-time";
import { employeeUpdateSchema } from "@/lib/hr-validation";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/** Identity and account numbers: shown in full only to holders of an HR APPROVE grant. */
const RESTRICTED = ["aadhaarNumber", "panNumber", "bankAccountNumber", "uanNumber", "pfNumber", "esiNumber"] as const;

/**
 * GET /api/hr/employees/:id
 * Everything the fe employee profile page loaded from the DB, in one response.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const { id } = await params;

    const emp = await db.employee.findUnique({
      where: { id },
      include: {
        position: true,
        department: { select: { name: true } },
        manager: { select: { name: true, role: { select: { name: true } } } },
        user: { select: { email: true } },
        tasks: { orderBy: [{ dueAt: "asc" }] },
        letters: { orderBy: { createdAt: "desc" } },
        documents: { orderBy: { createdAt: "desc" } },
        emails: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true } },
        leaveRequests: { orderBy: { startDate: "desc" }, take: 20 },
        attendance: { orderBy: { date: "desc" }, take: 14 },
      },
    });
    if (!emp) throw new ApiError(404, "NOT_FOUND", "Not found");

    const year = new Date().getUTCFullYear();
    const [canEdit, canApprove, canUpload, positions, departments, managers, leave, templates, suggestions, timeline] =
      await Promise.all([
        hrCan(session, Action.EDIT),
        hrCan(session, Action.APPROVE),
        hrCan(session, Action.UPLOAD),
        db.position.findMany({
          where: { active: true },
          orderBy: { title: "asc" },
          select: { id: true, title: true, grade: true, departmentId: true },
        }),
        db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
        db.user.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
        leaveBalance(emp.id, year),
        Promise.all(
          LETTERS_FOR_TYPE[emp.employmentType].map(async (t) => ({
            type: t,
            available: !!(await activeTemplate(t, emp.employmentType)),
          })),
        ),
        letterSuggestions({ id: emp.id }),
        timelineFor([
          emp.id,
          ...emp.letters.map((l) => l.id),
          ...emp.documents.map((d) => d.id),
          ...emp.emails.map((e) => e.id),
          ...emp.leaveRequests.map((l) => l.id),
        ]),
      ]);

    const employee: Record<string, unknown> = { ...emp };
    if (!canApprove) for (const f of RESTRICTED) employee[f] = emp[f] ? maskId(emp[f]) : null;

    return ok({
      employee,
      leaveBalance: leave,
      letterTemplates: templates,
      letterSuggestions: suggestions,
      timeline,
      lookups: { positions, departments, managers },
      permissions: { canEdit, canApprove, canUpload },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const input = employeeUpdateSchema.parse(await req.json());
    await updateEmployee(session, id, input);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}