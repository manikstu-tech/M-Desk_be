// SAMPLE DATA for HR Analytics (docs/HR-Analytics-Design.pdf).
// Same approach as Policies & Compliance and KRAs & Performance: fixed figures
// until the module reads live records. Every Analytics tab shows a "Sample data"
// badge. Figures agree with the other HR samples (126 employees, FY 2026 – 27).

export const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"] as const;

export const COLORS = {
  permanent: "#14663f",
  intern: "#60a5fa",
  contract: "#f6ad55",
  green: "#1f9d5b",
  olive: "#78A65A",
  amber: "#f6ad55",
  red: "#f56565",
  blue: "#60a5fa",
  violet: "#a78bfa",
  grey: "#9ca3af",
  dark: "#0e4d33",
} as const;

/** Amber / red cells and Key insights use these (Settings → Analytics once configurable). */
export const THRESHOLDS = {
  attendanceTarget: 95,
  attendanceWarn: 92,
  attrition: 15,
  complianceWarn: 88,
  complianceBad: 80,
  /** Groups smaller than this are shown as "< 5" so individuals can't be identified. */
  minGroup: 5,
} as const;

// ───────────── workforce ─────────────

export const HEADCOUNT = [112, 115, 117, 119, 121, 124, 126];
export const JOINERS = [5, 4, 3, 4, 3, 4, 3];
export const EXITS = [2, 1, 1, 2, 1, 1, 1];

export const TYPE_MIX = [
  { label: "Permanent", value: 92, color: COLORS.permanent },
  { label: "Intern", value: 22, color: COLORS.intern },
  { label: "Contract", value: 12, color: COLORS.contract },
];

export type DeptRow = {
  name: string;
  short: string;
  headcount: number;
  permanent: number;
  intern: number;
  contract: number;
  /** Headcount change since 1 April. */
  change: number;
  attendance: number;
  kraScore: number;
  compliance: number;
  /** Exits in the last 12 months. */
  exits: number;
  /** Rolling 12-month attrition %. */
  attrition: number;
};

export const DEPARTMENTS: DeptRow[] = [
  { name: "Field Operations & Beneficiary Mgmt", short: "Field Ops", headcount: 24, permanent: 17, intern: 5, contract: 2, change: 4, attendance: 91.2, kraScore: 4.1, compliance: 86, exits: 3, attrition: 12.5 },
  { name: "Livestock Procurement & Supply Chain", short: "Livestock", headcount: 18, permanent: 13, intern: 3, contract: 2, change: 3, attendance: 92.0, kraScore: 4.1, compliance: 88, exits: 3, attrition: 16.7 },
  { name: "Animal Health & Veterinary Services", short: "Animal Health", headcount: 14, permanent: 10, intern: 3, contract: 1, change: 2, attendance: 93.5, kraScore: 4.3, compliance: 91, exits: 1, attrition: 7.1 },
  { name: "Finance & Accounts", short: "Finance", headcount: 12, permanent: 9, intern: 2, contract: 1, change: 1, attendance: 95.8, kraScore: 4.3, compliance: 78, exits: 1, attrition: 8.3 },
  { name: "Infrastructure & Engineering", short: "Infra", headcount: 10, permanent: 7, intern: 1, contract: 2, change: 1, attendance: 93.9, kraScore: 4.0, compliance: 89, exits: 1, attrition: 10.0 },
  { name: "Technology & MIS", short: "Tech & MIS", headcount: 10, permanent: 6, intern: 3, contract: 1, change: 2, attendance: 96.4, kraScore: 4.5, compliance: 94, exits: 0, attrition: 0.0 },
  { name: "Programme Management & PMO", short: "PMO", headcount: 9, permanent: 7, intern: 1, contract: 1, change: 1, attendance: 95.1, kraScore: 4.2, compliance: 92, exits: 1, attrition: 11.1 },
  { name: "HR & Administration", short: "HR & Admin", headcount: 8, permanent: 6, intern: 1, contract: 1, change: 0, attendance: 96.0, kraScore: 4.2, compliance: 100, exits: 1, attrition: 12.5 },
  { name: "Procurement & Vendor Management", short: "Procurement", headcount: 7, permanent: 5, intern: 1, contract: 1, change: 0, attendance: 94.6, kraScore: 4.0, compliance: 90, exits: 1, attrition: 14.3 },
  { name: "Executive Leadership & Strategy", short: "Executive", headcount: 5, permanent: 5, intern: 0, contract: 0, change: 0, attendance: 97.1, kraScore: 4.4, compliance: 100, exits: 1, attrition: 20.0 },
  { name: "Communications & Stakeholder Relations", short: "Comms", headcount: 5, permanent: 4, intern: 1, contract: 0, change: 0, attendance: 95.5, kraScore: 4.1, compliance: 96, exits: 1, attrition: 20.0 },
  { name: "Business Development & Partnerships", short: "BD", headcount: 4, permanent: 3, intern: 1, contract: 0, change: 0, attendance: 94.9, kraScore: 4.0, compliance: 100, exits: 1, attrition: 25.0 },
];

