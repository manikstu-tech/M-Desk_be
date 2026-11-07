import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import { parseMuster } from "../src/lib/hr-muster";

// Creates the employees named in a Muster report so its attendance can be imported.
//   npx tsx prisma/muster-employees.ts <Muster.xlsx> [admin-email]
// TEMPORARY: the report only has the employee code and name. Each new employee gets a placeholder
// email, Head office, Permanent, department Technology & MIS / position Software Engineer and
// joining date = first day of the report. Replace these with the real employee list from HR
// (department, position, manager, type, email, joining date) when it arrives.
// Employees that already exist (same code) are left untouched. Safe to run again.

const prisma = new PrismaClient();

async function main() {
  const [file, adminEmail] = process.argv.slice(2);
  if (!file) throw new Error("Usage: npx tsx prisma/muster-employees.ts <Muster.xlsx> [admin-email]");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const muster = parseMuster(wb.worksheets[0]);
  if (!muster) throw new Error("This file is not a Muster Detailed Report");

  const admin = adminEmail
    ? await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } })
    : await prisma.user.findFirstOrThrow({ where: { role: { name: "SUPER_ADMIN" }, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  const position = await prisma.position.findFirstOrThrow({ where: { title: "Software Engineer" } });
  const joining = new Date(`${muster.period?.from ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  let created = 0;
  let existing = 0;
  for (const e of muster.employees) {
    if (await prisma.employee.findUnique({ where: { code: e.code }, select: { id: true } })) {
      existing++;
      continue;
    }
    const title = e.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    await prisma.employee.create({
      data: {
        code: e.code,
        name: title,
        email: `${e.code.toLowerCase()}@placeholder.manikstu.invalid`,
        positionId: position.id,
        departmentId: position.departmentId,
        managerId: admin.id,
        location: "Head office",
        employmentType: "PERMANENT",
        stage: "ACTIVE",
        joiningDate: joining,
        remarks: "Created from the Muster report; replace with real details from the HR employee list",
        createdById: admin.id,
      },
    });
    created++;
  }
  console.log(`Muster employees: ${created} created, ${existing} already existed (${muster.employees.length} in the file)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
