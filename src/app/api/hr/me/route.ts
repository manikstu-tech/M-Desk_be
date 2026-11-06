import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { holidaysFor, leaveBalance } from "@/lib/hr-time";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/hr/me
 * HR self-service for the signed-in user: own profile, sent letters, leave, policies, holidays.
 * Any signed-in user; returns employee: null when the account has no employee record.
 */
export async function GET() {
  try {
    const session = await requireSession();
    const employee = await db.employee.findUnique({
      where: { userId: session.user.id },
      include: {
        position: { select: { title: true } },
        department: { select: { name: true } },
        manager: { select: { name: true } },
        letters: { where: { status: { in: ["SENT", "ACCEPTED"] } }, orderBy: { sentAt: "desc" } },
        leaveRequests: { orderBy: { startDate: "desc" }, take: 20 },
        policyAssignments: { include: { policy: { select: { title: true, version: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!employee) return ok({ employee: null });

    const year = new Date().getUTCFullYear();
    const [balance, holidays] = await Promise.all([
      leaveBalance(employee.id, year),
      holidaysFor(employee.employmentType, employee.location, new Date(), new Date(Date.UTC(year + 1, 11, 31))),
    ]);
    const canApply = (employee.stage === "ACTIVE" || employee.stage === "ONBOARDING_IN_PROGRESS") && balance.rows.length > 0;
    return ok({ employee, leaveBalance: balance, holidays, canApply });
  } catch (e) {
    return errorResponse(e);
  }
}
