import type { z } from "zod";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { requireAgent, techAccess, techAudit } from "./tech";
import { ASSET_MOVES, ASSET_STATUS_LABEL, techHref } from "./tech-catalogue";
import type { assetMoveSchema, createAssetSchema, createLicenceSchema, licenceActionSchema } from "./tech-validation";

// IT asset register (WF-TM-08) and licences (WF-TM-09). Department members read
// them; agents change them. Custody moves append an AssetEvent — never edited.

const person = { select: { id: true, name: true, email: true } } as const;

export async function listAssets() {
  return db.asset.findMany({
    orderBy: [{ status: "asc" }, { tag: "asc" }],
    include: {
      custodian: person,
      events: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
}

export async function createAsset(session: AuthSession, input: z.infer<typeof createAssetSchema>) {
  const access = await techAccess(session);
  requireAgent(access);
  return db.$transaction(async (tx) => {
    const asset = await tx.asset.create({ data: { ...input, tag: input.tag.toUpperCase() } });
    await tx.assetEvent.create({ data: { assetId: asset.id, kind: "RECEIVE", actorId: session.user.id, note: "Received and tagged" } });
    await techAudit(tx, session, access.dept.id, {
      action: "ASSET_RECEIVED",
      targetType: "Asset",
      targetId: asset.id,
      detail: { tag: asset.tag, kind: asset.kind },
    });
    return asset;
  });
}

const MOVE_AUDIT: Record<string, string> = {
  ISSUE: "ASSET_ISSUED",
  TRANSFER: "ASSET_TRANSFERRED",
  RETURN: "ASSET_RETURNED",
  REPAIR: "ASSET_SENT_FOR_REPAIR",
  RETIRE: "ASSET_RETIRED",
  DISPOSE: "ASSET_DISPOSED",
};

export async function moveAsset(session: AuthSession, id: string, input: z.infer<typeof assetMoveSchema>) {
  const access = await techAccess(session);
  requireAgent(access);
  const asset = await db.asset.findUnique({ where: { id } });
  if (!asset) throw new ApiError(404, "NOT_FOUND", "Asset not found");
  const move = ASSET_MOVES[asset.status]?.find((m) => m.kind === input.kind);
  if (!move) {
    throw new ApiError(409, "INVALID_TRANSITION", `A ${ASSET_STATUS_LABEL[asset.status]?.toLowerCase() ?? asset.status} asset cannot be moved that way`);
  }
  if (move.needsUser) {
    if (!input.toUserId) throw new ApiError(422, "VALIDATION", "Pick who receives the asset");
    if (input.toUserId === asset.custodianId) throw new ApiError(422, "VALIDATION", "The asset is already with this person");
    const u = await db.user.findFirst({ where: { id: input.toUserId, status: "ACTIVE" }, select: { id: true } });
    if (!u) throw new ApiError(422, "VALIDATION", "That person was not found");
  }
  if (move.needsNote && !input.note) throw new ApiError(422, "VALIDATION", "Add a note (reason, repair vendor or wipe certificate)");

  const custodianId = move.needsUser ? (input.toUserId as string) : null;
  return db.$transaction(async (tx) => {
    const row = await tx.asset.update({ where: { id }, data: { status: move.to, custodianId } });
    await tx.assetEvent.create({
      data: { assetId: id, kind: input.kind, fromUserId: asset.custodianId, toUserId: custodianId, note: input.note, actorId: session.user.id },
    });
    await techAudit(tx, session, access.dept.id, {
      action: MOVE_AUDIT[input.kind],
      targetType: "Asset",
      targetId: id,
      detail: { tag: asset.tag, from: asset.status, to: move.to, fromUserId: asset.custodianId, toUserId: custodianId },
    });
    if (custodianId) {
      await notifyUsers(tx, [custodianId], {
        title: `${asset.kind} ${asset.tag} issued to you`,
        body: "Please keep it safe — it is recorded against your name",
        link: techHref("assets"),
      });
    }
    return row;
  });
}

export async function listLicences() {
  return db.licence.findMany({
    orderBy: { renewsAt: "asc" },
    include: {
      owner: person,
      assignments: { where: { revokedAt: null }, include: { user: person }, orderBy: { assignedAt: "asc" } },
    },
  });
}

export async function createLicence(session: AuthSession, input: z.infer<typeof createLicenceSchema>) {
  const access = await techAccess(session);
  requireAgent(access);
  const owner = await db.user.findFirst({ where: { id: input.ownerId, status: "ACTIVE" }, select: { id: true } });
  if (!owner) throw new ApiError(422, "VALIDATION", "Pick the licence owner");
  return db.$transaction(async (tx) => {
    const row = await tx.licence.create({ data: { ...input, autoRenew: input.autoRenew ?? false } });
    await techAudit(tx, session, access.dept.id, {
      action: "LICENCE_REGISTERED",
      targetType: "Licence",
      targetId: row.id,
      detail: { product: row.product, seats: row.seats, renewsAt: row.renewsAt.toISOString() },
    });
    return row;
  });
}

export async function licenceAction(session: AuthSession, id: string, input: z.infer<typeof licenceActionSchema>) {
  const access = await techAccess(session);
  requireAgent(access);
  const licence = await db.licence.findUnique({ where: { id }, include: { assignments: { where: { revokedAt: null } } } });
  if (!licence) throw new ApiError(404, "NOT_FOUND", "Licence not found");
  const active = licence.assignments;

  return db.$transaction(async (tx) => {
    if (input.action === "ASSIGN") {
      if (active.some((s) => s.userId === input.userId)) throw new ApiError(409, "CONFLICT", "This person already has a seat");
      if (active.length >= licence.seats) throw new ApiError(409, "NO_SEATS", `All ${licence.seats} seats are assigned — revoke one or buy more`);
      const u = await tx.user.findFirst({ where: { id: input.userId, status: "ACTIVE" }, select: { id: true } });
      if (!u) throw new ApiError(422, "VALIDATION", "That person was not found");
      await tx.licenceSeat.create({ data: { licenceId: id, userId: input.userId } });
      await techAudit(tx, session, access.dept.id, { action: "LICENCE_SEAT_ASSIGNED", targetType: "Licence", targetId: id, detail: { product: licence.product, userId: input.userId } });
    } else if (input.action === "REVOKE") {
      const seat = active.find((s) => s.userId === input.userId);
      if (!seat) throw new ApiError(404, "NOT_FOUND", "This person has no seat");
      await tx.licenceSeat.update({ where: { id: seat.id }, data: { revokedAt: new Date() } });
      await techAudit(tx, session, access.dept.id, { action: "LICENCE_SEAT_REVOKED", targetType: "Licence", targetId: id, detail: { product: licence.product, userId: input.userId } });
    } else {
      if (input.renewsAt <= licence.renewsAt) throw new ApiError(422, "VALIDATION", "The new renewal date must be after the current one");
      if (input.seats !== undefined && input.seats < active.length) {
        throw new ApiError(422, "VALIDATION", `${active.length} seats are assigned — revoke some before downsizing below that`);
      }
      await tx.licence.update({
        where: { id },
        data: { renewsAt: input.renewsAt, seats: input.seats, costPerPeriod: input.costPerPeriod, alertedDays: null },
      });
      await techAudit(tx, session, access.dept.id, {
        action: "LICENCE_RENEWED",
        targetType: "Licence",
        targetId: id,
        detail: { product: licence.product, from: licence.renewsAt.toISOString(), to: input.renewsAt.toISOString(), seats: input.seats ?? licence.seats },
      });
    }
  });
}