export const TOTAL_EMPLOYEES = DEPARTMENTS.reduce((n, d) => n + d.headcount, 0);

export const TENURE = [
  { label: "< 6 m", value: 24 },
  { label: "6–12 m", value: 18 },
  { label: "1–3 y", value: 46 },
  { label: "3–5 y", value: 24 },
  { label: "5 y +", value: 14 },
];

export const LOCATIONS = [
  { label: "Head office", value: 52 },
  { label: "Field locations", value: 44 },
  { label: "Regional offices", value: 30 },
];

export const GENDER = [
  { label: "Male", value: 76, color: COLORS.blue },
  { label: "Female", value: 48, color: COLORS.violet },
  { label: "Not stated", value: 2, color: "#d1d5db" },
];

export const EXITS_BY_TENURE = [
  { label: "< 6 m", value: 4 },
  { label: "6–12 m", value: 5 },
  { label: "1–3 y", value: 4 },
  { label: "3 y +", value: 2 },
];

export const CONVERSION = { converted: 6, completed: 15 };

// ───────────── hiring & onboarding ─────────────

export const OFFERS = { issued: 34, accepted: 27, declined: 4, expired: 1, awaiting: 2 };

export const OFFER_OUTCOMES = [
  { label: "Accepted", value: OFFERS.accepted, color: COLORS.green },
  { label: "Declined", value: OFFERS.declined, color: COLORS.red },
  { label: "Expired", value: OFFERS.expired, color: COLORS.grey },
  { label: "Awaiting", value: OFFERS.awaiting, color: COLORS.amber },
];

export const FUNNEL = [
  { label: "Employee drafted", note: "New-employee wizard records", value: 38 },
  { label: "Terms approved", note: "Pending approval → Approved", value: 35 },
  { label: "Offer sent", note: "Offer / internship letter issued", value: 34 },
  { label: "Offer accepted", note: "Accepted by candidate", value: 27 },
  { label: "Joined (Active)", note: "Joining confirmed", value: 26 },
];

/** Joiners per month as [permanent, intern, contract]. */
export const JOINERS_BY_TYPE: [number, number, number][] = [
  [2, 3, 0],
  [2, 1, 1],
  [2, 1, 0],
  [2, 2, 0],
  [2, 0, 1],
  [3, 1, 0],
  [2, 1, 0],
];

export const ONBOARDING = [
  { name: "Ananya Rao", role: "Intern · Technology & MIS", progress: 83, overdue: 1, missingDocs: 0 },
  { name: "Rohit Verma", role: "Permanent · Field Operations", progress: 67, overdue: 2, missingDocs: 1 },
  { name: "Kavya Nair", role: "Permanent · Finance & Accounts", progress: 92, overdue: 0, missingDocs: 0 },
  { name: "Imran Shaikh", role: "Contract · Infrastructure", progress: 50, overdue: 3, missingDocs: 2 },
  { name: "Priya Menon", role: "Intern · Animal Health", progress: 75, overdue: 0, missingDocs: 1 },
  { name: "Arjun Patel", role: "Permanent · Livestock Procurement", progress: 58, overdue: 3, missingDocs: 1 },
];

