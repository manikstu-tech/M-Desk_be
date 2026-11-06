import { requireSession } from "@/lib/authorize";
import { attendanceTemplate } from "@/lib/hr-attendance-io";
import { errorResponse } from "@/lib/validation";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** GET /api/hr/attendance/template?date=YYYY-MM-DD: Excel sheet pre-filled with working employees. HR EDIT. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const d = new URL(req.url).searchParams.get("date");
    const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : new Date();
    const buffer = await attendanceTemplate(session, date);
    const name = `attendance-template-${date.toISOString().slice(0, 10)}.xlsx`;
    return new Response(new Uint8Array(buffer), {
      headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
