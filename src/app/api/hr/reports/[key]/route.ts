import { EmploymentType } from "@prisma/client";
import { z } from "zod";
import { requireSession } from "@/lib/authorize";
import { exportReport } from "@/lib/hr-reports";
import { ApiError, errorResponse } from "@/lib/validation";

const filtersSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  employmentType: z.nativeEnum(EmploymentType).optional(),
  departmentId: z.string().min(1).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const sp = new URL(req.url).searchParams;
    const filters = filtersSchema.parse({
      from: sp.get("from") || undefined,
      to: sp.get("to") || undefined,
      employmentType: sp.get("employmentType") || undefined,
      departmentId: sp.get("departmentId") || undefined,
    });
    const result = await exportReport(session, key, filters);
    if (!result) throw new ApiError(404, "NOT_FOUND", "Report not found");
    const name = `${key}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response("\uFEFF" + result.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
