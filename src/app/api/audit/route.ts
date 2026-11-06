import { requireSuperAdmin } from "@/lib/authorize";
import { db } from "@/lib/db";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/audit: latest 100 audit events. Super Admin only: it names actors, emails and denied actions. */
export async function GET() {
  try {
    await requireSuperAdmin();
    const events = await db.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { actor: { select: { id: true, name: true, email: true } }, department: { select: { id: true, name: true } } },
    });
    return ok({ events });
  } catch (e) {
    return errorResponse(e);
  }
}
