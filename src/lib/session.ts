import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";

export const SESSION_COOKIE = "mdesk_session";
const SESSION_DAYS = 7;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionRow = NonNullable<Awaited<ReturnType<typeof getSessionFromToken>>>;

/** Creates the session row and returns the raw cookie token (never stored). */
export async function issueSession(userId: string, userAgent?: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({
    data: { token: hashToken(token), userId, expiresAt, userAgent: userAgent ?? null },
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSessionFromToken(token: string) {
  const session = await db.session.findUnique({
    where: { token: hashToken(token) },
    include: { user: { include: { role: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date() || session.user.status !== "ACTIVE") {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session;
}

export async function loadSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionFromToken(token);
}

export async function revokeCurrentSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { token: hashToken(token) } });
  store.delete(SESSION_COOKIE);
}

export async function revokeAllForUser(userId: string) {
  await db.session.deleteMany({ where: { userId } });
}
