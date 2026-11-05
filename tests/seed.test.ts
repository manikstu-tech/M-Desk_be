import { afterAll, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { db } from "@/lib/db";

afterAll(() => db.$disconnect());

describe("seed data", () => {
  it("has the 12 seeded active departments with unique accent colors", async () => {
    // scope to the seed's own range: parallel test files transiently create
    // departments numbered 991+ against the same DB
    const depts = await db.department.findMany({ where: { active: true, number: { lte: 12 } } });
    expect(depts).toHaveLength(12);
    expect(new Set(depts.map((d) => d.accentColor)).size).toBe(12);
  });

  it("has all 9 roles", async () => {
    const roles = await db.role.findMany();
    expect(roles.map((r) => r.name).sort()).toEqual(Object.values(RoleName).sort());
  });

  it("has the permission catalog with AUDIT not delegable", async () => {
    const perms = await db.permission.findMany();
    expect(perms).toHaveLength(Object.values(Action).length);
    expect(perms.find((p) => p.action === "AUDIT")?.delegable).toBe(false);
    expect(perms.find((p) => p.action === "VIEW")?.delegable).toBe(true);
  });

  it("has a super admin user", async () => {
    const admin = await db.user.findUnique({
      where: { email: "admin@manikstu.local" },
      include: { role: true },
    });
    expect(admin?.role.name).toBe(RoleName.SUPER_ADMIN);
  });
});
