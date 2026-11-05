import bcrypt from "bcryptjs";
import { PrismaClient, RoleName } from "@prisma/client";

// LOCAL TESTING ONLY — sign-in accounts for checking Finance & Accounts roles by hand.
//   npm run db:finance-users          → create / refresh
//   npm run db:finance-users -- --remove
// Password: FINANCE_TEST_PASSWORD from the environment, else the default below.
// Never run against a shared or production database.

const prisma = new PrismaClient();
const DOMAIN = "@test.manikstu.local";
const PASSWORD = process.env.FINANCE_TEST_PASSWORD || "FinTest-2026";

const USERS: { email: string; name: string; role: RoleName; dept: string }[] = [
  { email: `finance.head${DOMAIN}`, name: "Test Finance Head", role: RoleName.ADMIN, dept: "finance-accounts" },
  { email: `accountant${DOMAIN}`, name: "Test Accountant", role: RoleName.OFFICER, dept: "finance-accounts" },
  { email: `finance.viewer${DOMAIN}`, name: "Test Finance Viewer", role: RoleName.DEPT_AUDITOR, dept: "finance-accounts" },
  { email: `outsider${DOMAIN}`, name: "Test HR Officer (no Finance access)", role: RoleName.OFFICER, dept: "hr-administration" },
];

async function remove() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  const n = await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`Removed ${n.count} Finance test users.`);
}

async function add() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  for (const u of USERS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    const dept = await prisma.department.findUniqueOrThrow({ where: { slug: u.dept } });
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, roleId: role.id, passwordHash, mustChangePassword: false, status: "ACTIVE" },
      create: { email: u.email, name: u.name, roleId: role.id, passwordHash, mustChangePassword: false },
    });
    await prisma.departmentMembership.upsert({
      where: { userId_departmentId: { userId: user.id, departmentId: dept.id } },
      update: {},
      create: { userId: user.id, departmentId: dept.id },
    });
  }
  console.log(`Finance test users ready (${USERS.map((u) => u.email).join(", ")}).`);
}

(process.argv.includes("--remove") ? remove() : add())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
