import type { Prisma } from "@prisma/client";

export type Tx = Prisma.TransactionClient;

export type AuditInput = {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  departmentId?: string | null;
  outcome?: "SUCCESS" | "DENIED" | "FAILED";
  detail?: Prisma.InputJsonValue;
};

// Append-only: create is the only Prisma call ever made against AuditEvent (RULES.MD).
export async function writeAudit(tx: Tx, e: AuditInput) {
  await tx.auditEvent.create({
    data: {
      actorId: e.actorId ?? null,
      actorEmail: e.actorEmail ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      departmentId: e.departmentId ?? null,
      outcome: e.outcome ?? "SUCCESS",
      detail: e.detail,
    },
  });
}
