import { DocStatus, RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authorize";
import { activeGrant, checkContentLength, createDocument, documentListWhere, type DocumentFilters } from "@/lib/documents";
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

const STATUSES = Object.values(DocStatus);

/** GET /api/documents?q=&status=&departmentId= : visible documents, departments and where this user may upload. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const sp = new URL(req.url).searchParams;
    const isSuper = session.user.role.name === RoleName.SUPER_ADMIN;
    const status = sp.get("status");
    const filters: DocumentFilters = {
      q: sp.get("q")?.trim() || undefined,
      status: STATUSES.find((s) => s === status),
      departmentId: sp.get("departmentId") || undefined,
    };
    const where = await documentListWhere(session, filters);
    const [documents, departments, uploadGrants] = await Promise.all([
      db.document.findMany({ where, include: { department: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" } }),
      isSuper
        ? Promise.resolve([])
        : db.delegationGrant.findMany({
            where: { userId: session.user.id, action: "UPLOAD", ...activeGrant() },
            select: { departmentId: true },
          }),
    ]);
    const uploadDepartments = isSuper ? departments : departments.filter((d) => uploadGrants.some((g) => g.departmentId === d.id));
    return ok({ documents, departments, uploadDepartments, filters });
  } catch (e) {
    return errorResponse(e);
  }
}
