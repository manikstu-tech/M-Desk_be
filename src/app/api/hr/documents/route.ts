import { requireSession } from "@/lib/authorize";
import { checkContentLength } from "@/lib/documents";
import { uploadHrDocument } from "@/lib/hr-docs";
import { docMetaSchema } from "@/lib/hr-validation";
import { ApiError, errorResponse, ok } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    checkContentLength(req);
    const fd = await req.formData();
    const meta = docMetaSchema.parse({
      employeeId: String(fd.get("employeeId") ?? ""),
      category: String(fd.get("category") ?? ""),
      label: String(fd.get("label") ?? ""),
      expiresAt: fd.get("expiresAt") ? String(fd.get("expiresAt")) : undefined,
    });
    const file = fd.get("file");
    if (!(file instanceof File)) throw new ApiError(422, "VALIDATION", "File is required");
    const doc = await uploadHrDocument(session, meta, file);
    return ok({ id: doc.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