export const DOC_HEALTH = [
  { label: "Mandatory documents complete", value: "96%", note: "121 of 126 employees" },
  { label: "Awaiting verification", value: "7", note: "Oldest 4 days" },
  { label: "Rejected documents", value: "2", note: "Re-upload requested" },
  { label: "Expiring in 30 days", value: "3", note: "ID / contract documents" },
  { label: "Email delivery rate", value: "97.8%", note: "3 bounced · 1 retry scheduled" },
  { label: "Avg. offer approval time", value: "1.8 d", note: "Pending approval → Approved" },
];

// ───────────── attendance & leave ─────────────

export const ATTENDANCE = [94.1, 93.6, 92.8, 91.9, 92.5, 93.8, 94.3];

export const LEAVE_BY_TYPE = [
  { label: "Earned", value: 296, color: COLORS.permanent },
  { label: "Casual", value: 180, color: COLORS.olive },
  { label: "Sick", value: 134, color: COLORS.amber },
  { label: "Unpaid", value: 32, color: COLORS.red },
];

/** Absence % of working days by department and month (Apr – Oct). */
export const ABSENCE_HEATMAP: { department: string; values: number[] }[] = [
  { department: "Field Ops", values: [5.1, 5.6, 6.8, 9.2, 8.0, 6.1, 5.0] },
  { department: "Livestock", values: [4.4, 4.9, 5.7, 7.6, 6.6, 5.0, 4.6] },
  { department: "Animal Health", values: [3.5, 3.9, 4.6, 5.8, 5.0, 3.9, 3.6] },
  { department: "Infra", values: [3.6, 4.0, 4.8, 5.9, 5.1, 3.8, 3.4] },
  { department: "Procurement", values: [3.1, 3.4, 3.9, 4.6, 4.2, 3.3, 3.0] },
  { department: "Finance", values: [2.2, 2.6, 2.9, 3.3, 2.9, 2.4, 2.1] },
  { department: "PMO", values: [2.5, 2.8, 3.2, 3.6, 3.2, 2.6, 2.4] },
  { department: "Tech & MIS", values: [1.9, 2.2, 2.6, 3.0, 2.7, 2.1, 1.8] },
];

export const WEEKDAY_ABSENCE = [
  { label: "Mon", value: 3.8 },
  { label: "Tue", value: 2.6 },
  { label: "Wed", value: 2.4 },
  { label: "Thu", value: 2.5 },
  { label: "Fri", value: 3.4 },
];

export const LEAVE_DECISIONS = [
  { label: "Approved", value: "91%" },
  { label: "Avg. decision time", value: "1.6 d" },
  { label: "Rejected", value: "6%" },
  { label: "Cancelled", value: "3%" },
];

// ───────────── performance (mirrors the KRAs & Performance samples) ─────────────

export const SCORE_TREND = [3.2, 3.5, 3.7, 3.9, 4.0, 4.1, 4.2];

export const RATING_DISTRIBUTION = [
  { label: "1", value: 3, color: COLORS.red },
  { label: "2", value: 9, color: COLORS.amber },
  { label: "3", value: 34, color: COLORS.olive },
  { label: "4", value: 58, color: COLORS.green },
  { label: "5", value: 22, color: COLORS.permanent },
];

export const KRA_STATUS = [
  { label: "Completed", value: 75, color: COLORS.green },
  { label: "On track", value: 20, color: COLORS.olive },
  { label: "At risk", value: 15, color: COLORS.amber },
  { label: "Overdue", value: 16, color: COLORS.red },
];

export const ORG_AVG_SCORE = 4.2;
export const ORG_AVG_ATTENDANCE = 93.3;

/** Performance × attendance scatter: label side and vertical nudge keep labels apart. */
export const PERF_VS_ATTENDANCE: { label: string; attendance: number; score: number; anchor: "start" | "end"; dy: number }[] = [
  { label: "Tech & MIS", attendance: 96.4, score: 4.5, anchor: "end", dy: 0 },
  { label: "Finance", attendance: 95.8, score: 4.3, anchor: "end", dy: -9 },
  { label: "Animal Health", attendance: 93.5, score: 4.3, anchor: "end", dy: -9 },
  { label: "PMO", attendance: 95.1, score: 4.2, anchor: "end", dy: -9 },
  { label: "Infra", attendance: 93.9, score: 4.0, anchor: "start", dy: 0 },
  { label: "Livestock", attendance: 92.0, score: 4.1, anchor: "start", dy: -9 },
  { label: "Field Ops", attendance: 91.2, score: 4.1, anchor: "start", dy: 11 },
  { label: "HR & Admin", attendance: 96.0, score: 4.2, anchor: "end", dy: 12 },
];

