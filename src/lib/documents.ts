import { createHash } from "crypto";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import type { Confidentiality, Prisma } from "@prisma/client";
import { Action, DocStatus, RoleName } from "@prisma/client";
import { db } from "./db";
import { writeAudit } from "./audit";
import { authorize, type AuthSession } from "./authorize";
import { ApiError } from "./validation";
import { startDocumentApproval } from "./workflows";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Extension → MIME is the server-side type gate (client-declared MIME is not trusted).
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const STORAGE_ROOT = path.join(process.cwd(), "storage");

export function validateUpload(file: File): string {
  if (file.size === 0) throw new ApiError(422, "VALIDATION", "File is empty");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(422, "VALIDATION", "File exceeds the 10 MB upload limit");
  }
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const mime = EXT_MIME[ext];
  if (!mime) throw new ApiError(422, "VALIDATION", "File type is not allowed");
  return mime;
}

/** Rejects oversized multipart bodies before parsing them. */
export function checkContentLength(req: Request) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_UPLOAD_BYTES + 1024 * 1024) {
    throw new ApiError(422, "VALIDATION", "File exceeds the 10 MB upload limit");
  }
}

export async function storeBlob(buffer: Buffer): Promise<string> {
  const hash = createHash("sha256").update(buffer).digest("hex");
  const rel = `storage/${hash.slice(0, 2)}/${hash}`;
  const abs = path.join(process.cwd(), rel);
  try {
    await stat(abs); // content-addressed: identical file already stored
  } catch {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buffer);
  }
  return rel;
}

function resolveBlob(storagePath: string): string {
  const abs = path.resolve(process.cwd(), storagePath);
  if (!abs.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
    throw new ApiError(500, "INTERNAL", "Invalid storage path");
  }
  return abs;
}

/** Non-revoked, non-expired grant fragment (evaluated per call — date must be fresh). */
export function activeGrant(): Prisma.DelegationGrantWhereInput {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

async function isMember(userId: string, departmentId: string) {
  return !!(await db.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
  }));
}

async function hasViewGrant(userId: string, departmentId: string, namedL4 = false) {
  return !!(await db.delegationGrant.findFirst({
    where: {
      userId,
      departmentId,
      action: Action.VIEW,
      ...activeGrant(),
      ...(namedL4 ? { confidentiality: "L4" as const } : {}),
    },
  }));
}

/**
 * L1–L4 ladder (decision: membership for L2):
 * L1 = any signed-in user; L2 = dept member; L3 = member + active VIEW grant;
 * L4 = active VIEW grant flagged L4 (named, membership irrelevant). Super Admin bypasses.
 */
export async function canViewDocument(
  session: AuthSession,
  doc: { id: string; departmentId: string; createdById: string; confidentiality: Confidentiality },
): Promise<boolean> {
  if (session.user.role.name === RoleName.SUPER_ADMIN) return true;
  if (doc.createdById === session.user.id) return true;
  const { id: userId } = session.user;
  switch (doc.confidentiality) {
    case "L1":
      return true;
    case "L2":
      return isMember(userId, doc.departmentId);
    case "L3":
      return (await isMember(userId, doc.departmentId)) && (await hasViewGrant(userId, doc.departmentId));
    case "L4":
      return hasViewGrant(userId, doc.departmentId, true);
  }
}

/** Deny → DENIED audit + 403 (RULES.MD: generic message, no resource details). */
export async function requireDocView(
  session: AuthSession,
  doc: { id: string; departmentId: string; createdById: string; confidentiality: Confidentiality },
): Promise<void> {
  if (await canViewDocument(session, doc)) return;
  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DENIED_DOCUMENT_VIEW",
      targetType: "Document",
      targetId: doc.id,
      departmentId: doc.departmentId,
      outcome: "DENIED",
      detail: { confidentiality: doc.confidentiality },
    }),
  );
  throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource");
}

export type DocumentFilters = { q?: string; status?: DocStatus; departmentId?: string };

/** Visibility ∩ filters — single source for list, search and CSV export. */
export async function documentListWhere(
  session: AuthSession,
  filters: DocumentFilters,
): Promise<Prisma.DocumentWhereInput> {
  const visibility = await visibleDocumentWhere(session);
  const extra: Prisma.DocumentWhereInput[] = [];
  if (filters.q) extra.push({ title: { contains: filters.q, mode: "insensitive" } });
  if (filters.status) extra.push({ status: filters.status });
  if (filters.departmentId) extra.push({ departmentId: filters.departmentId });
  return extra.length ? { AND: [visibility, ...extra] } : visibility;
}

