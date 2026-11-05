import { DocStatus, PrismaClient, RoleName } from "@prisma/client";

// Sample data so the dashboard analytics have something to show.
//   npm run db:demo          → add (re-running replaces the previous demo set)
//   npm run db:demo:remove   → remove
// Demo documents are titled "[Demo] …" and demo users use @demo.manikstu.local.
// Their status-change audit events are left in place on removal (the audit log is
// append-only); with the documents gone, the charts ignore them.

const prisma = new PrismaClient();

const DEMO_PREFIX = "[Demo] ";
const DEMO_DOMAIN = "@demo.manikstu.local";
const DAY = 86_400_000;

const PEOPLE = ["Asha Patnaik", "Rakesh Das", "Meera Sahu", "Sunil Mohanty", "Priya Nayak", "Arjun Behera"];

const TITLES = [
  "Quarterly Field Report",
  "Goat Procurement Plan",
  "Vaccination Schedule",
  "Vendor Agreement",
  "Budget Utilisation Statement",
  "Beneficiary Onboarding Checklist",
  "Shed Construction Estimate",
  "Training Attendance Register",
  "Partner MoU Draft",
  "Monthly MIS Summary",
  "Insurance Claim Summary",
  "Leave Policy Update",
  "FPO Collaboration Proposal",
  "Veterinary Visit Log",
];

// Small deterministic PRNG so every run produces the same picture.
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const days = (min: number, max: number) => (min + rand() * (max - min)) * DAY;

async function remove() {
  const docs = await prisma.document.deleteMany({ where: { title: { startsWith: DEMO_PREFIX } } });
  const users = await prisma.user.deleteMany({ where: { email: { endsWith: DEMO_DOMAIN } } });
  console.log(`Removed ${docs.count} demo documents and ${users.count} demo users.`);
}

async function add() {
  await remove();
  const now = Date.now();

  const role =
    (await prisma.role.findUnique({ where: { name: RoleName.OFFICER } })) ??
    (await prisma.role.findFirstOrThrow({ where: { name: { not: RoleName.SUPER_ADMIN } } }));
  const departments = await prisma.department.findMany({
    where: { active: true, number: { lte: 12 } },
    orderBy: { number: "asc" },
  });
  if (!departments.length) throw new Error("No departments found. Run `npm run db:seed` first.");

  // Users joined over the last ~5 months, so the users growth line climbs.
  const users = [];
  for (const [i, name] of PEOPLE.entries()) {
    users.push(
      await prisma.user.create({
        data: {
          name,
          email: name.toLowerCase().replace(/\s+/g, ".") + DEMO_DOMAIN,
          passwordHash: "!demo-account-cannot-log-in",
          roleId: role.id,
          createdAt: new Date(now - (150 - i * 25) * DAY),
        },
      }),
    );
  }

  let docCount = 0;
  let eventCount = 0;
  for (let i = 0; i < 42; i++) {
    // Skew creation toward recent weeks so growth accelerates.
    const createdAt = new Date(now - Math.pow(rand(), 1.6) * 160 * DAY);
    const author = pick(users);
    const dept = pick(departments);

    // Walk a realistic lifecycle, stopping at whatever step would be in the future.
    const steps: { to: DocStatus; at: number }[] = [];
    let at = createdAt.getTime();
    let status = DocStatus.DRAFT as DocStatus; // widened: `go` reassigns it
    const go = (to: DocStatus, min: number, max: number) => {
      const next = at + days(min, max);
      if (next > now) return false;
      at = next;
      status = to;
      steps.push({ to, at });
      return true;
    };

    if (rand() < 0.85 && go(DocStatus.IN_REVIEW, 0.5, 4)) {
      if (rand() < 0.25 && go(DocStatus.CHANGES_REQUESTED, 0.5, 3)) {
        if (rand() < 0.7 && go(DocStatus.REVISED, 0.5, 3)) go(DocStatus.IN_REVIEW, 0.1, 1);
      }
      if (status === DocStatus.IN_REVIEW && rand() < 0.8 && go(DocStatus.APPROVED, 0.2, 5)) {
        if (rand() < 0.5) go(DocStatus.PUBLISHED, 0.5, 4);
      }
    }

    const doc = await prisma.document.create({
      data: {
        title: `${DEMO_PREFIX}${pick(TITLES)} ${String(i + 1).padStart(2, "0")}`,
        departmentId: dept.id,
        createdById: author.id,
        status,
        createdAt,
      },
    });
    docCount++;

    let from: DocStatus = DocStatus.DRAFT;
    for (const s of steps) {
      await prisma.auditEvent.create({
        data: {
          actorEmail: "demo-data",
          action: "DOCUMENT_STATUS_CHANGED",
          targetType: "Document",
          targetId: doc.id,
          departmentId: dept.id,
          detail: { from, to: s.to, demo: true },
          createdAt: new Date(s.at),
        },
      });
      from = s.to;
      eventCount++;
    }
  }

  console.log(`Added ${users.length} demo users, ${docCount} demo documents and ${eventCount} status changes.`);
}

(process.argv.includes("--remove") ? remove() : add())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
