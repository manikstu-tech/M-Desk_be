// HR module catalogue — "M-Desk HR Module Functional Requirements" v2.0 (28 Oct 2026).
// Pure data and rules (no DB) so client components and tests can import it.
// Policy-shaped values here (checklists, mandatory documents) are starting
// samples: the spec (§16) leaves them for HR to confirm before production.

import type {
  AttendanceStatus,
  EmailStatus,
  EmployeeStage,
  EmploymentType,
  HolidayCategory,
  HrDocCategory,
  LetterStatus,
  LetterType,
  Qualification,
} from "@prisma/client";

export const HR_SLUG = "hr-administration";
export const HR_BASE = `/departments/${HR_SLUG}`;

export type HrNavItem = { slug: string | null; label: string; scope: string };
export type HrNavSection = { heading: string; items: HrNavItem[] };

// §3 HR Module Navigation — grouped by section.
export const HR_NAV: HrNavSection[] = [
  {
    heading: "OVERVIEW",
    items: [
      { slug: "", label: "HR Dashboard", scope: "Headcount, interns vs permanent staff, approvals, onboarding, documents, email and holidays" },
    ],
  },
  {
    heading: "CORE HR",
    items: [
      { slug: "employees",  label: "Employees",         scope: "Directory, profile, employee type, position, department, manager, status and history" },
      { slug: "onboarding", label: "Onboarding",        scope: "New employee wizard, checklist, task assignment, joining documents and progress" },
      { slug: "letters",    label: "Letters & Documents", scope: "Templates, generated letters, document repository, verification and access history" },
    ],
  },
  {
    heading: "TIME & LEAVE",
    items: [
      { slug: "attendance-leave", label: "Attendance & Leave", scope: "Attendance records, leave requests, balances, policy configuration and approvals" },
      { slug: "holidays",         label: "Holiday Calendar",   scope: "Organisation holidays and employee-type-specific holiday calendars" },
    ],
  },
  {
    heading: "PERFORMANCE & COMPLIANCE",
    items: [
      { slug: "kras-performance", label: "KRAs & Performance",   scope: "Key result areas, scorecards and performance reviews" },
      { slug: "policies-compliance", label: "Policies & Compliance",  scope: "Company policies, acknowledgements and compliance tracking" },
      { slug: "training", label: "Training & Learning",   scope: "Course library, enrolments, progress and certificates" },
    ],
  },
  {
    heading: "REPORTS & INSIGHTS",
    items: [
      { slug: "reports", label: "Reports",   scope: "Employee, onboarding, document, attendance, leave, holiday, email and audit reports" },
      { slug: "analytics", label: "Analytics", scope: "HR analytics, trends and workforce insights" },
    ],
  },
  {
    heading: "ADMINISTRATION",
    items: [
      { slug: "settings", label: "Settings & Audit", scope: "Positions, template versions, roles, email provider and the HR audit log" },
    ],
  },
];

export function hrHref(slug: string): string {
  return slug ? `${HR_BASE}/${slug}` : HR_BASE;
}

// ───────────── labels ─────────────

export const EMPLOYMENT_TYPES: EmploymentType[] = ["INTERN", "PERMANENT", "CONTRACT"];

export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = {
  INTERN: "Intern",
  PERMANENT: "Permanent",
  CONTRACT: "Contract",
};

const CODE_PREFIX: Record<EmploymentType, string> = { INTERN: "INT", PERMANENT: "EMP", CONTRACT: "CON" };

export const MOVE_KINDS = ["PROMOTION", "TRANSFER", "ROLE_CHANGE"] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

export const MOVE_KIND_LABEL: Record<MoveKind, string> = {
  PROMOTION: "Promotion",
  TRANSFER: "Department transfer",
  ROLE_CHANGE: "Role change",
};

// Records that have ended stay as they were when they ended.
const CLOSED_STAGES: EmployeeStage[] = ["REJECTED", "DECLINED", "EXPIRED", "WITHDRAWN", "EXITED"];

export function canMoveEmployee(stage: EmployeeStage): boolean {
  return !CLOSED_STAGES.includes(stage);
}

