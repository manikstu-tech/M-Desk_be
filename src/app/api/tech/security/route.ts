import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { requireTechMember } from "@/lib/tech-api";
import { errorResponse, ok } from "@/lib/validation";

const DAY = 24 * 60 * 60 * 1000;

/** GET /api/tech/security: roles, password and access-grant posture, latest leaver, recent audit (head / L4 only). */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const now = new Date();
    const seesAudit = access.head || access.seesL4;
    const openGrant = { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };

    const [roles, mustChange, failedLogins, grants, leavers, audit] = await Promise.all([
      db.role.findMany({
        orderBy: { name: "asc" },
        select: { name: true, description: true, _count: { select: { users: { where: { status: "ACTIVE" } } } } },
      }),
      db.user.count({ where: { status: "ACTIVE", mustChangePassword: true } }),
      db.auditEvent.count({ where: { action: "LOGIN_FAILED", createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      db.delegationGrant.findMany({
        where: openGrant,
        orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }],
        take: 5,
        select: { id: true, action: true, reason: true, expiresAt: true, user: { select: { name: true } }, department: { select: { name: true } } },
      }),
      db.employee.findMany({
        where: { stage: "EXITED", user: { isNot: null } },
        orderBy: [{ endDate: { sort: "desc", nulls: "last" } }],
        take: 1,
        select: { name: true, endDate: true, position: { select: { title: true } }, user: { select: { id: true, status: true } } },
      }),
      seesAudit
        ? db.auditEvent.findMany({
            orderBy: { createdAt: "desc" },
            take: 8,
            select: { id: true, action: true, createdAt: true, actorEmail: true, actor: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    const leaver = leavers[0] ?? null;
    const leaverUserId = leaver?.user?.id;
    const [heldAssets, heldSeats, heldGrants] = leaverUserId
      ? await Promise.all([
          db.asset.count({ where: { custodianId: leaverUserId, status: "IN_USE" } }),
          db.licenceSeat.count({ where: { userId: leaverUserId, revokedAt: null } }),
          db.delegationGrant.count({ where: { userId: leaverUserId, ...openGrant } }),
        ])
      : [0, 0, 0];

    return ok({
      roles,
      mustChange,
      failedLogins,
      grants,
      leaver: leaver ? { ...leaver, heldAssets, heldSeats, heldGrants } : null,
      audit,
      seesAudit,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
