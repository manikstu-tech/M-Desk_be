import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import type { Prisma, User } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";
import { updateSupabaseUserPassword } from "@/lib/supabase-auth";
import { ApiError } from "@/lib/validation";

// Forgot password. Reset tokens live in the PasswordSetupToken table, so no schema change is
// needed. They are hashed with their own prefix: a reset token can never match an invitation
// row, and an invitation token can never match here.

export const PASSWORD_RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
export const ACCOUNT_LIMIT_PER_HOUR = 3;
const ACCOUNT_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Parallel requests queue here, so waiting for a connection must not fail as a server error.
const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists with this email address, a password reset link has been sent. Please check your inbox and spam folder.";
const INVALID_LINK_MESSAGE =
  "This password reset link is invalid or has expired. Please request a new password reset link.";

const invalidLink = () => new ApiError(400, "INVALID_RESET_LINK", INVALID_LINK_MESSAGE);

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(`password-reset:${token}`).digest("hex");
}

export function createPasswordResetToken(now: Date) {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS),
  };
}

export function resetUrl(token: string) {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) throw new Error("APP_BASE_URL is not set");
  const url = new URL("/login/reset-password", baseUrl);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new Error("APP_BASE_URL must use HTTPS in production");
  }
  // In the fragment, so the token never reaches a server log or a Referer header.
  url.hash = `token=${token}`;
  return url.toString();
}

// ---------- rate limits ----------

const IP_LIMIT = 10;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_TRACKED = 10_000;
type IpWindow = { count: number; resetAt: number };
const store = globalThis as unknown as { passwordResetIps?: Map<string, IpWindow> };

/** Per server instance. The durable limit is the per-account one in requestPasswordReset. */
export function checkIpLimit(ip: string, nowMs = Date.now()) {
  const ips = (store.passwordResetIps ??= new Map());
  if (ips.size > IP_MAX_TRACKED) {
    for (const [key, entry] of ips) if (entry.resetAt <= nowMs) ips.delete(key);
    if (ips.size > IP_MAX_TRACKED) ips.clear();
  }
  const entry = ips.get(ip);
  if (!entry || entry.resetAt <= nowMs) {
    ips.set(ip, { count: 1, resetAt: nowMs + IP_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= IP_LIMIT;
}

// ---------- request ----------

type Send = (message: { to: string; url: string }) => Promise<void>;

/** One active token per user. Returns null when the limits say no email should go out. */
async function issueToken(user: User, now: Date) {
  return db.$transaction(
    async (tx) => {
      // Serialises requests for one user, so parallel calls cannot each get a token.
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${user.id}::text, 0))`;
      const recent = await tx.passwordSetupToken.findMany({
        where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const cooling = recent[0] && now.getTime() - recent[0].createdAt.getTime() < ACCOUNT_COOLDOWN_MS;
      if (cooling || recent.length >= ACCOUNT_LIMIT_PER_HOUR) return null;

      const issued = createPasswordResetToken(now);
      await tx.passwordSetupToken.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date(now.getTime() - DAY_MS) } },
      });
      await tx.passwordSetupToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await tx.passwordSetupToken.create({
        data: { userId: user.id, tokenHash: issued.tokenHash, expiresAt: issued.expiresAt, createdAt: now },
      });
      await writeAudit(tx, {
        actorId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_REQUESTED",
        targetType: "User",
        targetId: user.id,
      });
      return issued;
    },
    TX_OPTIONS,
  );
}

/** Never throws for delivery problems and never reveals whether the account exists. */
export async function requestPasswordReset(email: string, deps: { send?: Send; now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const send = deps.send ?? sendPasswordResetEmail;
  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.status !== "ACTIVE") return;

  const issued = await issueToken(user, now);
  if (!issued) return;

  try {
    await send({ to: user.email, url: resetUrl(issued.token) });
  } catch (e) {
    // The message can hold the link, so log only a code.
    console.error("Password reset email failed", { userId: user.id, code: (e as { code?: unknown }).code ?? "UNKNOWN" });
    await db.$transaction(async (tx) => {
      await tx.passwordSetupToken.updateMany({
        where: { tokenHash: issued.tokenHash, usedAt: null },
        data: { usedAt: new Date() },
      });
      await writeAudit(tx, {
        actorId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_EMAIL_FAILED",
        targetType: "User",
        targetId: user.id,
        outcome: "FAILED",
      });
    });
  }
}

// ---------- reset ----------

async function findActive(token: string, now: Date) {
  const row = await db.passwordSetupToken.findUnique({
    where: { tokenHash: hashPasswordResetToken(token) },
    include: { user: true },
  });
  if (!row || row.usedAt || row.expiresAt <= now || row.user.status !== "ACTIVE") return null;
  return row;
}

export async function isResetTokenValid(token: string, now = new Date()) {
  return (await findActive(token, now)) !== null;
}

async function claim(tx: Pick<Prisma.TransactionClient, "passwordSetupToken">, tokenId: string, now: Date) {
  const claimed = await tx.passwordSetupToken.updateMany({
    where: { id: tokenId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw invalidLink();
}

async function finish(tx: Prisma.TransactionClient, user: User, now: Date, data: Prisma.UserUpdateManyMutationInput) {
  const updated = await tx.user.updateMany({
    where: { id: user.id, status: "ACTIVE" },
    data: { ...data, mustChangePassword: false, passwordSetAt: now },
  });
  if (updated.count !== 1) throw invalidLink();
  await tx.session.deleteMany({ where: { userId: user.id } });
  await writeAudit(tx, {
    actorId: user.id,
    actorEmail: user.email,
    action: "PASSWORD_RESET_COMPLETED",
    targetType: "User",
    targetId: user.id,
  });
}

export async function completePasswordReset(token: string, newPassword: string, now = new Date()) {
  const row = await findActive(token, now);
  if (!row) throw invalidLink();
  const { user } = row;

  if (!user.supabaseAuthUserId) {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.$transaction(async (tx) => {
      await claim(tx, row.id, now);
      await finish(tx, user, now, { passwordHash });
    }, TX_OPTIONS);
    return;
  }

  // Supabase holds this password, so one transaction cannot cover both. Claim the token first
  // so only one request reaches Supabase, and give it back if Supabase fails.
  await claim(db, row.id, now);
  try {
    await updateSupabaseUserPassword(user.supabaseAuthUserId, newPassword);
  } catch (e) {
    await db.$transaction(async (tx) => {
      await tx.passwordSetupToken.updateMany({ where: { id: row.id, usedAt: now }, data: { usedAt: null } });
      await writeAudit(tx, {
        actorId: user.id,
        actorEmail: user.email,
        action: "PASSWORD_RESET_FAILED",
        targetType: "User",
        targetId: user.id,
        outcome: "FAILED",
      });
    });
    throw e;
  }
  await db.$transaction((tx) => finish(tx, user, now, {}), TX_OPTIONS);
}
