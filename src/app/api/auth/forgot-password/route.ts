import { after } from "next/server";
import { checkIpLimit, FORGOT_PASSWORD_MESSAGE, requestPasswordReset } from "@/lib/password-reset";
import { ApiError, errorResponse, forgotPasswordSchema, ok } from "@/lib/validation";

/**
 * Only as reliable as the proxy in front: Next.js passes on a header the caller sent, so this
 * limit needs a platform that overwrites it. The per-account limit does not depend on this.
 */
function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
}

export async function POST(req: Request) {
  try {
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON");
    }
    const { email } = forgotPasswordSchema.parse(await req.json().catch(() => null));

    // The work runs after the response, so response time cannot show whether the account exists.
    if (checkIpLimit(clientIp(req))) {
      after(() =>
        requestPasswordReset(email).catch((e: unknown) => {
          console.error("Password reset request failed", { code: (e as { code?: unknown }).code ?? "UNKNOWN" });
        }),
      );
    }
    return ok({ message: FORGOT_PASSWORD_MESSAGE });
  } catch (e) {
    return errorResponse(e);
  }
}
