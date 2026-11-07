import { PrismaClient } from "@prisma/client";

// Removes the demo / test HR employees and everything hanging off them, so the company's
// real Muster file can be loaded onto a clean slate.
//   npx tsx prisma/clear-demo-hr.ts          -> only LISTS what would be deleted
//   npx tsx prisma/clear-demo-hr.ts --yes    -> deletes it
// "Demo" = every employee whose ID is not in the company format EA00001. Company
// employees (EA#####) are never touched. Login accounts are kept; they only lose the link.
// Holidays, leave policies, departments and the audit log are left alone.

const prisma = new PrismaClient();
const COMPANY = /^EA\d{5}$/;

async function main() {
  const all = await prisma.employee.findMany({ select: { id: true, code: true, name: true, email: true, userId: true } });
  const targets = all.filter((e) => !(e.code && COMPANY.test(e.code)));
  const keep = all.length - targets.length;
  const ids = targets.map((t) => t.id);
  const where = { employeeId: { in: ids } };

  const counts = {
    attendance: await prisma.attendanceRecord.count({ where }),
    corrections: await prisma.attendanceCorrection.count({ where }),
    leave: await prisma.leaveRequest.count({ where }),
    onboardingTasks: await prisma.onboardingTask.count({ where }),
    letters: await prisma.generatedLetter.count({ where }),
    documents: await prisma.hrDocument.count({ where }),
    policyAssignments: await prisma.policyAssignment.count({ where }),
  };
  console.log(`Employees to delete: ${targets.length} (keeping ${keep} company employees)`);
  for (const t of targets) console.log(`  ${t.code ?? "(no id)"}  ${t.name}  <${t.email}>${t.userId ? "  [has login]" : ""}`);
  console.log("Linked rows:", counts);

  if (!process.argv.includes("--yes")) {
    console.log("\nDry run. Nothing deleted. Add --yes to delete.");
    return;
  }
  if (!ids.length) return console.log("Nothing to delete.");

  await prisma.$transaction(async (tx) => {
    const hrDocs = await tx.hrDocument.findMany({ where, select: { documentId: true } });
    const letters = await tx.generatedLetter.findMany({ where, select: { documentId: true } });
    await tx.attendanceCorrection.deleteMany({ where });
    await tx.attendanceRecord.deleteMany({ where });
    await tx.leaveRequest.deleteMany({ where });
    await tx.onboardingTask.deleteMany({ where });
    await tx.policyAssignment.deleteMany({ where });
    await tx.emailLog.deleteMany({ where });
    await tx.hrDocument.deleteMany({ where });
    await tx.generatedLetter.deleteMany({ where });
    const docIds = [...hrDocs, ...letters].map((d) => d.documentId).filter((x): x is string => !!x);
    if (docIds.length) await tx.document.deleteMany({ where: { id: { in: docIds } } });
    await tx.employee.deleteMany({ where: { id: { in: ids } } });
    await tx.auditEvent.create({
      data: { actorEmail: "clear-demo-hr", action: "HR_DEMO_DATA_CLEARED", targetType: "Employee", detail: { employees: targets.length, ...counts } },
    });
  });
  console.log("Done. Now load the company Muster: npx tsx prisma/muster-employees.ts <file.xlsx>");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
