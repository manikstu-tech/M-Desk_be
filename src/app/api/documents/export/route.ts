import { requireSession } from "@/lib/authorize";
import { exportVisibleDocuments } from "@/lib/documents";
import { documentFiltersSchema, errorResponse } from "@/lib/validation";

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const url = new URL(req.url);
    const filters = documentFiltersSchema.parse({
      q: url.searchParams.get("q") || undefined,
      status: url.searchParams.get("status") || undefined,
      departmentId: url.searchParams.get("departmentId") || undefined,
    });
    const csv = await exportVisibleDocuments(session, filters);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="documents.csv"',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
