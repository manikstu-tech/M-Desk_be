import { requireSession } from "@/lib/authorize";
import { addLink } from "@/lib/tech-items";
import { linkSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const link = await addLink(session, key.toUpperCase(), linkSchema.parse(await req.json()));
    return ok({ id: link.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
