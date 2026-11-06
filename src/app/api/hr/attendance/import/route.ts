import { requireSession } from "@/lib/authorize";
import { checkContentLength } from "@/lib/documents";
import { importAttendance } from "@/lib/hr-attendance-io";
import { ApiError, errorResponse, ok } from "@/lib/validation";

/**
 * POST /api/hr/attendance/import (multipart: file = .xlsx or .csv). HR EDIT.
 * All rows are validated first; nothing is saved if any row has an error,
 * and the rows to fix come back with status 422.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    checkContentLength(req);
    const file = (await req.formData()).get("file");
    if (!(file instanceof File) || file.size === 0) throw new ApiError(422, "VALIDATION", "Choose a file to upload");
    const result = await importAttendance(session, file);
    return ok(result, { status: result.saved ? 201 : 422 });
  } catch (e) {
    return errorResponse(e);
  }
}
