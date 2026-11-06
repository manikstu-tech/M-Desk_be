import { db } from "./db";
import { ApiError } from "./validation";
import type { AuthSession } from "./authorize";

export async function unreadCount(userId: string) {
  return db.notification.count({ where: { userId, readAt: null } });
}

export async function listNotifications(session: AuthSession) {
  const rows = await db.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { rows, unread: rows.filter((r) => r.readAt === null).length };
}

// id omitted → mark everything unread. Others' rows are never touchable:
// the userId filter doubles as the ownership check (404, not 403 — no leak).
export async function markNotificationsRead(session: AuthSession, id?: string) {
  const res = await db.notification.updateMany({
    where: id ? { id, userId: session.user.id } : { userId: session.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  if (id && res.count === 0) throw new ApiError(404, "NOT_FOUND", "Notification not found");
  return res.count;
}
