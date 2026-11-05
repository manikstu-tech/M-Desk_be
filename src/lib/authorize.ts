import { Action, RoleName } from "@prisma/client";
import { redirect } from "next/navigation";
import { db } from "./db";
import { writeAudit } from "./audit";
import { loadSession, type SessionRow } from "./session";
import { ApiError } from "./validation";

export type AuthSession = SessionRow;

export async function requireSession(
  options: { allowPasswordChange?: boolean } = {},
): Promise<AuthSession> {
  const s = await loadSession();
  if (!s) throw new ApiError(401, "UNAUTHENTICATED", "Not signed in");
  if (s.user.mustChangePassword && !options.allowPasswordChange) {
    throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Change your password before continuing");
  }
  return s;
}

/** Page-layout gate: redirect instead of throwing. */
export async function requirePageSession(): Promise<AuthSession> {
  const s = await loadSession();
  if (!s) redirect("/login");
  if (s.user.mustChangePassword) redirect("/login/change-password");
  return s;
}

export async function requireSuperAdmin(): Promise<AuthSession> {
  const s = await requireSession();
  if (s.user.role.name !== RoleName.SUPER_ADMIN) {
    throw new ApiError(403, "FORBIDDEN", "Super Admin access required");
  }
  return s;
}

export async function authorize(
  session: AuthSession,
  opts: { departmentId: string; action: Action },
): Promise<void> {
  const { departmentId, action } = opts;
  if (session.user.role.name === RoleName.SUPER_ADMIN) return;

  const grant = await db.delegationGrant.findFirst({
    where: {
      userId: session.user.id,
      departmentId,
      action,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (grant) return;

  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: `DENIED_${action}`,
      targetType: "AUTHORIZE",
      departmentId,
      outcome: "DENIED",
      detail: { action, departmentId },
    }),
  );
  throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource");
}

export async function createGrant(
  session: AuthSession,
  input: {
    userId: string;
    departmentId: string;
    action: Action;
    reason: string;
    expiresAt?: Date;
    namedL4?: boolean;
  },
) {
  if (session.user.role.name !== RoleName.SUPER_ADMIN) {
    await authorize(session, { departmentId: input.departmentId, action: input.action });
    const perm = await db.permission.findUnique({ where: { action: input.action } });
    if (!perm?.delegable) {
      throw new ApiError(403, "FORBIDDEN", "This permission is not delegable");
    }
    if (input.namedL4) {
      // L4 named access is above a normal delegable grant — Super Admin only.
      throw new ApiError(403, "FORBIDDEN", "Only Super Admin can issue L4 named access");
    }
  }

  const grant = await db.$transaction(async (tx) => {
    const row = await tx.delegationGrant.create({
      data: {
        userId: input.userId,
        departmentId: input.departmentId,
        action: input.action,
        confidentiality: input.namedL4 ? "L4" : null,
        grantedById: session.user.id,
        reason: input.reason,
        expiresAt: input.expiresAt ?? null,
      },
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "GRANT_CREATED",
      targetType: "DelegationGrant",
      targetId: row.id,
      departmentId: input.departmentId,
      detail: { userId: input.userId, action: input.action, reason: input.reason },
    });
    return row;
  });
  return grant;
}

export async function revokeGrant(session: AuthSession, grantId: string) {
  const grant = await db.delegationGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new ApiError(404, "NOT_FOUND", "Grant not found");
  if (
    session.user.role.name !== RoleName.SUPER_ADMIN &&
    grant.grantedById !== session.user.id
  ) {
    throw new ApiError(403, "FORBIDDEN", "Only the grantor or Super Admin can revoke this grant");
  }

  await db.$transaction(async (tx) => {
    await tx.delegationGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date(), revokedById: session.user.id },
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "GRANT_REVOKED",
      targetType: "DelegationGrant",
      targetId: grantId,
      departmentId: grant.departmentId,
      detail: { userId: grant.userId, action: grant.action },
    });
  });
}
