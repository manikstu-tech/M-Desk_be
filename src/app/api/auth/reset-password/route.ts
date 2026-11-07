import { completePasswordReset } from "@/lib/password-reset";
import { ApiError, errorResponse, ok, resetPasswordSchema } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON");
    }
    const { token, newPassword } = resetPasswordSchema.parse(await req.json().catch(() => null));
    await completePasswordReset(token, newPassword);
    return ok({ passwordReset: true });
  } catch (e) {
    return errorResponse(e);
  }
}
