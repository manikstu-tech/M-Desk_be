import { PrismaClient, RoleName } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  const role = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.SUPER_ADMIN } });
  const passwordHash = await bcrypt.hash("ChangeMe!123", 10);
  await prisma.user.upsert({
    where: { email: "admin@manikstu.local" },
    update: {
      name: "Biren Sahoo",
      passwordHash,
      passwordSetAt: null,
      supabaseAuthUserId: null,
      mustChangePassword: true,
      status: "ACTIVE",
      roleId: role.id,
    },
    create: {
      email: "admin@manikstu.local",
      name: "Biren Sahoo",
      passwordHash,
      mustChangePassword: true,
      roleId: role.id,
    },
  });

  console.log("Auth seed complete. Local admin: admin@manikstu.local / ChangeMe!123");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
