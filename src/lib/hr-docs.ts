import { Action, type HrDocCategory } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { addDocumentVersion, createDocument } from "./documents";
import { ApiError } from "./validation";
import { hrAudit, requireHr } from "./hr";

// §6 central repository: employee files live in the controlled document
// library (HR department, L3) so storage, versioning, download auditing and
// confidentiality rules are shared; HrDocument adds the employee link,
// category, verification and expiry metadata.

export async function uploadHrDocument(
  session: AuthSession,
  meta: { employeeId: string; category: HrDocCategory; label: string; expiresAt?: Date },
  file: File,
) {
  const dept = await requireHr(session, Action.UPLOAD);
  const emp = await db.employee.findUnique({ where: { id: meta.employeeId }, select: { id: true, name: true } });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");

  // Same label again = replacement: a new version of the same file, re-verified.
  const existing = await db.hrDocument.findFirst({
    where: { employeeId: emp.id, label: meta.label },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    const version = await addDocumentVersion(session, existing.documentId, file, `Replaced ${meta.label}`);
    return db.$transaction(async (tx) => {
      const updated = await tx.hrDocument.update({
        where: { id: existing.id },
        data: {
          category: meta.category,
          expiresAt: meta.expiresAt ?? existing.expiresAt,
          verification: "PENDING",
          verifiedById: null,
          verifiedAt: null,
        },
      });
      await hrAudit(tx, session, dept.id, {
        action: "HR_DOCUMENT_REPLACED",
        targetType: "HrDocument",
        targetId: existing.id,
        detail: { employeeId: emp.id, label: meta.label, version },
      });
      return updated;
    });
  }

  const doc = await createDocument(
    session,
    { title: `${meta.label} — ${emp.name}`, departmentId: dept.id, confidentiality: "L3" },
    file,
  );
  return db.$transaction(async (tx) => {
    const hd = await tx.hrDocument.create({
      data: {
        employeeId: emp.id,
        documentId: doc.id,
        category: meta.category,
        label: meta.label,
        expiresAt: meta.expiresAt,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_DOCUMENT_UPLOADED",
      targetType: "HrDocument",
      targetId: hd.id,
      detail: { employeeId: emp.id, label: meta.label, category: meta.category },
    });
    return hd;
  });
}

export async function verifyHrDocument(
  session: AuthSession,
  id: string,
  verification: "VERIFIED" | "REJECTED",
  comment?: string,
) {
  const dept = await requireHr(session, Action.EDIT);
  const hd = await db.hrDocument.findUnique({ where: { id } });
  if (!hd) throw new ApiError(404, "NOT_FOUND", "Document not found");
  if (verification === "REJECTED" && !comment) {
    throw new ApiError(422, "VALIDATION", "Give a reason for rejecting the document");
  }
  await db.$transaction(async (tx) => {
    await tx.hrDocument.update({
      where: { id },
      data: { verification, verifiedById: session.user.id, verifiedAt: new Date() },
    });
    await hrAudit(tx, session, dept.id, {
      action: verification === "VERIFIED" ? "HR_DOCUMENT_VERIFIED" : "HR_DOCUMENT_REJECTED",
      targetType: "HrDocument",
      targetId: id,
      detail: { employeeId: hd.employeeId, label: hd.label, ...(comment ? { comment } : {}) },
    });
  });
}
