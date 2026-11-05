import { requireSession } from "@/lib/authorize";
import { checkContentLength } from "@/lib/documents";
import { uploadTechDocument } from "@/lib/tech-docs";
import { techDocMetaSchema } from "@/lib/tech-validation";
import { ApiError, errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    checkContentLength(req);
    const fd = await req.formData();
    const meta = techDocMetaSchema.parse({
      title: String(fd.get("title") ?? ""),
      category: String(fd.get("category") ?? ""),
      confidentiality: fd.get("confidentiality") ? String(fd.get("confidentiality")) : undefined,
      itemKey: fd.get("itemKey") ? String(fd.get("itemKey")) : undefined,
    });
    const file = fd.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION", "File is required");
    const td = await uploadTechDocument(session, meta, file);
    return ok({ id: td.documentId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
