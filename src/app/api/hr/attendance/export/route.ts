import { requireSession } from "@/lib/authorize";
import { exportAttendance } from "@/lib/hr-attendance-io";
import { errorResponse } from "@/lib/validation";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** GET /api/hr/attendance/export?month=YYYY-MM: all recorded attendance for the month as Excel. HR EXPORT, audited. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const m = /^(\d{4})-(\d{2})$/.exec(new URL(req.url).searchParams.get("month") ?? "");
    const now = new Date();
    const year = m ? Number(m[1]) : now.getUTCFullYear();
    const month = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? Number(m[2]) : now.getUTCMonth() + 1;
    const buffer = await exportAttendance(session, year, month);
    const name = `attendance-${year}-${String(month).padStart(2, "0")}.xlsx`;
    return new Response(new Uint8Array(buffer), {
      headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
