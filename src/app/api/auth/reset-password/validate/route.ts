import { isResetTokenValid } from "@/lib/password-reset";
import { errorResponse, ok, resetTokenSchema } from "@/lib/validation";

/** POST, so the token stays out of URLs. One answer for missing, wrong, expired and used links. */
export async function POST(req: Request) {
  try {
    const parsed = resetTokenSchema.safeParse(await req.json().catch(() => null));
    return ok({ valid: parsed.success && (await isResetTokenValid(parsed.data.token)) });
  } catch (e) {
    return errorResponse(e);
  }
}
