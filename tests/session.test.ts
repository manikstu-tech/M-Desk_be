import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import {
  issueSession,
  getSessionFromToken,
  revokeAllForUser,
  hashToken,
} from "@/lib/session";

let userId: string;

beforeAll(async () => {
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  const u = await db.user.create({
    data: {
      email: `test-session-${Date.now()}@mdesk.test`,
      name: "Session Test",
      passwordHash: "x",
      roleId: role.id,
    },
  });
  userId = u.id;
});

afterAll(async () => {
  await db.session.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("sessions", () => {
  it("issue → get round trip", async () => {
    const { token } = await issueSession(userId, "vitest");
    const s = await getSessionFromToken(token);
    expect(s?.user.id).toBe(userId);
    expect(s?.token).toBe(hashToken(token)); // raw token never stored
  });

  it("unknown token → null", async () => {
    expect(await getSessionFromToken("nope")).toBeNull();
  });

  it("expired session → null and deleted", async () => {
    const { token } = await issueSession(userId);
    await db.session.update({
      where: { token: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getSessionFromToken(token)).toBeNull();
    expect(await db.session.findUnique({ where: { token: hashToken(token) } })).toBeNull();
  });

  it("disabled user → null and session deleted", async () => {
    const { token } = await issueSession(userId);
    await db.user.update({ where: { id: userId }, data: { status: "DISABLED" } });
    expect(await getSessionFromToken(token)).toBeNull();
    await db.user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  });

  it("revokeAllForUser kills sessions", async () => {
    const { token } = await issueSession(userId);
    await revokeAllForUser(userId);
    expect(await getSessionFromToken(token)).toBeNull();
  });
});
