import { requireSession } from "@/lib/authorize";
import { generateLetter, issueLetter } from "@/lib/hr-letters";
import { generateLetterSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const { mode, ...input } = generateLetterSchema.parse(await req.json());
    if (mode) {
      const issued = await issueLetter(session, { ...input, mode });
      return ok(issued, { status: 201 });
    }
    const letter = await generateLetter(session, input);
    return ok({ id: letter.id, reference: letter.reference }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
