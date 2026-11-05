import { requireSession } from "@/lib/authorize";
import { ok, errorResponse } from "@/lib/validation";

export async function GET() {
  try {
    const session = await requireSession({ allowPasswordChange: true });
    return ok({
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: session.user.role.name,
      mustChangePassword: session.user.mustChangePassword,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
