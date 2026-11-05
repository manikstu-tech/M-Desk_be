import { Action, type EmployeeStage, type EmploymentType, type LetterStatus, type LetterType, type Prisma } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { storeBlob } from "./documents";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { fmtDate, hrAdminIds, hrAudit, hrCan, requireHr } from "./hr";
import { deliverEmail, queueEmail } from "./hr-email";
import { setStage } from "./hr-employees";
import { renderLetterPdf } from "./hr-pdf";
import {
  EMPLOYMENT_TYPE_LABEL,
  EXIT_LETTER_TYPES,
  LETTER_TYPE_LABEL,
  LETTERS_FOR_TYPE,
  OFFER_TYPES,
  renderTemplate,
} from "./hr-catalogue";

const DAY = 24 * 60 * 60 * 1000;
const OPEN_LETTER = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED"] as const;

export function companyDetails() {
  return {
    company_name: process.env.HR_COMPANY_NAME?.trim() ?? "",
    company_address: process.env.HR_COMPANY_ADDRESS?.trim() ?? "",
    signatory: process.env.HR_SIGNATORY?.trim() ?? "",
  };
}

const SHORT: Record<LetterType, string> = {
  OFFER: "OFR",
  APPOINTMENT: "APT",
  INTERNSHIP_OFFER: "INO",
  EMPLOYMENT_AGREEMENT: "EMA",
  NDA: "NDA",
  JOINING: "JON",
  POLICY_ACK: "POL",
  EXPERIENCE: "EXP",
  INTERNSHIP_COMPLETION: "INC",
  RELIEVING: "REL",
};

/** Latest approved template for the type — employment-type specific first, then generic. */
export async function activeTemplate(type: LetterType, employmentType: EmploymentType) {
  for (const et of [employmentType, null]) {
    const t = await db.letterTemplate.findFirst({
      where: { type, employmentType: et, status: "APPROVED" },
      orderBy: { version: "desc" },
    });
    if (t) return t;
  }
  return null;
}

/** The term snapshot stored on a letter, as plain strings. */
export function snapshot(raw: Prisma.JsonValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) out[k] = v == null ? "" : String(v);
  }
  return out;
}

function money(v: Prisma.Decimal | null, type: EmploymentType): string {
  if (v === null) return "";
  const amount = Number(v.toString()).toLocaleString("en-IN");
  return type === "INTERN" ? `INR ${amount} per month (stipend)` : `INR ${amount} per annum`;
}

async function pdfFor(
  letter: { reference: string; type: LetterType; createdAt: Date },
  text: string,
  templateVersion: number,
  draft: boolean,
) {
  const c = companyDetails();
  return renderLetterPdf({
    companyName: c.company_name,
    companyAddress: c.company_address,
    signatory: c.signatory,
    title: LETTER_TYPE_LABEL[letter.type],
    reference: letter.reference,
    issueDate: fmtDate(letter.createdAt),
    body: text,
    templateVersion,
    draft,
  });
}

