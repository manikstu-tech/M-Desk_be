import { Action } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { authorize, requireSession } from "@/lib/authorize";
import { membershipSchema, ok, errorResponse, ApiError } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = membershipSchema.parse(await req.json());
    await authorize(session, { departmentId: input.departmentId, action: Action.MANAGE_USERS });

    const membership = await db.$transaction(async (tx) => {
      const row = await tx.departmentMembership.create({
        data: {
          userId: input.userId,
          departmentId: input.departmentId,
          addedById: session.user.id,
        },
      });
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "MEMBERSHIP_ADDED",
        targetType: "DepartmentMembership",
        targetId: row.id,
        departmentId: input.departmentId,
        detail: { userId: input.userId },
      });
      return row;
    });

    return ok({ id: membership.id });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireSession();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new Error("id required");

    const membership = await db.departmentMembership.findUnique({ where: { id } });
    if (!membership) throw new ApiError(404, "NOT_FOUND", "Membership not found");
    await authorize(session, {
      departmentId: membership.departmentId,
      action: Action.MANAGE_USERS,
    });

    await db.$transaction(async (tx) => {
      await tx.departmentMembership.delete({ where: { id } });
      await writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "MEMBERSHIP_REMOVED",
        targetType: "DepartmentMembership",
        targetId: id,
        departmentId: membership.departmentId,
        detail: { userId: membership.userId },
      });
    });

    return ok({ removed: true });
  } catch (e) {
    return errorResponse(e);
  }
}
