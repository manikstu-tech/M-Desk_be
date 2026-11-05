import { requireSession } from "@/lib/authorize";
import { techAccess } from "@/lib/tech";
import { createItem, listItems } from "@/lib/tech-items";
import { createItemSchema, filtersFromParams } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

// List what the session may see (visibility ladder in lib/tech.ts) and raise new items.
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const access = await techAccess(session);
    const filters = filtersFromParams(Object.fromEntries(new URL(req.url).searchParams));
    const items = await listItems(access, filters);
    return ok(items.map((i) => ({ ...i, watchers: undefined })));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = createItemSchema.parse(await req.json());
    const item = await createItem(session, input);
    return ok({ id: item.id, key: item.key }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
