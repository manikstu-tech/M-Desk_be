import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/authorize";
import { revokeAllForUser } from "@/lib/session";
import { completePasswordSetup } from "@/lib/password-setup";
import {
  getSupabaseUserFromInvite,
  setSupabasePasswordFromInvite,
  updateSupabaseUserPassword,
} from "@/lib/supabase-auth";
import {
  ApiError,
  changePasswordSchema,
  errorResponse,
  ok,
  setPasswordFromSupabaseInviteSchema,
  setPasswordFromInviteSchema,
} from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const payload: unknown = await req.json();
    if (typeof payload === "object" && payload !== null && "token" in payload) {
      const { token, newPassword } = setPasswordFromInviteSchema.parse(payload);
      await completePasswordSetup(token, newPassword);
      return ok({ passwordSet: true });
    }
    if (typeof payload === "object" && payload !== null && "accessToken" in payload) {
      const { accessToken, newPassword } = setPasswordFromSupabaseInviteSchema.parse(payload);
      const authUser = await getSupabaseUserFromInvite(accessToken);
      const metadataId = authUser.user_metadata?.mdesk_user_id;
      const user = typeof metadataId === "string"
        ? await db.user.findUnique({ where: { id: metadataId } })
        : await db.user.findUnique({ where: { supabaseAuthUserId: authUser.id } });

      if (
        !user ||
        user.email !== authUser.email?.toLowerCase() ||
        (user.supabaseAuthUserId && user.supabaseAuthUserId !== authUser.id) ||
        user.status !== "ACTIVE"
      ) {
        throw new ApiError(400, "INVALID_INVITATION", "This invitation is not linked to an active M-DESK account");
      }
      if (user.passwordSetAt || user.passwordHash !== null) {
        throw new ApiError(400, "INVITATION_ALREADY_USED", "This invitation has already been used");
      }

      const claimAt = new Date();
      const claimed = await db.$transaction(async (tx) => {
        const result = await tx.user.updateMany({
          where: {
            id: user.id,
            status: "ACTIVE",
            passwordHash: null,
            passwordSetAt: null,
            supabaseAuthUserId: user.supabaseAuthUserId,
          },
          data: {
            supabaseAuthUserId: authUser.id,
            passwordSetAt: claimAt,
            mustChangePassword: false,
          },
        });
        if (result.count !== 1) return false;
        await writeAudit(tx, {
          actorId: user.id,
          actorEmail: user.email,
          action: "PASSWORD_SETUP_STARTED",
          targetType: "User",
          targetId: user.id,
        });
        return true;
      });
      if (!claimed) {
        throw new ApiError(400, "INVITATION_ALREADY_USED", "This invitation has already been used");
      }

      try {
        await setSupabasePasswordFromInvite(accessToken, newPassword);
      } catch (e) {
        await db.$transaction(async (tx) => {
          const released = await tx.user.updateMany({
            where: { id: user.id, passwordSetAt: claimAt },
            data: { passwordSetAt: null },
          });
          if (released.count === 1) {
            await writeAudit(tx, {
              actorId: user.id,
              actorEmail: user.email,
              action: "PASSWORD_SETUP_FAILED",
              targetType: "User",
              targetId: user.id,
              outcome: "FAILED",
            });
          }
        });
        throw e;
      }

      await db.$transaction(async (tx) => {
        const completed = await tx.user.updateMany({
          where: {
            id: user.id,
            status: "ACTIVE",
            passwordSetAt: claimAt,
            supabaseAuthUserId: authUser.id,
          },
          data: { passwordSetAt: new Date(), mustChangePassword: false },
        });
        if (completed.count !== 1) {
          throw new ApiError(409, "ACCOUNT_SETUP_CONFLICT", "The account changed while password setup was in progress");
        }
        await writeAudit(tx, {
          actorId: user.id,
          actorEmail: user.email,
          action: "PASSWORD_SET_FROM_INVITE",
          targetType: "User",
          targetId: user.id,
        });
      });
      return ok({ passwordSet: true });
    }

    const session = await requireSession({ allowPasswordChange: true });
    const { newPassword } = changePasswordSchema.parse(payload);

    if (session.user.supabaseAuthUserId) {
      await updateSupabaseUserPassword(session.user.supabaseAuthUserId, newPassword);
    }
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: session.user.id },
        data: {
          passwordHash: session.user.supabaseAuthUserId ? null : await bcrypt.hash(newPassword, 10),
          mustChangePassword: false,
        },
      });
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "PASSWORD_CHANGED",
        targetType: "User",
        targetId: session.user.id,
      });
    });
    await revokeAllForUser(session.user.id);
    return ok({ changed: true });
  } catch (e) {
    return errorResponse(e);
  }
}
