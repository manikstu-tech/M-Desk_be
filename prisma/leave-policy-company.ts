import { PrismaClient } from "@prisma/client";

// Company leave policy (HR Data doc, 7 Nov 2026): Earned 12, Sick 10, Casual 8, Optional Holiday 2
// for interns and permanent staff alike; no carry-forward; half-day leave allowed.
//   npx tsx prisma/leave-policy-company.ts
// Updates every active leave policy in place (history of requests stays linked). Safe to run again.
// The change is written to the audit log.

const prisma = new PrismaClient();
const ALLOWANCES = [
  { type: "Earned", days: 12 },
  { type: "Sick", days: 10 },
  { type: "Casual", days: 8 },
  { type: "Optional Holiday", days: 2 },
];
const APPROVAL = "Line manager, then HR";

async function main() {
  const types = ["PERMANENT", "INTERN", "CONTRACT"] as const;
  const year = new Date().getUTCFullYear();
  const hr = await prisma.department.findUnique({ where: { slug: "hr-administration" }, select: { id: true } });
  const changed: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const t of types) {
      const existing = await tx.leavePolicy.findMany({ where: { employmentType: t, active: true } });
      if (existing.length === 0) {
        await tx.leavePolicy.create({
          data: { employmentType: t, name: "Company leave policy", approval: APPROVAL, allowances: ALLOWANCES, effectiveFrom: new Date(Date.UTC(year, 0, 1)) },
        });
        changed.push(`${t}: created`);
        continue;
      }
      for (const p of existing) {
        await tx.leavePolicy.update({ where: { id: p.id }, data: { name: "Company leave policy", approval: APPROVAL, allowances: ALLOWANCES } });
        changed.push(`${t}: updated`);
      }
    }
    await tx.auditEvent.create({
      data: {
        action: "HR_LEAVE_POLICY_LOADED",
        targetType: "LeavePolicy",
        departmentId: hr?.id ?? null,
        outcome: "SUCCESS",
        detail: { source: "HR Data doc (prisma/leave-policy-company.ts)", allowances: ALLOWANCES, changed },
      },
    });
  });

  console.log("Company leave policy: Earned 12, Sick 10, Casual 8, Optional Holiday 2");
  for (const c of changed) console.log(`  ${c}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