// ───────────── learning & compliance (mirrors the Policies & Compliance samples) ─────────────

export const COMPLIANCE_TREND = [
  { label: "Policy acknowledgement", values: [84, 86, 87, 89, 90, 91, 92], color: COLORS.green },
  { label: "Mandatory training", values: [72, 74, 77, 80, 82, 85, 88], color: COLORS.blue },
  { label: "Mandatory documents", values: [90, 91, 93, 94, 95, 95, 96], color: COLORS.amber },
];

export const OVERALL_COMPLIANCE = [
  { label: "Compliant", value: 114, color: COLORS.green },
  { label: "Pending", value: 8, color: COLORS.amber },
  { label: "Overdue", value: 4, color: COLORS.red },
];

export const DEPT_COMPLIANCE = [
  { department: "Field Ops", policy: 90, training: 88, documents: 92, overall: 86 },
  { department: "Livestock", policy: 92, training: 89, documents: 94, overall: 88 },
  { department: "Animal Health", policy: 93, training: 93, documents: 100, overall: 91 },
  { department: "Finance", policy: 78, training: 83, documents: 100, overall: 78 },
  { department: "Infra", policy: 90, training: 89, documents: 100, overall: 89 },
  { department: "Tech & MIS", policy: 100, training: 94, documents: 100, overall: 94 },
  { department: "PMO", policy: 100, training: 92, documents: 100, overall: 92 },
  { department: "HR & Admin", policy: 100, training: 100, documents: 100, overall: 100 },
];

export const COURSE_CATEGORIES = [
  { label: "Induction", value: 100 },
  { label: "Safety", value: 88 },
  { label: "Compliance", value: 86 },
  { label: "Functional", value: 84 },
  { label: "Leadership", value: 46 },
  { label: "Operations", value: 0 },
];

export const DUE_SOON = [
  { who: "15 employees", what: "POSH refresher (20 Nov)" },
  { who: "10 employees", what: "Code of Conduct v2.0 acknowledgement" },
  { who: "4 employees", what: "Information Security (overdue)" },
];

// ───────────── CSV export (one section per panel) ─────────────

export type AnTabKey = "overview" | "workforce" | "hiring" | "attendance" | "performance" | "compliance";

type Section = { title: string; columns: string[]; rows: (string | number)[][] };

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const monthly = (title: string, series: Record<string, number[]>): Section => ({
  title,
  columns: ["Month", ...Object.keys(series)],
  rows: MONTHS.map((m, i) => [m, ...Object.values(series).map((v) => v[i])]),
});