/** §5: populate an approved template; refuse while any field is unresolved. */
export async function generateLetter(
  session: AuthSession,
  input: { employeeId: string; type: LetterType; acceptanceDays?: number },
) {
  const dept = await requireHr(session, Action.EDIT);
  const emp = await db.employee.findUnique({
    where: { id: input.employeeId },
    include: { position: true, department: true, manager: { select: { name: true } } },
  });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  if (!LETTERS_FOR_TYPE[emp.employmentType].includes(input.type)) {
    throw new ApiError(
      422,
      "VALIDATION",
      `${LETTER_TYPE_LABEL[input.type]} does not apply to ${EMPLOYMENT_TYPE_LABEL[emp.employmentType]} staff`,
    );
  }
  if (EXIT_LETTER_TYPES.includes(input.type) && emp.stage !== "EXITED") {
    throw new ApiError(409, "CONFLICT", "Exit and completion letters need an approved exit first");
  }
  const template = await activeTemplate(input.type, emp.employmentType);
  if (!template) throw new ApiError(409, "CONFLICT", `No approved template for ${LETTER_TYPE_LABEL[input.type]}`);

  const version = (await db.generatedLetter.count({ where: { employeeId: emp.id, type: input.type } })) + 1;
  const reference = `MD-HR-${SHORT[input.type]}-${emp.code ?? emp.seq}-V${version}`;
  const now = new Date();
  const deadline = OFFER_TYPES.includes(input.type)
    ? new Date(now.getTime() + (input.acceptanceDays ?? 7) * DAY)
    : null;
  const months = emp.endDate
    ? Math.max(1, Math.round((emp.endDate.getTime() - emp.joiningDate.getTime()) / (30.44 * DAY)))
    : null;

  const fields: Record<string, string> = {
    employee_name: emp.name,
    employee_id: emp.code ?? "",
    position: emp.position.title,
    department: emp.department.name,
    manager: emp.manager?.name ?? "",
    location: emp.location,
    employment_type: EMPLOYMENT_TYPE_LABEL[emp.employmentType],
    start_date: fmtDate(emp.joiningDate),
    end_date: emp.endDate ? fmtDate(emp.endDate) : "",
    duration_months: months ? String(months) : "",
    probation_months: emp.probationMonths != null ? String(emp.probationMonths) : "",
    compensation: money(emp.compensation, emp.employmentType),
    work_mode: emp.workMode ?? "",
    mentor: emp.mentor ?? "",
    acceptance_deadline: deadline ? fmtDate(deadline) : "",
    reference,
    issue_date: fmtDate(now),
    ...companyDetails(),
  };
  const { text, missing } = renderTemplate(template.body, fields, emp.employmentType);
  if (missing.length > 0) {
    throw new ApiError(422, "VALIDATION", `Fill these before generating: ${missing.join(", ")}`);
  }

  const pdf = await pdfFor({ reference, type: input.type, createdAt: now }, text, template.version, true);
  const storagePath = await storeBlob(pdf);

  return db.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        title: `${LETTER_TYPE_LABEL[input.type]} — ${emp.name} (v${version})`,
        departmentId: dept.id,
        confidentiality: "L3",
        currentVersion: 1,
        createdById: session.user.id,
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        version: 1,
        storagePath,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        changeNote: "Generated draft",
        createdById: session.user.id,
      },
    });
    const superseded = await tx.generatedLetter.updateMany({
      where: { employeeId: emp.id, type: input.type, status: { in: [...OPEN_LETTER] } },
      data: { status: "SUPERSEDED" },
    });
    const letter = await tx.generatedLetter.create({
      data: {
        reference,
        employeeId: emp.id,
        templateId: template.id,
        type: input.type,
        version,
        fields: {
          ...fields,
          template_version: String(template.version),
          acceptance_deadline_iso: deadline ? deadline.toISOString() : "",
        },
        documentId: doc.id,
        createdById: session.user.id,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_LETTER_GENERATED",
      targetType: "GeneratedLetter",
      targetId: letter.id,
      detail: { employeeId: emp.id, type: input.type, reference, templateVersion: template.version, superseded: superseded.count },
    });
    return letter;
  });
}

type LetterAction = "SUBMIT" | "APPROVE" | "REJECT" | "SEND" | "ACCEPT" | "DECLINE" | "WITHDRAW";

