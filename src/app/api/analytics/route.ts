import { db } from "@/lib/db";
import { requireSession } from "@/lib/authorize";
import { documentListWhere } from "@/lib/documents";
import { buildAnalytics, buildBuckets, parseRange, periodBounds } from "@/lib/analytics";
import { ok, errorResponse } from "@/lib/validation";

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const range = parseRange(new URL(req.url).searchParams.get("range"));
    const now = new Date();
    const { start } = periodBounds(buildBuckets(range, now));
    // Document figures are limited to what this viewer may see (L1–L4).
    const visible = await documentListWhere(session, {});

    const [docs, users, transitions] = await Promise.all([
      db.document.findMany({ where: visible, select: { id: true, status: true, createdAt: true } }),
      db.user.findMany({ select: { createdAt: true } }),
      db.auditEvent.findMany({
        where: { action: "DOCUMENT_STATUS_CHANGED", createdAt: { gte: start } },
        select: { targetId: true, detail: true, createdAt: true },
      }),
    ]);

    const visibleIds = new Set(docs.map((d) => d.id));
    const payload = buildAnalytics(
      {
        docs,
        users,
        transitions: transitions.filter((t) => t.targetId && visibleIds.has(t.targetId)),
      },
      range,
      now,
    );
    return ok(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
