import { requireSession } from "@/lib/authorize";
import { exportTech } from "@/lib/tech-export";
import { filtersFromParams } from "@/lib/tech-validation";
import { errorResponse } from "@/lib/validation";

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const register = params.register === "assets" || params.register === "licences" ? params.register : "items";
    const filters = filtersFromParams(params, { status: "all" });
    const body = await exportTech(session, register, filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tech-${register}-${stamp}.csv"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
