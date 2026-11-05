import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import { createGrant, type AuthSession } from "@/lib/authorize";
import {
  MAX_UPLOAD_BYTES,
  addDocumentVersion,
  checkContentLength,
  createDocument,
  downloadVersion,
  transitionDocument,
  validateUpload,
} from "@/lib/documents";
import { actOnInstance } from "@/lib/workflows";

// Version integrity + lifecycle suite (PHASES.MD B2 done-gate).

let deptId: string;
let docId: string;
let editorId: string;
let outsiderId: string;
let reviewerId: string;
const v1Content = "M-DESK version one — immutable baseline";

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
  return u;
}

function expectValidation(fn: () => unknown) {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toMatchObject({ status: 422, code: "VALIDATION" });
}

beforeAll(async () => {
  const dept = await db.department.upsert({
    where: { slug: "test-dept-docs" },
    update: {},
    create: { number: 995, name: "Test Dept Docs", slug: "test-dept-docs", accentColor: "#555555" },
  });
  deptId = dept.id;

  const editor = await mkUser("t.doc.editor@mdesk.test");
  const outsider = await mkUser("t.doc.outsider@mdesk.test");
  editorId = editor.id;
  outsiderId = outsider.id;

  await db.departmentMembership.create({ data: { userId: editor.id, departmentId: deptId } });

  // the review chain (#15) resolves its approver within the doc's department
  const reviewer = await db.user.create({
    data: {
      email: "t.doc.reviewer@mdesk.test",
      name: "t.doc.reviewer@mdesk.test",
      passwordHash: "x",
      roleId: (await db.role.findUniqueOrThrow({ where: { name: RoleName.MANAGER } })).id,
    },
  });
  reviewerId = reviewer.id;
  await db.departmentMembership.create({ data: { userId: reviewer.id, departmentId: deptId } });

  const superS = await superSession();
  await createGrant(superS, {
    userId: editor.id,
    departmentId: deptId,
    action: Action.EDIT,
    reason: "versioning test",
  });
  await createGrant(superS, {
    userId: editor.id,
    departmentId: deptId,
    action: Action.APPROVE,
    reason: "versioning test approvals",
  });

  const doc = await createDocument(
    superS,
    { title: "Versioned Doc", departmentId: deptId, confidentiality: "L2" },
    new File([v1Content], "baseline.txt", { type: "text/plain" }),
  );
  docId = doc.id;
});

