import type { EmailStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import type { Tx } from "./audit";
import { notifyUsers } from "./notify";
import { hrAdminIds, hrAudit, hrDept } from "./hr";
import { hrHref } from "./hr-catalogue";

// §7 email sending. The company has not chosen a provider yet (§16), so the
// default "outbox" provider records every message and its lifecycle without
// sending anything. A real provider plugs in behind EmailProvider.send and
// reports delivery/bounce through the same providerEvent path.

export const EMAIL_PROVIDER = process.env.HR_EMAIL_PROVIDER?.trim() || "outbox";
export const EMAIL_FROM = process.env.HR_EMAIL_FROM?.trim() || "hr@m-desk.local";
const MAX_ATTEMPTS = 3;
const RETRY_MINUTES = 15;

class PermanentEmailError extends Error {}

type EmailProvider = { send(msg: { id: string; to: string; subject: string; body: string }): Promise<string> };

const outbox: EmailProvider = {
  async send(msg) {
    if (!z.string().email().safeParse(msg.to).success) {
      throw new PermanentEmailError("Invalid recipient address");
    }
    return `outbox-${msg.id}`;
  },
};

function provider(): EmailProvider {
  if (EMAIL_PROVIDER === "outbox") return outbox;
  throw new Error(`Email provider "${EMAIL_PROVIDER}" is not configured`);
}

export async function queueEmail(
  tx: Tx,
  msg: {
    employeeId?: string | null;
    relatedType: string;
    relatedId?: string | null;
    recipient: string;
    subject: string;
    body: string;
    createdById?: string | null;
  },
) {
  return tx.emailLog.create({ data: { ...msg, provider: EMAIL_PROVIDER, status: "QUEUED" } });
}

/** One send attempt. Transient failures back off; permanent ones fail at once. */
export async function deliverEmail(id: string): Promise<EmailStatus> {
  const email = await db.emailLog.findUnique({ where: { id } });
  if (!email || (email.status !== "QUEUED" && email.status !== "RETRY_SCHEDULED")) {
    return email?.status ?? "FAILED";
  }
  const dept = await hrDept();
  const attempts = email.attempts + 1;
  await db.emailLog.update({ where: { id }, data: { status: "SENDING", attempts } });

  try {
    const providerId = await provider().send({ id, to: email.recipient, subject: email.subject, body: email.body });
    await db.$transaction(async (tx) => {
      await tx.emailLog.update({
        where: { id },
        data: { status: "SENT_TO_PROVIDER", providerId, sentAt: new Date(), lastError: null, nextAttemptAt: null },
      });
      await hrAudit(tx, null, dept.id, {
        action: "HR_EMAIL_SENT_TO_PROVIDER",
        targetType: "EmailLog",
        targetId: id,
        detail: { relatedType: email.relatedType, relatedId: email.relatedId ?? null, attempt: attempts },
      });
    });
    return "SENT_TO_PROVIDER";
  } catch (e) {
    const permanent = e instanceof PermanentEmailError;
    const status: EmailStatus = !permanent && attempts < MAX_ATTEMPTS ? "RETRY_SCHEDULED" : "FAILED";
    const reason = e instanceof Error ? e.message : "Send failed";
    await db.$transaction(async (tx) => {
      await tx.emailLog.update({
        where: { id },
        data: {
          status,
          lastError: reason,
          nextAttemptAt: status === "RETRY_SCHEDULED" ? new Date(Date.now() + RETRY_MINUTES * attempts * 60_000) : null,
        },
      });
      await hrAudit(tx, null, dept.id, {
        action: status === "FAILED" ? "HR_EMAIL_FAILED" : "HR_EMAIL_RETRY_SCHEDULED",
        targetType: "EmailLog",
        targetId: id,
        detail: { reason, attempt: attempts },
      });
      if (status === "FAILED") {
        await notifyUsers(tx, await hrAdminIds(), {
          title: `Email failed: ${email.subject}`,
          body: reason,
          link: hrHref("letters"),
        });
      }
    });
    return status;
  }
}

/** Background job: resend every scheduled retry that is due. */
export async function retryDueEmails(now = new Date()) {
  const due = await db.emailLog.findMany({
    where: { status: { in: ["RETRY_SCHEDULED", "QUEUED"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { id: true },
    take: 100,
  });
  for (const e of due) await deliverEmail(e.id);
  return due.length;
}