async function visibleDocumentWhere(session: AuthSession): Promise<Prisma.DocumentWhereInput> {
  if (session.user.role.name === RoleName.SUPER_ADMIN) return {};
  const { id: userId } = session.user;
  const [memberships, grants] = await Promise.all([
    db.departmentMembership.findMany({ where: { userId }, select: { departmentId: true } }),
    db.delegationGrant.findMany({
      where: { userId, action: Action.VIEW, ...activeGrant() },
      select: { departmentId: true, confidentiality: true },
    }),
  ]);
  const memberDepts = memberships.map((m) => m.departmentId);
  const grantedDepts = new Set(grants.map((g) => g.departmentId));
  const l3Depts = memberDepts.filter((d) => grantedDepts.has(d));
  const l4Depts = grants.filter((g) => g.confidentiality === "L4").map((g) => g.departmentId);
  return {
    OR: [
      { createdById: userId }, // creator pass — must match canViewDocument
      { confidentiality: "L1" },
      { confidentiality: "L2", departmentId: { in: memberDepts } },
      { confidentiality: "L3", departmentId: { in: l3Depts } },
      { confidentiality: "L4", departmentId: { in: l4Depts } },
    ],
  };
}

async function loadDoc(id: string) {
  const doc = await db.document.findUnique({ where: { id } });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Document not found");
  return doc;
}

export async function createDocument(
  session: AuthSession,
  input: { title: string; departmentId: string; confidentiality: Confidentiality },
  file: File,
) {
  await authorize(session, { departmentId: input.departmentId, action: Action.UPLOAD });
  const mimeType = validateUpload(file);
  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = await storeBlob(buffer);

  return db.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        title: input.title,
        departmentId: input.departmentId,
        confidentiality: input.confidentiality,
        currentVersion: 1,
        createdById: session.user.id,
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        version: 1,
        storagePath,
        mimeType,
        sizeBytes: buffer.length,
        changeNote: "Initial upload",
        createdById: session.user.id,
      },
    });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DOCUMENT_CREATED",
      targetType: "Document",
      targetId: doc.id,
      departmentId: input.departmentId,
      detail: { title: input.title, confidentiality: input.confidentiality },
    });
    return doc;
  });
}

export async function addDocumentVersion(
  session: AuthSession,
  docId: string,
  file: File,
  changeNote: string,
): Promise<number> {
  const doc = await loadDoc(docId);
  await requireDocView(session, doc);
  await authorize(session, { departmentId: doc.departmentId, action: Action.EDIT });
  const mimeType = validateUpload(file);
  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = await storeBlob(buffer);

  return db.$transaction(async (tx) => {
    const version = doc.currentVersion + 1;
    await tx.documentVersion.create({
      data: {
        documentId: docId,
        version,
        storagePath,
        mimeType,
        sizeBytes: buffer.length,
        changeNote,
        createdById: session.user.id,
      },
    });
    await tx.document.update({ where: { id: docId }, data: { currentVersion: version } });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DOCUMENT_VERSION_CREATED",
      targetType: "Document",
      targetId: docId,
      departmentId: doc.departmentId,
      detail: { version, changeNote },
    });
    return version;
  });
}

export const TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT: ["IN_REVIEW"],
  IN_REVIEW: ["APPROVED", "CHANGES_REQUESTED"],
  CHANGES_REQUESTED: ["IN_REVIEW", "DRAFT"],
  APPROVED: ["PUBLISHED"],
  PUBLISHED: ["REVISED", "ARCHIVED"],
  REVISED: ["IN_REVIEW", "DRAFT"],
  ARCHIVED: [],
};

// Review outcomes decide approval quality; everything else is an edit.
const REVIEW_OUTCOMES: DocStatus[] = ["APPROVED", "CHANGES_REQUESTED"];