export async function letterAction(session: AuthSession, id: string, action: LetterAction, comment?: string) {
  const letter = await db.generatedLetter.findUnique({
    where: { id },
    include: { employee: true, template: true },
  });
  if (!letter) throw new ApiError(404, "NOT_FOUND", "Letter not found");
  const emp = letter.employee;
  const isOffer = OFFER_TYPES.includes(letter.type);
  const conflict = (msg: string) => new ApiError(409, "CONFLICT", msg);
  const audit = { targetType: "GeneratedLetter", targetId: id };

  switch (action) {
    case "SUBMIT": {
      if (letter.status !== "DRAFT") throw conflict("Only drafts can be submitted for approval");
      const dept = await requireHr(session, Action.EDIT);
      await db.$transaction(async (tx) => {
        await tx.generatedLetter.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
        await hrAudit(tx, session, dept.id, { action: "HR_LETTER_SUBMITTED", ...audit });
      });
      return;
    }
    case "APPROVE":
    case "REJECT": {
      if (letter.status !== "PENDING_APPROVAL") throw conflict("This letter is not awaiting approval");
      const dept = await requireHr(session, Action.APPROVE);
      if (letter.createdById === session.user.id && session.user.role.name !== "SUPER_ADMIN") {
        throw conflict("The person who generated a letter cannot approve it");
      }
      if (action === "REJECT") {
        if (!comment) throw new ApiError(422, "VALIDATION", "Give a reason for rejecting");
        await db.$transaction(async (tx) => {
          await tx.generatedLetter.update({ where: { id }, data: { status: "REJECTED" } });
          await hrAudit(tx, session, dept.id, { action: "HR_LETTER_REJECTED", ...audit, detail: { comment } });
          await notifyUsers(tx, [letter.createdById], {
            title: `Letter rejected: ${letter.reference}`,
            body: comment,
            link: `/departments/hr-administration/employees/${emp.id}`,
          });
        });
        return;
      }
      // Re-render the approved text without the draft watermark as a new document version.
      const { text } = renderTemplate(letter.template.body, snapshot(letter.fields), emp.employmentType);
      const pdf = await pdfFor(letter, text, letter.template.version, false);
      const storagePath = await storeBlob(pdf);
      await db.$transaction(async (tx) => {
        if (letter.documentId) {
          const doc = await tx.document.findUniqueOrThrow({ where: { id: letter.documentId } });
          const v = doc.currentVersion + 1;
          await tx.documentVersion.create({
            data: {
              documentId: doc.id,
              version: v,
              storagePath,
              mimeType: "application/pdf",
              sizeBytes: pdf.length,
              changeNote: "Approved for issue",
              createdById: session.user.id,
            },
          });
          await tx.document.update({ where: { id: doc.id }, data: { currentVersion: v, status: "APPROVED" } });
        }
        await tx.generatedLetter.update({
          where: { id },
          data: { status: "APPROVED", approvedById: session.user.id, approvedAt: new Date() },
        });
        await hrAudit(tx, session, dept.id, { action: "HR_LETTER_APPROVED", ...audit });
      });
      // "Send now" was chosen when it was generated: issue it straight away when allowed.
      if (letter.sendOnApproval && (!isOffer || emp.stage === "APPROVED")) {
        await letterAction(session, id, "SEND");
      }
      return;
    }
    case "SEND": {
      if (letter.status !== "APPROVED") throw conflict("Approve the letter before it can be issued");
      if (isOffer && emp.stage !== "APPROVED") {
        throw conflict("Approve the employee's terms (stage Approved) before sending the offer");
      }
      const dept = await requireHr(session, Action.EDIT);
      const snap = snapshot(letter.fields);
      const deadlineText = snap.acceptance_deadline ?? "";
      const deadline = isOffer
        ? snap.acceptance_deadline_iso
          ? new Date(snap.acceptance_deadline_iso)
          : new Date(Date.now() + 7 * DAY)
        : null;
      const emailId = await db.$transaction(async (tx) => {
        await tx.generatedLetter.update({ where: { id }, data: { status: "SENT", sentAt: new Date() } });
        await hrAudit(tx, session, dept.id, { action: "HR_LETTER_SENT", ...audit, detail: { to: emp.email } });
        if (isOffer) {
          await setStage(tx, session, dept.id, emp, "SENT");
          await setStage(tx, null, dept.id, { ...emp, stage: "SENT" }, "AWAITING_ACCEPTANCE");
          await tx.employee.update({
            where: { id: emp.id },
            data: { acceptanceDeadline: deadline, remindedAt: null },
          });
        }
        const email = await queueEmail(tx, {
          employeeId: emp.id,
          relatedType: "GeneratedLetter",
          relatedId: id,
          recipient: emp.email,
          subject: `${LETTER_TYPE_LABEL[letter.type]} — ${companyDetails().company_name}`,
          body:
            `Dear ${emp.name},\n\nPlease find your ${LETTER_TYPE_LABEL[letter.type].toLowerCase()} ` +
            `(reference ${letter.reference}) available through your secure M-DESK link.` +
            (isOffer && deadlineText ? `\n\nPlease respond by ${deadlineText}.` : "") +
            `\n\nRegards,\nHR & Administration`,
          createdById: session.user.id,
        });
        return email.id;
      });
      await deliverEmail(emailId);
      return;
    }
    case "ACCEPT":
    case "DECLINE": {
      if (letter.status !== "SENT") throw conflict("Only sent letters can be accepted or declined");
      const dept = await requireHr(session, Action.EDIT);
      const accepted = action === "ACCEPT";
      await db.$transaction(async (tx) => {
        await tx.generatedLetter.update({
          where: { id },
          data: { status: accepted ? "ACCEPTED" : "DECLINED", respondedAt: new Date() },
        });
        await hrAudit(tx, session, dept.id, {
          action: accepted ? "HR_LETTER_ACCEPTED" : "HR_LETTER_DECLINED",
          ...audit,
          detail: comment ? { evidence: comment } : {},
        });
        if (isOffer && emp.stage === "AWAITING_ACCEPTANCE") {
          await setStage(tx, session, dept.id, emp, accepted ? "ACCEPTED" : "DECLINED");
          const watchers = [...(await hrAdminIds()), ...(emp.managerId ? [emp.managerId] : [])];
          await notifyUsers(tx, watchers.filter((w) => w !== session.user.id), {
            title: `${emp.name} ${accepted ? "accepted" : "declined"} the offer`,
            link: `/departments/hr-administration/employees/${emp.id}`,
          });
        }
      });
      return;
    }
    case "WITHDRAW": {
      if (["WITHDRAWN", "SUPERSEDED", "ACCEPTED", "DECLINED"].includes(letter.status)) {
        throw conflict("This letter can no longer be withdrawn");
      }
      const dept = await requireHr(session, Action.EDIT);
      await db.$transaction(async (tx) => {
        await tx.generatedLetter.update({ where: { id }, data: { status: "WITHDRAWN" } });
        await hrAudit(tx, session, dept.id, { action: "HR_LETTER_WITHDRAWN", ...audit, detail: comment ? { comment } : {} });
      });
      return;
    }
  }
}

