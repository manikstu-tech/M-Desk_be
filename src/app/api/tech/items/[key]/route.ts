import { requireSession } from "@/lib/authorize";
import { requireItem, updateItem } from "@/lib/tech-items";
import { updateItemSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const { item } = await requireItem(session, key.toUpperCase());
    return ok(item);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const patch = updateItemSchema.parse(await req.json());
    const item = await updateItem(session, key.toUpperCase(), patch);
    return ok({ key: item.key });
  } catch (e) {
    return errorResponse(e);
  }
}
