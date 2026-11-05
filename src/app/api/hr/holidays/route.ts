import { requireSession } from "@/lib/authorize";
import { addHoliday } from "@/lib/hr-time";
import { holidaySchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = holidaySchema.parse(await req.json());
    const h = await addHoliday(session, input);
    return ok({ id: h.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
