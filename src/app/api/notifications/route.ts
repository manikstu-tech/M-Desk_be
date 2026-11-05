import { requireSession } from "@/lib/authorize";
import { listNotifications } from "@/lib/notifications";
import { errorResponse, ok } from "@/lib/validation";

export async function GET() {
  try {
    const session = await requireSession();
    const { rows, unread } = await listNotifications(session);
    return ok({ rows, unread });
  } catch (e) {
    return errorResponse(e);
  }
}
