import { db } from "./db";
import { notifyUsers } from "./notify";
import { fmtDate, hrAdminIds, hrAudit, hrDept } from "./hr";
import { deliverEmail, queueEmail, retryDueEmails } from "./hr-email";
import { setStage } from "./hr-employees";
import { EMPLOYMENT_TYPE_LABEL, hrHref } from "./hr-catalogue";

// §12 background jobs, run with the objective scan: email retries, acceptance
// reminders, offer expiry and internship/contract end alerts. Each item is
// stamped so a re-run is a no-op (same pattern as tasks and workflows).

const DAY = 24 * 60 * 60 * 1000;
const REMIND_BEFORE_DAYS = 2;
const END_ALERT_DAYS = 14;

export async function scanHr(now = new Date()) {
  const dept = await hrDept();
  const retried = await retryDueEmails(now);

  // Acceptance deadline approaching: one reminder per offer.
  const remindable = await db.employee.findMany({
    where: {
      stage: "AWAITING_ACCEPTANCE",
      remindedAt: null,
      acceptanceDeadline: { gt: now, lte: new Date(now.getTime() + REMIND_BEFORE_DAYS * DAY) },
    },
  });
  const reminderIds: string[] = [];
  for (const emp of remindable) {
    const id = await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: emp.id }, data: { remindedAt: now } });
      const email = await queueEmail(tx, {
        employeeId: emp.id,
        relatedType: "AcceptanceReminder",
        relatedId: emp.id,
        recipient: emp.email,
        subject: "Reminder: please respond to your offer",
        body: `Dear ${emp.name},\n\nThis is a reminder to respond to your offer by ${fmtDate(emp.acceptanceDeadline)}.\n\nRegards,\nHR & Administration`,
      });
      await hrAudit(tx, null, dept.id, {
        action: "HR_REMINDER_SENT",
        targetType: "Employee",
        targetId: emp.id,
        detail: { kind: "acceptance", deadline: fmtDate(emp.acceptanceDeadline) },
      });
      return email.id;
    });
    reminderIds.push(id);
  }
  for (const id of reminderIds) await deliverEmail(id);

  // Deadline passed with no response: the offer expires.
  const lapsed = await db.employee.findMany({
    where: { stage: "AWAITING_ACCEPTANCE", acceptanceDeadline: { lte: now } },
  });
  const admins = lapsed.length ? await hrAdminIds() : [];
  for (const emp of lapsed) {
    await db.$transaction(async (tx) => {
      await setStage(tx, null, dept.id, emp, "EXPIRED", { reason: "Acceptance deadline passed" });
      await tx.generatedLetter.updateMany({
        where: { employeeId: emp.id, status: "SENT", type: { in: ["OFFER", "INTERNSHIP_OFFER"] } },
        data: { status: "WITHDRAWN" },
      });
      await notifyUsers(tx, admins, { title: `Offer expired: ${emp.name}`, link: hrHref(`employees/${emp.id}`) });
    });
  }

  // Internship / contract ending soon: alert HR once.
  const ending = await db.employee.findMany({
    where: {
      stage: "ACTIVE",
      employmentType: { in: ["INTERN", "CONTRACT"] },
      endAlertedAt: null,
      endDate: { gte: now, lte: new Date(now.getTime() + END_ALERT_DAYS * DAY) },
    },
  });
  const endAdmins = ending.length ? await hrAdminIds() : [];
  for (const emp of ending) {
    await db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: emp.id }, data: { endAlertedAt: now } });
      await notifyUsers(tx, [...endAdmins, ...(emp.managerId ? [emp.managerId] : [])], {
        title: `${EMPLOYMENT_TYPE_LABEL[emp.employmentType]} ending ${fmtDate(emp.endDate)}: ${emp.name}`,
        body: "Plan completion, extension or conversion.",
        link: hrHref(`employees/${emp.id}`),
      });
      await hrAudit(tx, null, dept.id, {
        action: "HR_END_DATE_ALERT",
        targetType: "Employee",
        targetId: emp.id,
        detail: { endDate: fmtDate(emp.endDate) },
      });
    });
  }

  return { emailsRetried: retried, reminders: reminderIds.length, offersExpired: lapsed.length, endAlerts: ending.length };
}
