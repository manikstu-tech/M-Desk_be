import { requireSession } from "@/lib/authorize";
import { canAssign } from "@/lib/tech";
import { canUploadTech, itemDocuments } from "@/lib/tech-docs";
import { itemDetail } from "@/lib/tech-items";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/**
 * GET /api/tech/items/:key/detail
 * Full workspace view of one item (comments incl. internal, links, timeline, transitions, attachments).
 * Department members only; requesters use /api/it/:key, which hides internal comments.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const { access, ...detail } = await itemDetail(session, key.toUpperCase());
    if (!access.member) throw new ApiError(403, "FORBIDDEN", "Technology & MIS members only");
    const [attachments, canUpload] = await Promise.all([itemDocuments(session, detail.item.id), canUploadTech(session, access)]);
    return ok({
      ...detail,
      attachments,
      canUpload,
      canAssign: canAssign(access),
      watching: detail.item.watchers.some((w) => w.userId === session.user.id),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
