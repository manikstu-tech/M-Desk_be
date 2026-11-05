import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import {
  listNotifications,
  markNotificationsRead,
  unreadCount,
} from "@/lib/notifications";
import type { AuthSession } from "@/lib/authorize";

const EMAILS = {
  a: "t.notif.a@mdesk.test",
  b: "t.notif.b@mdesk.test",
};
const createdUserIds: string[] = [];

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return {
    id: "test-session",
    token: "x",
    userId: user.id,
    expiresAt: new Date(Date.now() + 1e12),
    userAgent: null,
    createdAt: new Date(),
    user,
  } as unknown as AuthSession;
}

beforeAll(async () => {
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  for (const email of Object.values(EMAILS)) {
    const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
    createdUserIds.push(u.id);
  }
  await db.notification.createMany({
    data: [
      { userId: createdUserIds[0], title: "unread one" },
      { userId: createdUserIds[0], title: "read one", readAt: new Date() },
      { userId: createdUserIds[1], title: "bert" },
    ],
  });
  // journey notifications may exist for seeded users — only ours are touched
});

afterAll(async () => {
  await db.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

describe("notifications", () => {
  it("lists own rows with unread count and ignores other users", async () => {
    const list = await listNotifications(await sessionFor(EMAILS.a));
    expect(list.rows).toHaveLength(2);
    expect(list.unread).toBe(1);
    expect(await unreadCount(createdUserIds[0])).toBe(1);
  });

  it("marks one then all read; cannot touch someone else's", async () => {
    const session = await sessionFor(EMAILS.a);
    const rows = await db.notification.findMany({
      where: { userId: createdUserIds[0], readAt: null },
      select: { id: true },
    });

    await expect(markNotificationsRead(await sessionFor(EMAILS.b), rows[0].id)).rejects.toMatchObject({
      status: 404,
    });

    expect(await markNotificationsRead(session, rows[0].id)).toBe(1);
    expect(await unreadCount(createdUserIds[0])).toBe(0);
    expect(await markNotificationsRead(await sessionFor(EMAILS.b))).toBe(1);

    // marking an unknown id 404s rather than silently passing
    await expect(markNotificationsRead(session, "nope-nonexistent")).rejects.toMatchObject({ status: 404 });
  });
});
