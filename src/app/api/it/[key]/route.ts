import { requireSession } from "@/lib/authorize";
import { isRequester } from "@/lib/tech";
import { itemDetail } from "@/lib/tech-items";
import { errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/it/:key
 * Portal view of one item. Internal comments are removed here, on the server,
 * so a requester can never receive them.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const { item, comments, transitions } = await itemDetail(session, key.toUpperCase());
    const mine = isRequester(session.user.id, item);
    const canRate = mine && !!item.resolvedAt && item.csat === null && ["RESOLVED", "CLOSED"].includes(item.status);
    return ok({
      item: { ...item, watchers: undefined },
      comments: comments.filter((c) => !c.internal),
      requesterMoves: mine ? transitions.filter((t) => ["CLOSED", "REOPENED"].includes(t.to)) : [],
      mine,
      canRate,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