export function employeeCode(type: EmploymentType, seq: number): string {
  return `${CODE_PREFIX[type]}-${String(seq).padStart(4, "0")}`;
}

export const STAGE_LABEL: Record<EmployeeStage, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "Pending Review",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  SENT: "Sent",
  AWAITING_ACCEPTANCE: "Awaiting Acceptance",
  ACCEPTED: "Accepted",
  ONBOARDING_IN_PROGRESS: "Onboarding In Progress",
  ACTIVE: "Active",
  REJECTED: "Rejected",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
  ON_HOLD: "On Hold",
  SUSPENDED: "Suspended",
  EXITED: "Exited",
};

export const ONBOARDING_STAGES: EmployeeStage[] = [
  "DRAFT",
  "PENDING_REVIEW",
  "PENDING_APPROVAL",
  "APPROVED",
  "SENT",
  "AWAITING_ACCEPTANCE",
  "ACCEPTED",
  "ONBOARDING_IN_PROGRESS",
];

export const LETTER_TYPE_LABEL: Record<LetterType, string> = {
  OFFER: "Offer Letter",
  APPOINTMENT: "Appointment / Employment Letter",
  INTERNSHIP_OFFER: "Internship Offer / Agreement",
  EMPLOYMENT_AGREEMENT: "Permanent Employment Agreement",
  NDA: "NDA / Confidentiality Agreement",
  JOINING: "Joining Confirmation",
  POLICY_ACK: "Policy Acknowledgement",
  EXPERIENCE: "Experience Letter",
  INTERNSHIP_COMPLETION: "Internship Completion Letter",
  RELIEVING: "Relieving Letter",
};

// Letters that carry the employment offer and drive Sent → Awaiting Acceptance.
export const OFFER_TYPES: LetterType[] = ["OFFER", "INTERNSHIP_OFFER"];
// §5: issued only after eligibility and authorised exit/completion approval.
export const EXIT_LETTER_TYPES: LetterType[] = ["EXPERIENCE", "INTERNSHIP_COMPLETION", "RELIEVING"];

/** Which letters each employment type may generate (§5, §8 "Documents"). */
export const LETTERS_FOR_TYPE: Record<EmploymentType, LetterType[]> = {
  INTERN: ["INTERNSHIP_OFFER", "NDA", "JOINING", "POLICY_ACK", "INTERNSHIP_COMPLETION", "RELIEVING"],
  PERMANENT: ["OFFER", "APPOINTMENT", "EMPLOYMENT_AGREEMENT", "NDA", "JOINING", "POLICY_ACK", "EXPERIENCE", "RELIEVING"],
  CONTRACT: ["OFFER", "APPOINTMENT", "NDA", "JOINING", "POLICY_ACK", "EXPERIENCE", "RELIEVING"],
};

export const LETTER_STATUS_LABEL: Record<LetterStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
  SUPERSEDED: "Superseded",
};

export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT_TO_PROVIDER: "Sent to provider",
  DELIVERED: "Delivered",
  BOUNCED: "Bounced",
  FAILED: "Failed",
  RETRY_SCHEDULED: "Retry scheduled",
};

export const DOC_CATEGORY_LABEL: Record<HrDocCategory, string> = {
  IDENTITY: "Identity & personal",
  HIRING: "Hiring & employment",
  ONBOARDING: "Onboarding",
  PERFORMANCE_TRAINING: "Performance & training",
  ATTENDANCE_LEAVE: "Attendance & leave",
  EXIT: "Exit & completion",
};

export const HOLIDAY_CATEGORY_LABEL: Record<HolidayCategory, string> = {
  PUBLIC: "National / public",
  COMPANY: "Company",
  OPTIONAL: "Optional / restricted",
  SHUTDOWN: "Organisation shutdown",
};

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  HALF_DAY: "Half day",
  ON_LEAVE: "On leave",
  HOLIDAY: "Holiday",
};

// ───────────── onboarding status model (§4) ─────────────

export type StageMove = { to: EmployeeStage; label: string; approval?: boolean; system?: boolean };

