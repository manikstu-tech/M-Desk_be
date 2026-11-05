import { Action, EmploymentType, HrDocCategory, LetterStatus, LetterType, VerificationStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
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

function pick<T extends string>(values: readonly T[], v: string | null): T | undefined {
  return values.find((x) => x === v);
}

/** GET /api/hr/letters?status=&type=&q=&category=&verification=&empType= : letters, HR documents and templates. */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;
    const status = pick(Object.values(LetterStatus), sp.get("status"));
    const type = pick(Object.values(LetterType), sp.get("type"));
    const category = pick(Object.values(HrDocCategory), sp.get("category"));
    const verification = pick(Object.values(VerificationStatus), sp.get("verification"));
    const empType = pick(Object.values(EmploymentType), sp.get("empType"));
    const q = sp.get("q")?.trim();
    const empMatch: Prisma.EmployeeWhereInput = {
      ...(empType ? { employmentType: empType } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
              { position: { title: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const [letters, documents, templates, canEdit, canApprove] = await Promise.all([
      db.generatedLetter.findMany({
        where: { ...(status ? { status } : {}), ...(type ? { type } : {}), employee: empMatch },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { employee: { select: { id: true, name: true, code: true } } },
      }),
      db.hrDocument.findMany({
        where: { ...(category ? { category } : {}), ...(verification ? { verification } : {}), employee: empMatch },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: {
          employee: {
            select: { id: true, name: true, code: true, employmentType: true, position: { select: { title: true } } },
          },
        },
      }),
      db.letterTemplate.findMany({ orderBy: [{ type: "asc" }, { employmentType: "asc" }, { version: "desc" }] }),
      hrCan(session, Action.EDIT),
      hrCan(session, Action.APPROVE),
    ]);

    return ok({
      letters,
      documents,
      templates,
      filters: { status: status ?? null, type: type ?? null, category: category ?? null, verification: verification ?? null, empType: empType ?? null, q: q ?? null },
      canEdit,
      canApprove,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
