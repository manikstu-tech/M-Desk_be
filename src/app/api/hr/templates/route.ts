import { requireSession } from "@/lib/authorize";
import { createTemplateVersion } from "@/lib/hr-letters";
import { templateSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = templateSchema.parse(await req.json());
    const t = await createTemplateVersion(session, input);
    return ok({ id: t.id, version: t.version }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
