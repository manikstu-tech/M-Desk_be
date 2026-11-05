import type { Tx } from "./audit";

// In-app notifications (M4 adds the bell/page on top of these rows). SMTP later.
export async function notifyUsers(
  tx: Tx,
  userIds: string[],
  msg: { title: string; body?: string; link?: string },
) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await tx.notification.createMany({
    data: unique.map((userId) => ({ ...msg, userId })),
  });
}