/** Allowed stage transitions. `system` moves happen through letters/scan, never by hand. */
export const STAGE_MOVES: Record<EmployeeStage, StageMove[]> = {
  DRAFT: [
    { to: "PENDING_REVIEW", label: "Submit for review" },
    { to: "ON_HOLD", label: "Put on hold" },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  PENDING_REVIEW: [
    { to: "PENDING_APPROVAL", label: "Reviewed — send for approval" },
    { to: "DRAFT", label: "Return to draft" },
    { to: "ON_HOLD", label: "Put on hold" },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  PENDING_APPROVAL: [
    { to: "APPROVED", label: "Approve terms", approval: true },
    { to: "REJECTED", label: "Reject terms", approval: true },
    { to: "PENDING_REVIEW", label: "Send back to review" },
  ],
  APPROVED: [
    { to: "SENT", label: "Offer sent", system: true },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  SENT: [
    { to: "AWAITING_ACCEPTANCE", label: "Awaiting acceptance", system: true },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  AWAITING_ACCEPTANCE: [
    { to: "ACCEPTED", label: "Offer accepted", system: true },
    { to: "DECLINED", label: "Offer declined", system: true },
    { to: "EXPIRED", label: "Offer expired", system: true },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  ACCEPTED: [
    { to: "ONBOARDING_IN_PROGRESS", label: "Start onboarding" },
    { to: "ON_HOLD", label: "Put on hold" },
  ],
  ONBOARDING_IN_PROGRESS: [
    { to: "ACTIVE", label: "Confirm joining & activate" },
    { to: "ON_HOLD", label: "Put on hold" },
    { to: "WITHDRAWN", label: "Withdraw" },
  ],
  ACTIVE: [
    { to: "SUSPENDED", label: "Suspend" },
    { to: "EXITED", label: "Record exit" },
  ],
  SUSPENDED: [
    { to: "ACTIVE", label: "Reinstate" },
    { to: "EXITED", label: "Record exit" },
  ],
  ON_HOLD: [
    { to: "DRAFT", label: "Resume as draft" },
    { to: "ONBOARDING_IN_PROGRESS", label: "Resume onboarding" },
  ],
  REJECTED: [{ to: "DRAFT", label: "Revise terms" }],
  EXPIRED: [{ to: "DRAFT", label: "Re-offer" }],
  DECLINED: [],
  WITHDRAWN: [],
  EXITED: [],
};

export function stageMove(from: EmployeeStage, to: EmployeeStage): StageMove | undefined {
  return STAGE_MOVES[from].find((m) => m.to === to);
}

// ───────────── checklists & mandatory documents (samples, §16) ─────────────

export type ChecklistItem = { title: string; owner: string; dueOffsetDays: number; mandatory: boolean };

const COMMON_CHECKLIST: ChecklistItem[] = [
  { title: "Verify identity and address proof", owner: "HR", dueOffsetDays: -3, mandatory: true },
  { title: "Collect signed NDA / confidentiality agreement", owner: "HR", dueOffsetDays: -1, mandatory: true },
  { title: "Request M-DESK and email account (IT access workflow)", owner: "IT", dueOffsetDays: -2, mandatory: true },
  { title: "Prepare workstation and equipment", owner: "Admin", dueOffsetDays: -1, mandatory: false },
  { title: "Policy acknowledgement (code of conduct, information security)", owner: "Employee", dueOffsetDays: 1, mandatory: true },
  { title: "Induction session attended", owner: "HR", dueOffsetDays: 7, mandatory: true },
];

export const CHECKLISTS: Record<EmploymentType, ChecklistItem[]> = {
  INTERN: [
    ...COMMON_CHECKLIST,
    { title: "Assign mentor and agree learning plan", owner: "Manager", dueOffsetDays: 0, mandatory: true },
    { title: "Collect college / NOC letter", owner: "HR", dueOffsetDays: -3, mandatory: false },
  ],
  PERMANENT: [
    ...COMMON_CHECKLIST,
    { title: "Collect bank and payroll details (restricted)", owner: "HR", dueOffsetDays: 0, mandatory: true },
    { title: "Manager welcome and 30-day goals", owner: "Manager", dueOffsetDays: 3, mandatory: true },
  ],
  CONTRACT: [
    ...COMMON_CHECKLIST,
    { title: "Confirm contract term and renewal owner", owner: "HR", dueOffsetDays: 0, mandatory: true },
  ],
};

export const MANDATORY_DOCS: Record<EmploymentType, { label: string; category: HrDocCategory }[]> = {
  INTERN: [
    { label: "Identity proof", category: "IDENTITY" },
    { label: "Address proof", category: "IDENTITY" },
    { label: "Education proof", category: "ONBOARDING" },
    { label: "Signed internship agreement", category: "HIRING" },
  ],
  PERMANENT: [
    { label: "Identity proof", category: "IDENTITY" },
    { label: "Address proof", category: "IDENTITY" },
    { label: "Education proof", category: "ONBOARDING" },
    { label: "Resume", category: "HIRING" },
    { label: "Signed employment agreement", category: "HIRING" },
  ],
  CONTRACT: [
    { label: "Identity proof", category: "IDENTITY" },
    { label: "Address proof", category: "IDENTITY" },
    { label: "Signed contract", category: "HIRING" },
  ],
};

// ───────────── joining details: identity, bank, education (§4 step 2) ─────────────

export const QUALIFICATIONS: Qualification[] = ["TENTH", "TWELFTH", "GRADUATION", "POST_GRADUATION"];

export const QUALIFICATION_LABEL: Record<Qualification, string> = {
  TENTH: "10th (Secondary)",
  TWELFTH: "12th (Higher secondary)",
  GRADUATION: "Graduation",
  POST_GRADUATION: "Post-graduation",
};

export const CERTIFICATE_LABEL: Record<Qualification, string> = {
  TENTH: "10th certificate",
  TWELFTH: "12th certificate",
  GRADUATION: "Graduation certificate",
  POST_GRADUATION: "Post-graduation certificate",
};

/** Certificates to collect for the highest qualification: every level up to and including it. */
export function certificatesFor(q: Qualification): { key: Qualification; label: string }[] {
  return QUALIFICATIONS.slice(0, QUALIFICATIONS.indexOf(q) + 1).map((key) => ({ key, label: CERTIFICATE_LABEL[key] }));
}

/** Files collected on the new-employee form besides the certificates. */
export const JOINING_UPLOADS: { key: string; label: string; category: HrDocCategory; accept?: string }[] = [
  { key: "photo", label: "Passport size photo", category: "IDENTITY", accept: "image/*" },
  { key: "aadhaar", label: "Aadhaar card", category: "IDENTITY" },
  { key: "pan", label: "PAN card", category: "IDENTITY" },
  { key: "bank", label: "Bank proof (cancelled cheque / passbook)", category: "ONBOARDING" },
];

// New-employee choices (steps 1 and 3).
export const GENDERS = ["Female", "Male", "Other", "Prefer not to say"] as const;
export const MARITAL_STATUSES = ["Single", "Married", "Divorced", "Widowed"] as const;
export const PAY_FREQUENCIES = ["Monthly", "Fortnightly", "Weekly"] as const;

export type OnboardingDoc = { label: string; category: HrDocCategory; description: string; accept?: string };

/** New-employee step 2: the files to collect. Labels match JOINING_UPLOADS / MANDATORY_DOCS so compliance counts stay right. */
export function onboardingDocuments(type: EmploymentType, qualification: Qualification | null): { required: OnboardingDoc[]; optional: OnboardingDoc[] } {
  const signed: Record<EmploymentType, OnboardingDoc> = {
    PERMANENT: { label: "Signed employment agreement", category: "HIRING", description: "Duly signed employment agreement" },
    INTERN: { label: "Signed internship agreement", category: "HIRING", description: "Duly signed internship agreement" },
    CONTRACT: { label: "Signed contract", category: "HIRING", description: "Duly signed contract with term and renewal" },
  };
  const required: OnboardingDoc[] = [
    { label: "Aadhaar card", category: "IDENTITY", description: "Government issued identity proof (only the last 4 digits are shown to non-HR users)" },
    { label: "PAN card", category: "IDENTITY", description: "Income tax identification number" },
    { label: "Passport size photo", category: "IDENTITY", description: "Recent passport size photograph", accept: "image/*" },
    ...(qualification ? certificatesFor(qualification) : []).map((c) => ({
      label: c.label,
      category: "ONBOARDING" as const,
      description: "Education certificate up to the highest qualification",
    })),
    ...(type === "PERMANENT" ? [{ label: "Resume", category: "HIRING" as const, description: "Latest resume / CV" }] : []),
    signed[type],
  ];
  const optional: OnboardingDoc[] = [
    { label: "Address proof", category: "IDENTITY", description: "Only if the address differs from Aadhaar" },
    ...(type === "INTERN"
      ? []
      : [
          { label: "Experience certificate", category: "HIRING" as const, description: "Previous employment certificates (if applicable)" },
          { label: "Relieving letter", category: "HIRING" as const, description: "Relieving letter from the last employer (if applicable)" },
        ]),
    { label: "Medical fitness certificate", category: "ONBOARDING", description: "From an authorised doctor (as per policy)" },
  ];
  return { required, optional };
}

/** Specific documents that satisfy the generic mandatory ones. */
const SATISFIES: Record<string, string[]> = {
  "Identity proof": ["Aadhaar card", "PAN card"],
  "Address proof": ["Aadhaar card"],
  "Education proof": Object.values(CERTIFICATE_LABEL),
};

/** Each mandatory document for the type, and whether a non-rejected upload covers it. */
export function mandatoryDocStatus(
  type: EmploymentType,
  docs: { label: string; verification: string }[],
): { label: string; uploaded: boolean }[] {
  const have = new Set(docs.filter((d) => d.verification !== "REJECTED").map((d) => d.label));
  return MANDATORY_DOCS[type].map(({ label }) => ({
    label,
    uploaded: have.has(label) || (SATISFIES[label] ?? []).some((alt) => have.has(alt)),
  }));
}

export function missingMandatoryDocs(type: EmploymentType, docs: { label: string; verification: string }[]): string[] {
  return mandatoryDocStatus(type, docs)
    .filter((d) => !d.uploaded)
    .map((d) => d.label);
}

/** "XXXX XXXX 1234": identity and account numbers without an APPROVE grant. */
export function maskId(value: string | null): string {
  if (!value) return "—";
  return `${"X".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`.replace(/(.{4})(?=.)/g, "$1 ");
}

// ───────────── letter templates (§5) ─────────────

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
const CONDITIONAL = /\{\{#(INTERN|PERMANENT|CONTRACT)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

export const TEMPLATE_FIELDS = [
  "employee_name",
  "employee_id",
  "position",
  "department",
  "manager",
  "location",
  "employment_type",
  "start_date",
  "end_date",
  "probation_months",
  "compensation",
  "work_mode",
  "mentor",
  "acceptance_deadline",
  "company_name",
  "company_address",
  "signatory",
  "reference",
  "issue_date",
] as const;

/**
 * Renders a template: keeps `{{#TYPE}}…{{/TYPE}}` blocks for the employee's type,
 * fills `{{field}}` placeholders and reports every one left blank or unknown.
 * Callers must refuse to issue when `missing` is non-empty (§5 document rules).
 */
export function renderTemplate(
  body: string,
  fields: Record<string, string | null | undefined>,
  type: EmploymentType,
): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const withBlocks = body.replace(CONDITIONAL, (_m, t: string, inner: string) => (t === type ? inner : ""));
  const text = withBlocks.replace(PLACEHOLDER, (_m, key: string) => {
    const v = fields[key];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.add(key);
      return `{{${key}}}`;
    }
    return String(v);
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), missing: [...missing] };
}

// ───────────── leave (§8) ─────────────

export type Allowance = { type: string; days: number };

export function parseAllowances(raw: unknown): Allowance[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    if (a && typeof a === "object" && "type" in a && "days" in a) {
      const type = String((a as { type: unknown }).type);
      const days = Number((a as { days: unknown }).days);
      return type && Number.isFinite(days) ? [{ type, days }] : [];
    }
    return [];
  });
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Working days in [start, end], skipping weekends and the given holiday dates. */
export function countLeaveDays(start: Date, end: Date, holidayKeys: Set<string>, halfDay = false): number {
  if (end < start) return 0;
  let days = 0;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (d.getTime() <= last) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidayKeys.has(dayKey(d))) days++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return halfDay && days === 1 ? 0.5 : days;
}
