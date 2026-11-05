import { requireSession } from "@/lib/authorize";
import { checkContentLength, createDocument } from "@/lib/documents";
import { documentMetaSchema, errorResponse, ok, ApiError } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    checkContentLength(req);
    const fd = await req.formData();
    const input = documentMetaSchema.parse({
      title: String(fd.get("title") ?? ""),
      departmentId: String(fd.get("departmentId") ?? ""),
      confidentiality: String(fd.get("confidentiality") ?? ""),
    });
    const file = fd.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION", "File is required");
    const doc = await createDocument(session, input, file);
    return ok({ id: doc.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
