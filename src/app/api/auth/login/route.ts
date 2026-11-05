import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { issueSession, setSessionCookie } from "@/lib/session";
import { signInWithSupabase } from "@/lib/supabase-auth";
import { loginSchema, ok, errorResponse } from "@/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = loginSchema.parse(await req.json());
    const user = await db.user.findUnique({ where: { email: email.toLowerCase() }, include: { role: true } });

    const fail = async (reason: string) => {
      await db.$transaction((tx) =>
        writeAudit(tx, {
          actorEmail: email,
          action: "LOGIN_FAILED",
          targetType: "Session",
          outcome: "DENIED",
          detail: { reason },
        }),
      );
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Invalid email or password" } },
        { status: 403 },
      );
    };

    if (!user || user.status !== "ACTIVE" || (!user.supabaseAuthUserId && !user.passwordHash)) {
      return fail(user ? "inactive-or-password-not-set" : "unknown");
    }
    const valid = user.supabaseAuthUserId
      ? await signInWithSupabase(email.toLowerCase(), password, user.supabaseAuthUserId)
      : await bcrypt.compare(password, user.passwordHash!);
    if (!valid) return fail("bad-password");

    const { token, expiresAt } = await issueSession(user.id, req.headers.get("user-agent") ?? undefined);
    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: user.id,
        actorEmail: user.email,
        action: "LOGIN_SUCCESS",
        targetType: "Session",
      }),
    );
    await setSessionCookie(token, expiresAt);
    return ok({ id: user.id, name: user.name, mustChangePassword: user.mustChangePassword });
  } catch (e) {
    return errorResponse(e);
  }
}
