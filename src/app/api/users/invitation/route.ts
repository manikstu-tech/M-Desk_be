import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/authorize";
import { createSupabaseInviteLink } from "@/lib/supabase-auth";
import { sendPasswordSetupEmail } from "@/lib/email";
import { invitationFailureReason, type InvitationFailureStage } from "@/lib/invitation-failure";
import { ApiError, errorResponse, ok, resendInviteSchema } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSuperAdmin();
    const { userId } = resendInviteSchema.parse(await req.json());
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");
    if (user.status !== "ACTIVE") {
      throw new ApiError(409, "ACCOUNT_DISABLED", "Enable this account before resending its setup link");
    }
    if (user.passwordHash !== null || user.passwordSetAt !== null) {
      throw new ApiError(409, "PASSWORD_ALREADY_SET", "This user has already set a password");
    }

    let failureStage: InvitationFailureStage = "supabase";
    try {
      const invite = await createSupabaseInviteLink({
        email: user.email,
        name: user.name,
        localUserId: user.id,
      });
      failureStage = "database";
      await db.$transaction(async (tx) => {
        if (user.supabaseAuthUserId === invite.userId) return;
        await tx.user.update({ where: { id: user.id }, data: { supabaseAuthUserId: invite.userId } });
        await writeAudit(tx, {
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: "USER_SUPABASE_AUTH_LINKED",
          targetType: "User",
          targetId: user.id,
          detail: { email: user.email },
        });
      });
      failureStage = "smtp";
      await sendPasswordSetupEmail({
        email: user.email,
        name: user.name,
        actionLink: invite.actionLink,
      });
    } catch (emailError) {
      await db.$transaction((tx) =>
        writeAudit(tx, {
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: "USER_INVITATION_EMAIL_FAILED",
          targetType: "User",
          targetId: user.id,
          outcome: "FAILED",
          detail: { email: user.email },
        }),
      );
      const reason = invitationFailureReason(emailError, failureStage);
      throw new ApiError(502, "INVITATION_EMAIL_FAILED", `The setup email was not sent. ${reason}.`);
    }

    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "USER_SETUP_LINK_REISSUED",
        targetType: "User",
        targetId: user.id,
        detail: { email: user.email, resent: true },
      }),
    );

    return ok({ id: user.id, invitationSent: true });
  } catch (e) {
    return errorResponse(e);
  }
}