export async function transitionDocument(session: AuthSession, docId: string, to: DocStatus) {
  const doc = await loadDoc(docId);
  await requireDocView(session, doc);
  await authorize(session, {
    departmentId: doc.departmentId,
    action: REVIEW_OUTCOMES.includes(to) ? Action.APPROVE : Action.EDIT,
  });
  if (!TRANSITIONS[doc.status].includes(to)) {
    throw new ApiError(409, "CONFLICT", `Cannot move from ${doc.status} to ${to}`);
  }

  // while a review chain is live the decision runs through the workflow (#15)
  if (doc.status === DocStatus.IN_REVIEW && REVIEW_OUTCOMES.includes(to)) {
    const live = await db.workflowInstance.findFirst({
      where: { relatedType: "Document", relatedId: docId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
      select: { id: true },
    });
    if (live) {
      throw new ApiError(409, "CONFLICT", "The review decision runs through the approval workflow");
    }
  }

  await db.$transaction(async (tx) => {
    await tx.document.update({ where: { id: docId }, data: { status: to } });
    await writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DOCUMENT_STATUS_CHANGED",
      targetType: "Document",
      targetId: docId,
      departmentId: doc.departmentId,
      detail: { from: doc.status, to },
    });
  });

  // marking a draft for review starts its approval chain in one move (#15);
  // a failed start (unseeded def / no approver / double submission) rolls the
  // status back so the document never sits IN_REVIEW unlinked
  if (to === DocStatus.IN_REVIEW && (doc.status === DocStatus.DRAFT || doc.status === DocStatus.CHANGES_REQUESTED || doc.status === DocStatus.REVISED)) {
    try {
      await startDocumentApproval(session, doc);
    } catch (e) {
      // a review chain already running (user re-issued the status change):
      // the doc legitimately moved IN_REVIEW and the live chain governs it
      if (e instanceof ApiError && e.status === 409 && e.code === "CONFLICT") return;
      // an unlinked no-chain review keeps the old manual path — only fall back
      // for concrete start failures, and leave a FAILED audit trail behind
      await db.$transaction(async (tx) => {
        await tx.document.update({ where: { id: docId }, data: { status: doc.status } });
        await writeAudit(tx, {
          actorId: session.user.id,
          actorEmail: session.user.email,
          action: "DOCUMENT_REVIEW_CH_START_FAILED",
          targetType: "Document",
          targetId: docId,
          departmentId: doc.departmentId,
          outcome: "FAILED",
          detail: { attempted: DocStatus.IN_REVIEW, restored: doc.status },
        });
      });
      if (e instanceof ApiError) throw e;
      throw new ApiError(500, "INTERNAL", "Could not start the review workflow");
    }
  }
}

function extFor(mime: string): string {
  for (const [ext, m] of Object.entries(EXT_MIME)) if (m === mime) return ext;
  return "bin";
}

function downloadName(title: string, mime: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "document";
  return `${base}.${extFor(mime)}`;
}

export async function downloadVersion(session: AuthSession, docId: string, version?: number) {
  const doc = await loadDoc(docId);
  await requireDocView(session, doc);
  const v = version ?? doc.currentVersion;
  const ver = await db.documentVersion.findUnique({
    where: { documentId_version: { documentId: docId, version: v } },
  });
  if (!ver) throw new ApiError(404, "NOT_FOUND", "Version not found");

  let buffer: Buffer;
  try {
    buffer = await readFile(resolveBlob(ver.storagePath));
  } catch {
    throw new ApiError(404, "NOT_FOUND", "File not found in storage");
  }

  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DOCUMENT_DOWNLOADED",
      targetType: "Document",
      targetId: docId,
      departmentId: doc.departmentId,
      detail: { version: v, mimeType: ver.mimeType },
    }),
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": ver.mimeType,
      "Content-Disposition": `attachment; filename="${downloadName(doc.title, ver.mimeType)}"`,
    },
  });
}

function csvCell(value: unknown): string {
  let v = String(value ?? "");
  if (/^[=+\-@]/.test(v)) v = `'${v}`; // formula-injection guard, same as the other exporters
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Filtered CSV of visible documents; the export itself is audited. */
export async function exportVisibleDocuments(session: AuthSession, filters: DocumentFilters) {
  const where = await documentListWhere(session, filters);
  const docs = await db.document.findMany({
    where,
    include: { department: true },
    orderBy: { updatedAt: "desc" },
  });
  const header = ["Title", "Department", "Confidentiality", "Status", "Version", "Updated"];
  const rows = docs.map((d) =>
    [d.title, d.department.name, d.confidentiality, d.status, d.currentVersion, d.updatedAt.toISOString()]
      .map(csvCell)
      .join(","),
  );
  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DOCUMENT_LIST_EXPORTED",
      targetType: "DocumentList",
      detail: { count: docs.length, filters },
    }),
  );
  return [header.join(","), ...rows].join("\r\n");
}
