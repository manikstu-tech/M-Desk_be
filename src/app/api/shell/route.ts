import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { unreadCount } from "@/lib/notifications";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/shell: signed-in user, unread notification count and department nav for the app shell. */
export async function GET() {
  try {
    const session = await requireSession();
    const [unread, departments] = await Promise.all([
      unreadCount(session.user.id),
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true, slug: true } }),
    ]);
    return ok({
      user: { id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role.name },
      unread,
      departments,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
