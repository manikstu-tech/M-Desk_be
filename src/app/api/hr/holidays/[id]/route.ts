import { requireSession } from "@/lib/authorize";
import { removeHoliday } from "@/lib/hr-time";
import { errorResponse, ok } from "@/lib/validation";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    await removeHoliday(session, id);
    return ok({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
