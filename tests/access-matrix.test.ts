import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import {
  authorize,
  createGrant,
  revokeGrant,
  type AuthSession,
} from "@/lib/authorize";

let deptA: string;
let deptB: string;
const officerEmail = "test-officer@mdesk.test";
const adminEmail = "test-admin@mdesk.test";
const createdUserIds: string[] = [];

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return {
    id: "test-session",
    token: "x",
    userId: user.id,
    expiresAt: new Date(Date.now() + 1e12),
    userAgent: null,
    createdAt: new Date(),
    user,
  } as unknown as AuthSession;
}

async function superSession(): Promise<AuthSession> {
  return sessionFor("admin@manikstu.local");
}

async function mkUser(email: string, roleName: RoleName) {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  const u = await db.user.create({
    data: {
      email,
      name: email,
      passwordHash: "x",
      roleId: role.id,
    },
  });
  createdUserIds.push(u.id);
  return u;
}

beforeAll(async () => {
  const [a, b] = await Promise.all([
    db.department.upsert({
      where: { slug: "test-dept-a" },
      update: {},
      create: { number: 991, name: "Test Dept A", slug: "test-dept-a", accentColor: "#111111" },
    }),
    db.department.upsert({
      where: { slug: "test-dept-b" },
      update: {},
      create: { number: 992, name: "Test Dept B", slug: "test-dept-b", accentColor: "#222222" },
    }),
  ]);
  deptA = a.id;
  deptB = b.id;
  await mkUser(officerEmail, RoleName.OFFICER);
  await mkUser(adminEmail, RoleName.ADMIN);
});

afterAll(async () => {
  const ids = createdUserIds;
  await db.delegationGrant.deleteMany({ where: { userId: { in: ids } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { slug: { in: ["test-dept-a", "test-dept-b"] } } });
  await db.$disconnect();
});

async function expectDenied(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
}

describe("access matrix", () => {
  it("super admin can authorize anything", async () => {
    const superUser = await db.user.findUniqueOrThrow({
      where: { email: "admin@manikstu.local" },
      include: { role: true },
    });
    const s = {
      id: "s",
      token: "x",
      userId: superUser.id,
      expiresAt: new Date(Date.now() + 1e12),
      userAgent: null,
      createdAt: new Date(),
      user: superUser,
    } as unknown as AuthSession;
    await expect(authorize(s, { departmentId: deptA, action: Action.EDIT })).resolves.toBeUndefined();
  });

  it("no grant → deny", async () => {
    const s = await sessionFor(officerEmail);
    await expectDenied(authorize(s, { departmentId: deptA, action: Action.VIEW }));
  });

  it("valid grant → allow own dept/action only", async () => {
    const superS = await superSession();
    const officer = await db.user.findUniqueOrThrow({ where: { email: officerEmail } });
    const grant = await createGrant(superS, {
      userId: officer.id,
      departmentId: deptA,
      action: Action.VIEW,
      reason: "matrix test",
    });

    const s = await sessionFor(officerEmail);
    await expect(authorize(s, { departmentId: deptA, action: Action.VIEW })).resolves.toBeUndefined();
    await expectDenied(authorize(s, { departmentId: deptB, action: Action.VIEW }));
    await expectDenied(authorize(s, { departmentId: deptA, action: Action.EDIT }));

    // expiry → deny
    await db.delegationGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectDenied(authorize(s, { departmentId: deptA, action: Action.VIEW }));

    // revoke → deny
    await db.delegationGrant.update({
      where: { id: grant.id },
      data: { expiresAt: null, revokedAt: new Date() },
    });
    await expectDenied(authorize(s, { departmentId: deptA, action: Action.VIEW }));
  });

  it("admin can delegate held + delegable, not AUDIT, not unheld", async () => {
    const adminS = await sessionFor(adminEmail);
    const officer = await db.user.findUniqueOrThrow({ where: { email: officerEmail } });

    // only super admin can seed an admin's first scope (FR-03)
    await createGrant(await superSession(), {
      userId: adminS.user.id,
      departmentId: deptA,
      action: Action.VIEW,
      reason: "seed admin scope",
    });
    await createGrant(adminS, {
      userId: officer.id,
      departmentId: deptA,
      action: Action.VIEW,
      reason: "delegate view",
    });

    await expectDenied(
      createGrant(adminS, {
        userId: officer.id,
        departmentId: deptA,
        action: Action.AUDIT,
        reason: "not delegable",
      }),
    );

    await expectDenied(
      createGrant(adminS, {
        userId: officer.id,
        departmentId: deptB,
        action: Action.EDIT,
        reason: "beyond scope",
      }),
    );
  });

  it("only grantor or super admin can revoke", async () => {
    const adminS = await sessionFor(adminEmail);
    const officer = await db.user.findUniqueOrThrow({ where: { email: officerEmail } });
    // super admin seeds UPLOAD in deptA, admin delegates it
    await createGrant(await superSession(), {
      userId: adminS.user.id,
      departmentId: deptA,
      action: Action.UPLOAD,
      reason: "seed admin upload",
    });
    const grant = await createGrant(adminS, {
      userId: officer.id,
      departmentId: deptA,
      action: Action.UPLOAD,
      reason: "revoke test",
    });

    const officerS = await sessionFor(officerEmail);
    await expectDenied(revokeGrant(officerS, grant.id));
    await expect(revokeGrant(adminS, grant.id)).resolves.toBeUndefined();
  });

  it("seeded users have expected roles", async () => {
    const officerS = await sessionFor(officerEmail);
    expect(officerS.user.role.name).toBe(RoleName.OFFICER);
    const s = await db.user.findUniqueOrThrow({
      where: { email: "admin@manikstu.local" },
      include: { role: true },
    });
    expect(s.role.name).toBe(RoleName.SUPER_ADMIN);
  });
});
