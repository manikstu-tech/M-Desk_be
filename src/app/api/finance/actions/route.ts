import { requireSession } from "@/lib/authorize";
import { runFinanceAction } from "@/lib/finance";
import { ApiError, errorResponse, ok } from "@/lib/validation";

// Every Finance change goes through here: role check, validation, rule, audit (lib/finance.ts).
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    // JSON only: on top of the SameSite=Lax session cookie, a cross-site HTML form cannot send this.
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON");
    const body = await req.json().catch(() => null);
    return ok(await runFinanceAction(session, body));
  } catch (e) {
    return errorResponse(e);
  }
}
