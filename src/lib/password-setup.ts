import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ApiError } from "@/lib/validation";

export const PASSWORD_SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createPasswordSetupToken() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashPasswordSetupToken(token),
    expiresAt: new Date(Date.now() + PASSWORD_SETUP_TOKEN_TTL_MS),
  };
}

export function hashPasswordSetupToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function completePasswordSetup(token: string, newPassword: string) {
  const tokenHash = hashPasswordSetupToken(token);
  const setup = await db.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  const now = new Date();

  if (
    !setup ||
    setup.usedAt ||
    setup.expiresAt <= now ||
    setup.user.status !== "ACTIVE" ||
    setup.user.passwordHash !== null
  ) {
    throw new ApiError(400, "INVALID_SETUP_LINK", "This password setup link is invalid or expired");
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.$transaction(async (tx) => {
    const consumed = await tx.passwordSetupToken.updateMany({
      where: { id: setup.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) {
      throw new ApiError(400, "INVALID_SETUP_LINK", "This password setup link is invalid or expired");
    }

    const userUpdate = await tx.user.updateMany({
      where: { id: setup.userId, status: "ACTIVE", passwordHash: null },
      data: { passwordHash, mustChangePassword: false },
    });
    if (userUpdate.count !== 1) {
      throw new ApiError(409, "ACCOUNT_ALREADY_SET_UP", "This account has already been set up");
    }

    await tx.passwordSetupToken.updateMany({
      where: { userId: setup.userId, id: { not: setup.id }, usedAt: null },
      data: { usedAt: now },
    });
    await writeAudit(tx, {
      actorId: setup.userId,
      actorEmail: setup.user.email,
      action: "PASSWORD_SETUP_COMPLETED",
      targetType: "User",
      targetId: setup.userId,
    });
  });
}
