import { requireTechMember } from "@/lib/tech-api";
import { TECH_DOC_CATEGORIES, type TechDocCategory } from "@/lib/tech-catalogue";
import { requireSession } from "@/lib/authorize";
import { checkContentLength } from "@/lib/documents";
import { canUploadTech, listTechDocuments, uploadTechDocument, type TechDocFilters } from "@/lib/tech-docs";
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

const CATEGORY_KEYS = Object.keys(TECH_DOC_CATEGORIES) as TechDocCategory[];

/**
 * GET /api/tech/documents?q=&category=&scope=items|library
 * The filtered list plus the whole library (for folder counts and the approval panel).
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const sp = new URL(req.url).searchParams;
    const category = sp.get("category");
    const scope = sp.get("scope");
    const filters: TechDocFilters = {
      q: sp.get("q")?.trim() || undefined,
      category: category === "GENERAL" ? "GENERAL" : CATEGORY_KEYS.find((c) => c === category),
      scope: scope === "items" || scope === "library" ? scope : undefined,
    };
    const filtered = Boolean(filters.q || filters.category || filters.scope);
    const [documents, canUpload] = await Promise.all([listTechDocuments(session, access, filters), canUploadTech(session, access)]);
    const library = filtered ? await listTechDocuments(session, access, {}) : documents;
    return ok({ documents, library, filters, canUpload });
  } catch (e) {
    return errorResponse(e);
  }
}
