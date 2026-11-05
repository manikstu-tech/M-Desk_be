import { Action, type Confidentiality, type Prisma } from "@prisma/client";
import type { z } from "zod";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { activeGrant, createDocument, documentListWhere } from "./documents";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { canSeeItem, techAudit, techWorkspace, type TechAccess } from "./tech";
import { requireItem } from "./tech-items";
import { isTerminal, itemHref, type TechDocCategory } from "./tech-catalogue";
import type { techDocMetaSchema } from "./tech-validation";

// Tech & MIS documents (blueprint §4.1 "Attachments: existing document storage").
// Files go into the controlled library under the Technology & MIS department, so
// upload rights (an UPLOAD grant, via createDocument → authorize), versions, the
// L1–L4 ladder and audited downloads are the ones every other document has.
// TechDocument adds the category and, for an attachment, its work item.

const LEVEL: Record<Confidentiality, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

/** Whether to show the upload form. Never a substitute for authorize() on the server. */
export async function canUploadTech(session: AuthSession, access: TechAccess): Promise<boolean> {
  if (access.isSuper) return true;
  const grant = await db.delegationGrant.findFirst({
    where: { userId: session.user.id, departmentId: access.dept.id, action: Action.UPLOAD, ...activeGrant() },
    select: { id: true },
  });
  return grant !== null;
}

export async function uploadTechDocument(session: AuthSession, meta: z.infer<typeof techDocMetaSchema>, file: File) {
  const access = await techWorkspace(session);
  if (!access) throw new ApiError(403, "FORBIDDEN", "Technology & MIS members only");

  const item = meta.itemKey ? (await requireItem(session, meta.itemKey.toUpperCase())).item : null;
  if (item && isTerminal(item.type, item.status)) throw new ApiError(409, "CLOSED", "This item is closed");
  // an attachment is never less confidential than the item it belongs to
  const confidentiality = item && LEVEL[item.confidentiality] > LEVEL[meta.confidentiality] ? item.confidentiality : meta.confidentiality;

  const doc = await createDocument(session, { title: meta.title, departmentId: access.dept.id, confidentiality }, file);
  return db.$transaction(async (tx) => {
    const td = await tx.techDocument.create({ data: { documentId: doc.id, itemId: item?.id ?? null, category: meta.category } });
    await techAudit(tx, session, access.dept.id, {
      action: item ? "TECH_FILE_ATTACHED" : "TECH_DOCUMENT_UPLOADED",
      targetType: item ? "TechItem" : "TechDocument",
      targetId: item?.id ?? td.id,
      detail: { documentId: doc.id, title: meta.title, category: meta.category, confidentiality, ...(item ? { key: item.key } : {}) },
    });
    if (item?.assigneeId && item.assigneeId !== session.user.id) {
      await notifyUsers(tx, [item.assigneeId], { title: `File attached to ${item.key}: ${meta.title}`, body: `By ${session.user.name}`, link: itemHref(item.key) });
    }
    return td;
  });
}

export type TechDocFilters = { q?: string; category?: TechDocCategory | "GENERAL"; scope?: "items" | "library" };

const listInclude = {
  createdBy: { select: { name: true } },
  techDocument: {
    include: {
      item: {
        select: {
          key: true,
          title: true,
          confidentiality: true,
          reporterId: true,
          requestedForId: true,
          assigneeId: true,
          watchers: { select: { userId: true } },
        },
      },
    },
  },
} satisfies Prisma.DocumentInclude;

/**
 * Every Technology & MIS document the viewer may open — including files uploaded
 * from the main Documents page (no TechDocument row: category "General").
 */
export async function listTechDocuments(session: AuthSession, access: TechAccess, filters: TechDocFilters) {
  const and: Prisma.DocumentWhereInput[] = [await documentListWhere(session, { departmentId: access.dept.id, q: filters.q })];
  if (filters.category === "GENERAL") and.push({ techDocument: { is: null } });
  else if (filters.category) and.push({ techDocument: { is: { category: filters.category } } });
  if (filters.scope === "items") and.push({ techDocument: { is: { itemId: { not: null } } } });
  if (filters.scope === "library") and.push({ OR: [{ techDocument: { is: null } }, { techDocument: { is: { itemId: null } } }] });

  const docs = await db.document.findMany({ where: { AND: and }, include: listInclude, orderBy: { updatedAt: "desc" }, take: 300 });
  return docs.map((d) => {
    const item = d.techDocument?.item ?? null;
    // the linked item is named only to people who may see that item
    const seen = item && canSeeItem(access, item, item.watchers.map((w) => w.userId)) ? { key: item.key, title: item.title } : null;
    return {
      id: d.id,
      title: d.title,
      confidentiality: d.confidentiality,
      status: d.status,
      currentVersion: d.currentVersion,
      updatedAt: d.updatedAt,
      uploadedBy: d.createdBy.name,
      category: d.techDocument?.category ?? null,
      item: seen,
      hiddenItem: item !== null && seen === null,
    };
  });
}

/** Attachments on one item that the viewer may open, plus how many sit above their level. */
export async function itemDocuments(session: AuthSession, itemId: string) {
  const [visible, total] = await Promise.all([
    db.document.findMany({
      where: { AND: [await documentListWhere(session, {}), { techDocument: { is: { itemId } } }] },
      include: { createdBy: { select: { name: true } }, techDocument: { select: { category: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.techDocument.count({ where: { itemId } }),
  ]);
  return { files: visible, hidden: total - visible.length };
}