function sections(tab: AnTabKey): Section[] {
  const deptSnapshot: Section = {
    title: "Department snapshot",
    columns: ["Department", "Headcount", "Change FYTD", "Attendance %", "Avg. KRA score", "Compliance %", "Attrition % (12 mo)"],
    rows: DEPARTMENTS.map((d) => [d.name, d.headcount, d.change, d.attendance, d.kraScore, d.compliance, d.attrition]),
  };
  switch (tab) {
    case "overview":
      return [
        monthly("Headcount trend", { Joiners: JOINERS, Exits: EXITS, "Month-end headcount": HEADCOUNT }),
        { title: "Workforce mix", columns: ["Employment type", "Employees"], rows: TYPE_MIX.map((t) => [t.label, t.value]) },
        deptSnapshot,
      ];
    case "workforce":
      return [
        {
          title: "Headcount by department",
          columns: ["Department", "Permanent", "Intern", "Contract", "Total"],
          rows: DEPARTMENTS.map((d) => [d.name, d.permanent, d.intern, d.contract, d.headcount]),
        },
        { title: "Tenure distribution", columns: ["Tenure", "Employees"], rows: TENURE.map((t) => [t.label, t.value]) },
        { title: "By location", columns: ["Location", "Employees"], rows: LOCATIONS.map((t) => [t.label, t.value]) },
        {
          title: "By gender",
          columns: ["Gender", "Employees"],
          rows: GENDER.map((g) => [g.label, g.value < THRESHOLDS.minGroup ? "< 5" : g.value]),
        },
        {
          title: "Attrition by department (rolling 12 months)",
          columns: ["Department", "Headcount", "Exits", "Attrition %"],
          rows: DEPARTMENTS.map((d) => [d.name, d.headcount, d.headcount < THRESHOLDS.minGroup ? "< 5" : d.exits, d.attrition]),
        },
        { title: "Exits by tenure at exit", columns: ["Tenure", "Exits"], rows: EXITS_BY_TENURE.map((t) => [t.label, t.value]) },
      ];
    case "hiring":
      return [
        { title: "Hiring funnel", columns: ["Step", "Count"], rows: FUNNEL.map((f) => [f.label, f.value]) },
        { title: "Offer outcomes", columns: ["Outcome", "Offers"], rows: OFFER_OUTCOMES.map((o) => [o.label, o.value]) },
        {
          title: "Joiners by month",
          columns: ["Month", "Permanent", "Intern", "Contract"],
          rows: MONTHS.map((m, i) => [m, ...JOINERS_BY_TYPE[i]]),
        },
        {
          title: "Onboarding progress",
          columns: ["Employee", "Type · Department", "Checklist %", "Overdue tasks", "Missing documents"],
          rows: ONBOARDING.map((o) => [o.name, o.role, o.progress, o.overdue, o.missingDocs]),
        },
        { title: "Documents & letters health", columns: ["Measure", "Value", "Note"], rows: DOC_HEALTH.map((d) => [d.label, d.value, d.note]) },
      ];
    case "attendance":
      return [
        monthly("Attendance rate %", { "Attendance rate": ATTENDANCE }),
        { title: "Leave by type (days)", columns: ["Leave type", "Days"], rows: LEAVE_BY_TYPE.map((l) => [l.label, l.value]) },
        {
          title: "Absence heatmap (% of working days)",
          columns: ["Department", ...MONTHS],
          rows: ABSENCE_HEATMAP.map((r) => [r.department, ...r.values]),
        },
        { title: "Absence by weekday %", columns: ["Weekday", "Absence %"], rows: WEEKDAY_ABSENCE.map((w) => [w.label, w.value]) },
        { title: "Leave approvals", columns: ["Measure", "Value"], rows: LEAVE_DECISIONS.map((l) => [l.label, l.value]) },
      ];
    case "performance":
      return [
        monthly("Performance trend", { "Average score": SCORE_TREND }),
        { title: "Rating distribution", columns: ["Rating", "Employees"], rows: RATING_DISTRIBUTION.map((r) => [r.label, r.value]) },
        { title: "Score by department", columns: ["Department", "Avg. score", "Attendance %"], rows: DEPARTMENTS.map((d) => [d.name, d.kraScore, d.attendance]) },
        { title: "KRA status", columns: ["Status", "KRAs"], rows: KRA_STATUS.map((k) => [k.label, k.value]) },
      ];
    case "compliance":
      return [
        monthly("Compliance trend %", Object.fromEntries(COMPLIANCE_TREND.map((s) => [s.label, s.values]))),
        { title: "Overall compliance", columns: ["Status", "Employees"], rows: OVERALL_COMPLIANCE.map((o) => [o.label, o.value]) },
        {
          title: "Compliance by department %",
          columns: ["Department", "Policy acknowledgement", "Mandatory training", "Documents", "Fully compliant"],
          rows: DEPT_COMPLIANCE.map((d) => [d.department, d.policy, d.training, d.documents, d.overall]),
        },
        { title: "Course completion by category %", columns: ["Category", "Completion %"], rows: COURSE_CATEGORIES.map((c) => [c.label, c.value]) },
      ];
  }
}

/** CSV of every panel on a tab, one titled block per panel. */
export function analyticsCsv(tab: AnTabKey): string {
  const lines = ["HR Analytics (sample data) · Manikstu Agro · FY 2026 – 27", ""];
  for (const s of sections(tab)) {
    lines.push(cell(s.title), s.columns.map(cell).join(","), ...s.rows.map((r) => r.map(cell).join(",")), "");
  }
  return lines.join("\n");
}
