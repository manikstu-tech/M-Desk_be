import { requireSession } from "@/lib/authorize";
import { toggleWatch } from "@/lib/tech-items";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const watching = await toggleWatch(session, key.toUpperCase());
    return ok({ watching });
  } catch (e) {
    return errorResponse(e);
  }
}
