import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/authorize";
import { revokeCurrentSession } from "@/lib/session";
import { ok, errorResponse } from "@/lib/validation";

export async function POST() {
  try {
    const session = await requireSession({ allowPasswordChange: true });
    await revokeCurrentSession();
    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "LOGOUT",
        targetType: "Session",
      }),
    );
    return ok({ loggedOut: true });
  } catch (e) {
    return errorResponse(e);
  }
}