afterAll(async () => {
  const ids = [editorId, outsiderId, reviewerId];
  const instIds = (await db.workflowInstance.findMany({
    where: { relatedType: "Document", relatedId: docId },
    select: { id: true },
  })).map((i) => i.id);
  await db.approvalAction.deleteMany({ where: { instanceId: { in: instIds } } });
  await db.workflowInstance.deleteMany({ where: { id: { in: instIds } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.documentVersion.deleteMany({ where: { documentId: docId } });
  await db.document.deleteMany({ where: { id: docId } });
  await db.delegationGrant.deleteMany({ where: { userId: { in: ids } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: ids } } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { slug: "test-dept-docs" } });
  await db.$disconnect();
});

describe("upload validation", () => {
  it("rejects empty, oversized, and wrong-extension files", () => {
    expectValidation(() => validateUpload(new File([], "empty.txt", { type: "text/plain" })));
    expectValidation(() =>
      validateUpload(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.txt", { type: "text/plain" })),
    );
    expectValidation(() =>
      validateUpload(new File(["MZ"], "evil.exe", { type: "application/octet-stream" })),
    );
  });

  it("rejects oversized request bodies before parsing", () => {
    const req = new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { "content-length": String(MAX_UPLOAD_BYTES + 2 * 1024 * 1024) },
    });
    expectValidation(() => checkContentLength(req));
  });

  it("accepts a known extension", () => {
    expect(validateUpload(new File(["ok"], "report.pdf", { type: "application/pdf" }))).toBe(
      "application/pdf",
    );
  });
});

describe("version integrity", () => {
  it("v1 blob is content-addressed (path = sha256 of bytes)", async () => {
    const v1 = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_version: { documentId: docId, version: 1 } },
    });
    const abs = path.join(process.cwd(), v1.storagePath);
    await expect(stat(abs)).resolves.toBeDefined();
    const bytes = await readFile(abs);
    expect(bytes.toString("utf8")).toBe(v1Content);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(path.basename(v1.storagePath));
    expect(v1.sizeBytes).toBe(Buffer.byteLength(v1Content));
  });

  it("new version bumps currentVersion, keeps v1 byte-identical, dedupes storage", async () => {
    const before = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_version: { documentId: docId, version: 1 } },
    });

    const editor = await sessionFor("t.doc.editor@mdesk.test");
    // identical content → same content hash → same storage path
    const v2 = await addDocumentVersion(
      editor,
      docId,
      new File([v1Content], "same.txt", { type: "text/plain" }),
      "Re-upload of identical content",
    );
    expect(v2).toBe(2);

    const doc = await db.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.currentVersion).toBe(2);

    const after = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_version: { documentId: docId, version: 1 } },
    });
    expect(after.storagePath).toBe(before.storagePath);
    expect(after.changeNote).toBe(before.changeNote);
    expect(after.sizeBytes).toBe(before.sizeBytes);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());

    const v2Row = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_version: { documentId: docId, version: 2 } },
    });
    expect(v2Row.storagePath).toBe(before.storagePath); // dedupe
    expect(v2Row.changeNote).toBe("Re-upload of identical content");
    expect(v2Row.createdById).toBe(editor.user.id);

    const audit = await db.auditEvent.findFirst({
      where: { action: "DOCUMENT_VERSION_CREATED", targetId: docId },
    });
    expect(audit).not.toBeNull();
  });

  it("old versions still download their original bytes", async () => {
    const superS = await superSession();
    for (const version of [1, 2]) {
      const resp = await downloadVersion(superS, docId, version);
      expect(resp.status).toBe(200);
      const bytes = Buffer.from(await resp.arrayBuffer());
      expect(bytes.toString("utf8")).toBe(v1Content);
    }
    await expect(downloadVersion(superS, docId, 99)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("outsider cannot upload a version (view gate denies)", async () => {
    const outsider = await sessionFor("t.doc.outsider@mdesk.test");
    await expect(
      addDocumentVersion(outsider, docId, new File(["x"], "x.txt", { type: "text/plain" }), "should fail"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });
});

describe("lifecycle transitions", () => {
  it("rejection cycle: chain REJECTED → doc CHANGES_REQUESTED → back to DRAFT", async () => {
    const editor = await sessionFor("t.doc.editor@mdesk.test");
    const status = () => db.document.findUniqueOrThrow({ where: { id: docId } }).then((d) => d.status);

    await transitionDocument(editor, docId, "IN_REVIEW");
    const inst = await db.workflowInstance.findFirstOrThrow({
      where: { relatedType: "Document", relatedId: docId },
    });
    await actOnInstance(await sessionFor("t.doc.reviewer@mdesk.test"), inst.id, "REJECTED", {
      comment: "structure does not match the template",
    });
    expect(await status()).toBe("CHANGES_REQUESTED");
    const done = await db.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(done.status).toBe("REJECTED");
    await transitionDocument(editor, docId, "DRAFT");
    expect(await status()).toBe("DRAFT");
  });

  it("legal path DRAFT → IN_REVIEW (chain starts) → workflow approve → APPROVED", async () => {
    const editor = await sessionFor("t.doc.editor@mdesk.test");
    const status = () => db.document.findUniqueOrThrow({ where: { id: docId } }).then((d) => d.status);

    expect(await status()).toBe("DRAFT");
    await transitionDocument(editor, docId, "IN_REVIEW");
    expect(await status()).toBe("IN_REVIEW");
    // the chain must exist, linked to the document
    const inst = await db.workflowInstance.findFirst({
      where: {
        relatedType: "Document",
        relatedId: docId,
        status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] },
      },
    });
    expect(inst).not.toBeNull();
    // manual approve is refused while the chain is live
    await expect(transitionDocument(editor, docId, "APPROVED")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    // the doc owner's dept head decides through the workflow
    await actOnInstance(await sessionFor("t.doc.reviewer@mdesk.test"), inst!.id, "APPROVED", {});
    expect(await status()).toBe("APPROVED");

    const rows = await db.auditEvent.findMany({
      where: { action: "DOCUMENT_STATUS_CHANGED", targetId: docId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const detail = rows[rows.length - 1]?.detail as { from?: string; to?: string };
    expect(detail.from).toBe("IN_REVIEW");
    expect(detail.to).toBe("APPROVED");
  });

  it("illegal transition → 409 CONFLICT", async () => {
    const editor = await sessionFor("t.doc.editor@mdesk.test");
    await expect(transitionDocument(editor, docId, "CHANGES_REQUESTED")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    // status unchanged
    const doc = await db.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.status).toBe("APPROVED");
  });

  it("non-member outsider transition denied + audited", async () => {
    const outsider = await sessionFor("t.doc.outsider@mdesk.test");
    await expect(transitionDocument(outsider, docId, "PUBLISHED")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    const audit = await db.auditEvent.findFirst({
      where: { action: "DENIED_DOCUMENT_VIEW", targetId: docId, actorId: outsiderId },
    });
    expect(audit).not.toBeNull();
  });

  it("APPROVED → PUBLISHED then PUBLISHED → ARCHIVED (terminal)", async () => {
    const editor = await sessionFor("t.doc.editor@mdesk.test");
    await transitionDocument(editor, docId, "PUBLISHED");
    await transitionDocument(editor, docId, "ARCHIVED");
    const doc = await db.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.status).toBe("ARCHIVED");
    await expect(transitionDocument(editor, docId, "DRAFT")).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });
});
