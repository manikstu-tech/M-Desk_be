import { Action, EmployeeStage, EmploymentType, type Prisma } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { hrCan, requireHr } from "@/lib/hr";
import { createEmployee } from "@/lib/hr-employees";
import { employeeSchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

const DAY = 24 * 60 * 60 * 1000;
const SIZES = [10, 25, 50];
const VIEWS = ["all", "interns", "onboarding", "probation", "exits", "directory"];
const PRE_ACTIVE: EmployeeStage[] = ["ACCEPTED", "ONBOARDING_IN_PROGRESS"];

function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
}

/**
 * GET /api/hr/employees?q=&type=&stage=&departmentId=&location=&view=&page=&size=
 * Same query the fe Employees page ran directly against the DB.
 * Only list fields are selected: Aadhaar, PAN, bank and pay fields never leave this route.
 */
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    await requireHr(session, Action.VIEW);
    const sp = new URL(req.url).searchParams;

    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const view = VIEWS.find((v) => v === sp.get("view")) ?? "all";
    const size = SIZES.find((n) => String(n) === sp.get("size")) ?? SIZES[0];
    const type = Object.values(EmploymentType).find((t) => t === sp.get("type"));
    const stage = Object.values(EmployeeStage).find((s) => s === sp.get("stage"));
    const q = sp.get("q")?.trim();

    const [departments, locations, probationers] = await Promise.all([
      db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
      db.employee.findMany({ distinct: ["location"], orderBy: { location: "asc" }, select: { location: true } }),
      db.employee.findMany({
        where: { stage: "ACTIVE", probationMonths: { gt: 0 } },
        select: { id: true, joiningDate: true, probationMonths: true },
      }),
    ]);
    const location = locations.find((l) => l.location === sp.get("location"))?.location;
    const departmentId = departments.find((d) => d.id === sp.get("departmentId"))?.id;
    const onProbation = new Set(
      probationers.filter((p) => addMonths(p.joiningDate, p.probationMonths!) > today).map((p) => p.id),
    );

    const viewWhere: Prisma.EmployeeWhereInput =
      view === "interns"
        ? { employmentType: "INTERN" }
        : view === "onboarding"
          ? { stage: { in: PRE_ACTIVE } }
          : view === "probation"
            ? { id: { in: [...onProbation] } }
            : view === "exits"
              ? {
                  OR: [
                    { stage: "EXITED" },
                    { stage: { in: ["ACTIVE", "SUSPENDED"] }, endDate: { gte: today, lte: new Date(today.getTime() + 30 * DAY) } },
                  ],
                }
              : {};
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        viewWhere,
        {
          ...(type ? { employmentType: type } : {}),
          ...(stage ? { stage } : {}),
          ...(departmentId ? { departmentId } : {}),
          ...(location ? { location } : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { code: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                  { position: { title: { contains: q, mode: "insensitive" } } },
                ],
              }
            : {}),
        },
      ],
    };

    const matching = await db.employee.count({ where });
    const pages = Math.max(1, Math.ceil(matching / size));
    const page = Math.min(Math.max(1, Number(sp.get("page")) || 1), pages);

    const [rows, mix, lastMonthTotal, exitingThisMonth, canEdit] = await Promise.all([
      db.employee.findMany({
        where,
        orderBy: { seq: "asc" },
        skip: (page - 1) * size,
        take: size,
        select: {
          id: true,
          code: true,
          name: true,
          email: true,
          phone: true,
          location: true,
          employmentType: true,
          stage: true,
          joiningDate: true,
          endDate: true,
          position: { select: { title: true } },
          department: { select: { name: true } },
          manager: { select: { name: true } },
        },
      }),
      db.employee.groupBy({ by: ["stage", "employmentType"], _count: true }),
      db.employee.count({ where: { createdAt: { lt: monthStart } } }),
      db.employee.count({
        where: { stage: { in: ["ACTIVE", "SUSPENDED", "EXITED"] }, endDate: { gte: monthStart, lt: monthEnd } },
      }),
      hrCan(session, Action.EDIT),
    ]);

    const sum = (f: (r: (typeof mix)[number]) => boolean) => mix.filter(f).reduce((n, r) => n + r._count, 0);
    const total = sum(() => true);

    return ok({
      employees: rows.map((e) => ({ ...e, onProbation: onProbation.has(e.id) })),
      pagination: { page, size, pages, matching },
      stats: {
        total,
        permanent: sum((r) => r.employmentType === "PERMANENT"),
        interns: sum((r) => r.employmentType === "INTERN"),
        onboarding: sum((r) => PRE_ACTIVE.includes(r.stage)),
        active: sum((r) => r.stage === "ACTIVE"),
        exitingThisMonth,
        trend: lastMonthTotal ? Math.round(((total - lastMonthTotal) / lastMonthTotal) * 100) : null,
      },
      filters: {
        departments,
        locations: locations.map((l) => l.location),
        applied: { q: q ?? null, type: type ?? null, stage: stage ?? null, departmentId: departmentId ?? null, location: location ?? null, view },
      },
      canEdit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = employeeSchema.parse(await req.json());
    const emp = await createEmployee(session, input);
    return ok({ id: emp.id, code: emp.code }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
