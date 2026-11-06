import { requireSession } from "@/lib/authorize";
import { recordAttendance } from "@/lib/hr-time";
import { attendanceSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = attendanceSchema.parse(await req.json());
    await recordAttendance(session, input);
    return ok({ recorded: input.entries.length });
  } catch (e) {
    return errorResponse(e);
  }
}
