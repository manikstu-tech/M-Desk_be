import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import { createGrant, type AuthSession } from "@/lib/authorize";
import {
  canViewDocument,
  createDocument,
  documentListWhere,
  downloadVersion,
  exportVisibleDocuments,
  requireDocView,
} from "@/lib/documents";

// HR→Finance denial suite (PHASES.MD B2 done-gate: URL/API/search/export).
// Ladder: L1 all · L2 dept member · L3 member+VIEW grant · L4 VIEW grant flagged L4.

let hrDept: string;
let finDept: string;
const createdUserIds: string[] = [];
const createdDocIds: string[] = [];

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

async function mkUser(email: string) {
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  const u = await db.user.create({
    data: { email, name: email, passwordHash: "x", roleId: role.id },
  });
  createdUserIds.push(u.id);
  return u;
}

async function mkDoc(
  deptId: string,
  title: string,
  confidentiality: "L1" | "L2" | "L3" | "L4",
) {
  const file = new File([`content of ${title}`], "doc.txt", { type: "text/plain" });
  const doc = await createDocument(await superSession(), {
    title,
    departmentId: deptId,
    confidentiality,
  }, file);
  createdDocIds.push(doc.id);
  return doc;
}

async function expectDenied(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
}

beforeAll(async () => {
  const [hr, fin] = await Promise.all([
    db.department.upsert({
      where: { slug: "test-doc-hr" },
      update: {},
      create: { number: 993, name: "Test Doc HR", slug: "test-doc-hr", accentColor: "#333333" },
    }),
    db.department.upsert({
      where: { slug: "test-doc-fin" },
      update: {},
      create: { number: 994, name: "Test Doc Finance", slug: "test-doc-fin", accentColor: "#444444" },
    }),
  ]);
  hrDept = hr.id;
  finDept = fin.id;

  const [hrMember, finMember, finGranted, l4Holder] = await Promise.all([
    mkUser("t.hr.member@mdesk.test"),
    mkUser("t.fin.member@mdesk.test"),
    mkUser("t.fin.granted@mdesk.test"),
    mkUser("t.l4.holder@mdesk.test"),
  ]);

  await db.departmentMembership.createMany({
    data: [
      { userId: hrMember.id, departmentId: hrDept },
      { userId: finMember.id, departmentId: finDept },
      { userId: finGranted.id, departmentId: finDept },
    ],
  });

  const superS = await superSession();
  await createGrant(superS, {
    userId: finGranted.id,
    departmentId: finDept,
    action: Action.VIEW,
    reason: "L3 clearance",
  });
  await createGrant(superS, {
    userId: l4Holder.id,
    departmentId: finDept,
    action: Action.VIEW,
    reason: "Named L4 access",
    namedL4: true,
  });
  // UPLOAD (not VIEW) — L3 must stay denied for finMember, creator pass must still hold.
  await createGrant(superS, {
    userId: finMember.id,
    departmentId: finDept,
    action: Action.UPLOAD,
    reason: "Upload for creator test",
  });

  await mkDoc(finDept, "Finance Secret L2", "L2");
  await mkDoc(finDept, "Finance Restricted L3", "L3");
  await mkDoc(finDept, "Finance Named L4", "L4");
  await mkDoc(finDept, "Finance Shared L1", "L1");
});

