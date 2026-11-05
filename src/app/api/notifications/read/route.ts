import { requireSession } from "@/lib/authorize";
import { markNotificationsRead } from "@/lib/notifications";
import { errorResponse, notificationReadSchema, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const { id } = notificationReadSchema.parse(await req.json().catch(() => ({})));
    const count = await markNotificationsRead(session, id);
    return ok({ marked: count });
  } catch (e) {
    return errorResponse(e);
  }
}