// ───────────── templates (§5 "LetterTemplate") ─────────────

export async function createTemplateVersion(
  session: AuthSession,
  input: { type: LetterType; employmentType?: EmploymentType | null; name: string; body: string },
) {
  const dept = await requireHr(session, Action.EDIT);
  const employmentType = input.employmentType ?? null;
  const last = await db.letterTemplate.findFirst({
    where: { type: input.type, employmentType },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return db.$transaction(async (tx) => {
    const t = await tx.letterTemplate.create({
      data: {
        type: input.type,
        employmentType,
        name: input.name,
        body: input.body,
        version: (last?.version ?? 0) + 1,
        createdById: session.user.id,
      },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_TEMPLATE_CREATED",
      targetType: "LetterTemplate",
      targetId: t.id,
      detail: { type: t.type, employmentType, version: t.version },
    });
    return t;
  });
}

export async function templateAction(session: AuthSession, id: string, action: "APPROVE" | "RETIRE") {
  const t = await db.letterTemplate.findUnique({ where: { id } });
  if (!t) throw new ApiError(404, "NOT_FOUND", "Template not found");
  const dept = await requireHr(session, action === "APPROVE" ? Action.APPROVE : Action.EDIT);
  if (action === "APPROVE" && t.status !== "DRAFT") throw new ApiError(409, "CONFLICT", "Only draft templates can be approved");
  if (action === "RETIRE" && t.status === "RETIRED") throw new ApiError(409, "CONFLICT", "Template already retired");
  await db.$transaction(async (tx) => {
    if (action === "APPROVE") {
      // One approved version per type/audience; earlier approved versions retire.
      await tx.letterTemplate.updateMany({
        where: { type: t.type, employmentType: t.employmentType, status: "APPROVED" },
        data: { status: "RETIRED" },
      });
    }
    await tx.letterTemplate.update({
      where: { id },
      data: action === "APPROVE"
        ? { status: "APPROVED", approvedById: session.user.id, approvedAt: new Date() }
        : { status: "RETIRED" },
    });
    await hrAudit(tx, session, dept.id, {
      action: action === "APPROVE" ? "HR_TEMPLATE_APPROVED" : "HR_TEMPLATE_RETIRED",
      targetType: "LetterTemplate",
      targetId: id,
      detail: { type: t.type, version: t.version },
    });
  });
}

// ───────────── suggested letters and one-step issuing ─────────────

const CLOSED_LETTER: LetterStatus[] = ["REJECTED", "WITHDRAWN", "SUPERSEDED", "DECLINED"];
const PRE_OFFER: EmployeeStage[] = ["DRAFT", "PENDING_REVIEW", "PENDING_APPROVAL", "APPROVED"];
const JOINED: EmployeeStage[] = ["ACCEPTED", "ONBOARDING_IN_PROGRESS", "ACTIVE"];

export type LetterSuggestion = {
  employee: { id: string; name: string; code: string | null };
  type: LetterType;
  reason: string;
  canSendNow: boolean;
};

/** Letters each person's stage calls for that have not been issued (or are not in progress) yet. */
export async function letterSuggestions(where: Prisma.EmployeeWhereInput = {}): Promise<LetterSuggestion[]> {
  const [emps, templates] = await Promise.all([
    db.employee.findMany({
      where: { ...where, stage: { in: [...PRE_OFFER, ...JOINED, "EXITED"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { letters: { select: { type: true, status: true } } },
    }),
    db.letterTemplate.findMany({ where: { status: "APPROVED" }, select: { type: true, employmentType: true } }),
  ]);
  const out: LetterSuggestion[] = [];
  for (const e of emps) {
    const preOffer = PRE_OFFER.includes(e.stage);
    const joined = JOINED.includes(e.stage);
    const wanted = LETTERS_FOR_TYPE[e.employmentType].filter((t) =>
      preOffer ? OFFER_TYPES.includes(t) : joined ? !OFFER_TYPES.includes(t) && !EXIT_LETTER_TYPES.includes(t) : EXIT_LETTER_TYPES.includes(t),
    );
    for (const t of wanted) {
      if (e.letters.some((l) => l.type === t && !CLOSED_LETTER.includes(l.status))) continue;
      if (!templates.some((x) => x.type === t && (x.employmentType === null || x.employmentType === e.employmentType))) continue;
      const offer = OFFER_TYPES.includes(t);
      out.push({
        employee: { id: e.id, name: e.name, code: e.code },
        type: t,
        reason: preOffer
          ? e.stage === "APPROVED"
            ? "Terms approved — ready for the offer"
            : "New joiner — prepare the offer (it goes out once terms are approved)"
          : joined
            ? "Joining paperwork"
            : "Exit recorded",
        canSendNow: !offer || e.stage === "APPROVED",
      });
    }
  }
  return out;
}

/**
 * Generate a letter and, for "NOW", take it as far as the rules allow: approve and
 * send when this user may approve their own letter (Super Admin), otherwise submit
 * it and send automatically once an approver approves it. "LATER" keeps a draft.
 */
export async function issueLetter(
  session: AuthSession,
  input: { employeeId: string; type: LetterType; acceptanceDays?: number; mode: "NOW" | "LATER" },
): Promise<{ id: string; reference: string; outcome: "DRAFT" | "SENT" | "AWAITING_APPROVAL" }> {
  if (input.mode === "NOW" && OFFER_TYPES.includes(input.type)) {
    const emp = await db.employee.findUnique({ where: { id: input.employeeId }, select: { stage: true } });
    if (emp && emp.stage !== "APPROVED") {
      throw new ApiError(409, "CONFLICT", "Approve the employee's terms before sending the offer — use Send later to keep a draft");
    }
  }
  const letter = await generateLetter(session, input);
  const result = { id: letter.id, reference: letter.reference };
  if (input.mode === "LATER") return { ...result, outcome: "DRAFT" };

  await db.generatedLetter.update({ where: { id: letter.id }, data: { sendOnApproval: true } });
  await letterAction(session, letter.id, "SUBMIT");
  if (session.user.role.name === "SUPER_ADMIN" && (await hrCan(session, Action.APPROVE))) {
    await letterAction(session, letter.id, "APPROVE"); // sends via sendOnApproval
    return { ...result, outcome: "SENT" };
  }
  return { ...result, outcome: "AWAITING_APPROVAL" };
}