afterAll(async () => {
  const ids = createdUserIds;
  await db.documentVersion.deleteMany({ where: { documentId: { in: createdDocIds } } });
  await db.document.deleteMany({ where: { id: { in: createdDocIds } } });
  await db.delegationGrant.deleteMany({ where: { userId: { in: ids } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({
    where: { slug: { in: ["test-doc-hr", "test-doc-fin"] } },
  });
  await db.$disconnect();
});

async function titlesFor(
  session: AuthSession,
  filters: Parameters<typeof documentListWhere>[1] = {},
): Promise<string[]> {
  const where = await documentListWhere(session, filters);
  const rows = await db.document.findMany({
    where: { AND: [where, { departmentId: { in: [hrDept, finDept] } }] },
    select: { title: true },
  });
  return rows.map((r) => r.title);
}

describe("L1–L4 confidentiality ladder", () => {
  it("L2: Finance member sees L2, HR member does not", async () => {
    const finMember = await sessionFor("t.fin.member@mdesk.test");
    const hrMember = await sessionFor("t.hr.member@mdesk.test");

    const finTitles = await titlesFor(finMember);
    expect(finTitles).toContain("Finance Secret L2");
    expect(finTitles).toContain("Finance Shared L1");
    expect(finTitles).not.toContain("Finance Restricted L3");
    expect(finTitles).not.toContain("Finance Named L4");

    const hrTitles = await titlesFor(hrMember);
    expect(hrTitles).toContain("Finance Shared L1");
    expect(hrTitles).not.toContain("Finance Secret L2");
    expect(hrTitles).not.toContain("Finance Restricted L3");
    expect(hrTitles).not.toContain("Finance Named L4");
  });

  it("L3: member alone denied, member+VIEW grant allowed", async () => {
    const finMember = await sessionFor("t.fin.member@mdesk.test");
    const finGranted = await sessionFor("t.fin.granted@mdesk.test");
    const l3 = await db.document.findFirstOrThrow({ where: { title: "Finance Restricted L3" } });

    expect(await canViewDocument(finMember, l3)).toBe(false);
    expect(await canViewDocument(finGranted, l3)).toBe(true);
  });

  it("L4: named grant required — plain VIEW grant insufficient, membership irrelevant", async () => {
    const finMember = await sessionFor("t.fin.member@mdesk.test");
    const finGranted = await sessionFor("t.fin.granted@mdesk.test");
    const l4Holder = await sessionFor("t.l4.holder@mdesk.test");
    const l4 = await db.document.findFirstOrThrow({ where: { title: "Finance Named L4" } });

    expect(await canViewDocument(finMember, l4)).toBe(false);
    expect(await canViewDocument(finGranted, l4)).toBe(false); // VIEW grant, not flagged L4
    expect(await canViewDocument(l4Holder, l4)).toBe(true); // named, no membership
    expect(await canViewDocument(l4Holder, await db.document.findFirstOrThrow({ where: { title: "Finance Secret L2" } }))).toBe(false);
  });

  it("creator can view own upload; super admin sees everything", async () => {
    const finMember = await sessionFor("t.fin.member@mdesk.test");
    const superS = await superSession();
    const l4 = await db.document.findFirstOrThrow({ where: { title: "Finance Named L4" } });
    const own = await createDocument(finMember, {
      title: "Finance Own Upload L4",
      departmentId: finDept,
      confidentiality: "L4",
    }, new File(["own"], "own.txt", { type: "text/plain" }));
    createdDocIds.push(own.id);

    expect(await canViewDocument(finMember, own)).toBe(true);
    expect(await canViewDocument(superS, l4)).toBe(true);
  });

  it("only Super Admin can issue L4 named grants", async () => {
    const finGranted = await sessionFor("t.fin.granted@mdesk.test");
    const target = await db.user.findUniqueOrThrow({ where: { email: "t.hr.member@mdesk.test" } });
    await expectDenied(
      createGrant(finGranted, {
        userId: target.id,
        departmentId: finDept,
        action: Action.VIEW,
        reason: "escalate myself",
        namedL4: true,
      }),
    );
  });
});

describe("HR→Finance denial via URL/API/search/export", () => {
  it("URL: direct document access denied + DENIED audit row", async () => {
    const hrMember = await sessionFor("t.hr.member@mdesk.test");
    const finL2 = await db.document.findFirstOrThrow({ where: { title: "Finance Secret L2" } });

    await expectDenied(requireDocView(hrMember, finL2));
    const audit = await db.auditEvent.findFirst({
      where: {
        action: "DENIED_DOCUMENT_VIEW",
        targetId: finL2.id,
        actorId: hrMember.user.id,
        outcome: "DENIED",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("API: download denied for HR, allowed for Finance member", async () => {
    const hrMember = await sessionFor("t.hr.member@mdesk.test");
    const finMember = await sessionFor("t.fin.member@mdesk.test");
    const finL2 = await db.document.findFirstOrThrow({ where: { title: "Finance Secret L2" } });

    await expectDenied(downloadVersion(hrMember, finL2.id));
    const resp = await downloadVersion(finMember, finL2.id);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Disposition")).toContain(".txt");
    expect(resp.headers.get("Content-Type")).toBe("text/plain");
  });

  it("search: HR query returns only L1; Finance member gets L1+L2+own uploads only", async () => {
    const hrMember = await sessionFor("t.hr.member@mdesk.test");
    const finMember = await sessionFor("t.fin.member@mdesk.test");

    const hrTitles = await titlesFor(hrMember, { q: "Finance" });
    expect(hrTitles).toEqual(["Finance Shared L1"]);

    const finTitles = await titlesFor(finMember, { q: "Finance" });
    expect(finTitles).toContain("Finance Shared L1");
    expect(finTitles).toContain("Finance Secret L2");
    expect(finTitles).toContain("Finance Own Upload L4"); // creator pass
    expect(finTitles).not.toContain("Finance Restricted L3"); // member, no VIEW grant
    expect(finTitles).not.toContain("Finance Named L4"); // needs named grant
  });

  it("export: HR CSV excludes Finance L2/L3/L4 and the export itself is audited", async () => {
    const hrMember = await sessionFor("t.hr.member@mdesk.test");
    const csv = await exportVisibleDocuments(hrMember, {});

    expect(csv).toContain("Finance Shared L1");
    expect(csv).not.toContain("Finance Secret L2");
    expect(csv).not.toContain("Finance Restricted L3");
    expect(csv).not.toContain("Finance Named L4");

    const audit = await db.auditEvent.findFirst({
      where: { action: "DOCUMENT_LIST_EXPORTED", actorId: hrMember.user.id },
    });
    expect(audit).not.toBeNull();
  });
});
