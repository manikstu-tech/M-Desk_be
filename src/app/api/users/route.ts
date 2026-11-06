import { UserStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireSession, requireSuperAdmin } from "@/lib/authorize";
import { revokeAllForUser } from "@/lib/session";
import { createSupabaseInviteLink } from "@/lib/supabase-auth";
import { sendPasswordSetupEmail } from "@/lib/email";
import { invitationFailureReason, type InvitationFailureStage } from "@/lib/invitation-failure";
import { ApiError, createUserSchema, ok, errorResponse } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSuperAdmin();
    const input = createUserSchema.parse(await req.json());

    const role = await db.role.findUnique({ where: { name: input.roleName } });
    if (!role) throw new Error("Role not found");

    const user = await db.$transaction(async (tx) => {
      const row = await tx.user.create({
        data: {
          name: input.name,
          email: input.email.toLowerCase(),
          passwordHash: null,
          passwordSetAt: null,
          mustChangePassword: false,
          roleId: role.id,
        },
      });
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "USER_CREATED",
        targetType: "User",
        targetId: row.id,
        detail: { email: row.email, roleName: input.roleName },
      });
      return row;
    });

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
      throw new ApiError(
        502,
        "INVITATION_EMAIL_FAILED",
        `The account was created, but the setup link was not emailed. ${reason}. Check Supabase Auth and SMTP settings, then resend the setup link.`,
      );
    }

    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "USER_INVITATION_EMAIL_SENT",
        targetType: "User",
        targetId: user.id,
        detail: { email: user.email },
      }),
    );

    return ok({ id: user.id, email: user.email, invitationSent: true }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

const toggleSchema = z.object({
  userId: z.string().min(1),
  status: z.nativeEnum(UserStatus),
});

export async function PATCH(req: Request) {
  try {
    const session = await requireSuperAdmin();
    const { userId, status } = toggleSchema.parse(await req.json());

    const user = await db.user.update({ where: { id: userId }, data: { status } });
    if (status === "DISABLED") await revokeAllForUser(userId);

    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: status === "DISABLED" ? "USER_DISABLED" : "USER_ENABLED",
        targetType: "User",
        targetId: userId,
        detail: { email: user.email },
      }),
    );

    return ok({ id: user.id, status: user.status });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /api/users: user directory, departments, roles and delegation grants for the Users & Permissions page.
 * Same audience as the fe page: any signed-in user reads it; only the Super Admin gets edit controls.
 * Only names, emails and statuses leave the server (never password fields).
 */
export async function GET() {
  try {
    const session = await requireSession();
    const [users, departments, roles, grants] = await Promise.all([
      db.user.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          role: { select: { name: true } },
          memberships: { select: { id: true, department: { select: { id: true, name: true } } } },
        },
      }),
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, number: true, name: true } }),
      db.role.findMany({ select: { name: true } }),
      db.delegationGrant.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          userId: true,
          action: true,
          reason: true,
          expiresAt: true,
          revokedAt: true,
          confidentiality: true,
          createdAt: true,
          user: { select: { name: true } },
          department: { select: { name: true } },
          grantedBy: { select: { name: true } },
        },
      }),
    ]);
    return ok({
      isSuperAdmin: session.user.role.name === "SUPER_ADMIN",
      currentUserId: session.user.id,
      roles: roles.map((r) => r.name),
      departments,
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        role: u.role.name,
        memberships: u.memberships.map((m) => ({ id: m.id, departmentId: m.department.id, departmentName: m.department.name })),
      })),
      grants: grants.map((g) => ({
        id: g.id,
        userId: g.userId,
        userName: g.user.name,
        departmentName: g.department.name,
        action: g.action,
        reason: g.reason,
        grantedByName: g.grantedBy.name,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        confidentiality: g.confidentiality,
        createdAt: g.createdAt,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
