import { requireSession } from "@/lib/authorize";
import { addDocumentVersion, checkContentLength } from "@/lib/documents";
import { changeNoteSchema, errorResponse, ok, ApiError } from "@/lib/validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    checkContentLength(req);
    const fd = await req.formData();
    const { changeNote } = changeNoteSchema.parse({
      changeNote: String(fd.get("changeNote") ?? ""),
    });
    const file = fd.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION", "File is required");
    const version = await addDocumentVersion(session, id, file, changeNote);
    return ok({ version }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
