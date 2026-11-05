import { requireSession } from "@/lib/authorize";
import { addComment } from "@/lib/tech-items";
import { commentSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const c = await addComment(session, key.toUpperCase(), commentSchema.parse(await req.json()));
    return ok({ id: c.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
