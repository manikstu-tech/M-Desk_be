import { requireSession } from "@/lib/authorize";
import { rateItem } from "@/lib/tech-items";
import { csatSchema } from "@/lib/tech-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireSession();
    const { key } = await params;
    const row = await rateItem(session, key.toUpperCase(), csatSchema.parse(await req.json()));
    return ok({ key: row.key, csat: row.csat });
  } catch (e) {
    return errorResponse(e);
  }
}
