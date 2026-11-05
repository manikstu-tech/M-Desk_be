// ── KRAs & Goals, reviews and promotion: sample data ──
// There is no KRA or review store yet; every figure here is illustrative. Promotions themselves are real
// (they go through the existing move API); only the review that suggests them is sample.

export const DAY = 24 * 60 * 60 * 1000;

export function fmtDay(d: Date | string) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** E2 → E3; anything without a trailing number has no automatic next grade. */
export function nextGrade(grade: string | null): string {
  const m = /^([A-Za-z]*)(\d+)$/.exec(grade ?? "");
  return m ? `${m[1]}${Number(m[2]) + 1}` : "next grade";
}

export type Rating = "Outstanding" | "Good" | "Meets" | "Needs support";
export function ratingFor(score: number): Rating {
  if (score >= 90) return "Outstanding";
  if (score >= 75) return "Good";
  if (score >= 60) return "Meets";
  return "Needs support";
}
export const RATING_TONE: Record<Rating, string> = {
  Outstanding: "bg-green-100 text-green-700",
  Good: "bg-blue-100 text-blue-700",
  Meets: "bg-amber-100 text-amber-800",
  "Needs support": "bg-red-100 text-red-700",
};

// The half-year a day falls in (financial year April to March).
export function halfYearOf(isoDay: string): { from: string; to: string; label: string } {
  const d = new Date(`${isoDay}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0 = Jan
  if (m >= 3 && m <= 8) return { from: `${y}-04-01`, to: `${y}-09-30`, label: `Apr to Sep ${y}` };
  const start = m >= 9 ? y : y - 1;
  return { from: `${start}-10-01`, to: `${start + 1}-03-31`, label: `Oct ${start} to Mar ${start + 1}` };
}

// ── The five promotion checks (all must pass; the score never promotes by itself) ──

export type Check = { title: string; sub: string; ok: boolean };

export function promotionChecks({ grade, joiningDate, today }: { grade: string | null; joiningDate: string; today: string }): Check[] {
  const now = new Date(`${today}T00:00:00Z`).getTime();
  const joined = new Date(joiningDate);
  const monthsInGrade = Math.max(0, Math.floor((now - joined.getTime()) / (30.44 * DAY)));
  return [
    { title: "At least 12 months in grade", sub: `${monthsInGrade} months in ${grade ?? "current grade"} (since ${fmtDay(joined)})`, ok: monthsInGrade >= 12 },
    { title: "Last yearly score 80 or more", sub: "83 for 2025-26", ok: true },
    { title: "Last two half-year scores 75 or more", sub: "86 and 89", ok: true },
    { title: "No open warning", sub: "None on record", ok: true },
    { title: "Required learning done", sub: "3 of 3 courses in the Learning tab", ok: true },
  ];
}

// ── The half-yearly review waiting for Admin or HR ──

export const REVIEW = {
  title: "Half-yearly review",
  period: "Apr to Sep 2026",
  due: "10 Nov 2026",
  selfSent: "20 Oct",
  lastYearly: 83,
  lastHalves: [86, 89] as const,
};

export const REVIEW_GOALS = [
  { goal: "Fix tickets within the time limit", weight: 25, done: 19, of: 20 },
  { goal: "Deliver planned features", weight: 25, done: 7, of: 8 },
  { goal: "Close data corrections", weight: 20, done: 9, of: 10 },
  { goal: "Backup and security tasks", weight: 15, done: 4, of: 4 },
  { goal: "Update runbooks", weight: 15, done: 5, of: 6 },
];

const goalsAchieved = REVIEW_GOALS.reduce((n, g) => n + (g.weight / 100) * (g.done / g.of), 0); // 0..1

export const SCORE_PARTS = [
  { part: "Goals achieved", weight: 65, points: Math.round(goalsAchieved * 65 * 10) / 10, why: `Weighted from the ${REVIEW_GOALS.length} goals below` },
  { part: "Quality", weight: 15, points: 12.5, why: "Little rework. 2 corrected entries" },
  { part: "Delivered on time", weight: 10, points: 8.0, why: "80% of work finished by its due date" },
  { part: "Attendance and discipline", weight: 10, points: 9.2, why: "92% present, no late warnings" },
];
export const SCORE_TOTAL = Math.round(SCORE_PARTS.reduce((n, p) => n + p.points, 0) * 10) / 10;
export const SCORE = Math.round(SCORE_TOTAL);

// ── The yearly review: the average of both half-years ──

// Oct to Mar is still running: work so far against what has been assigned so far.
export const HALF2_GOALS = [
  { goal: "Fix tickets within the time limit", weight: 25, done: 3, of: 6 },
  { goal: "Deliver planned features", weight: 25, done: 1, of: 3 },
  { goal: "Close data corrections", weight: 20, done: 1, of: 3 },
  { goal: "Backup and security tasks", weight: 15, done: 1, of: 1 },
  { goal: "Update runbooks", weight: 15, done: 0, of: 1 },
];

export const YEARLY = {
  fy: "2026-27",
  opens: "11 May 2027",
  due: "20 May 2027",
  half2: { period: "Oct 2026 to Mar 2027", due: "10 May 2027" },
  last: { fy: "2025-26", halves: [80, 86] as const, score: 83, closed: "12 Apr 2026" },
};

export const REVIEW_CALENDAR = [
  { review: "Probation", period: "6 months from joining", opens: "2 weeks before the end", due: "On the last day", who: "Admin, HR" },
  { review: "Half-yearly", period: "Apr to Sep", opens: "7 Oct", due: "10 Nov", who: "Employee, Admin, HR" },
  { review: "Half-yearly", period: "Oct to Mar", opens: "7 Apr 2027", due: "10 May 2027", who: "Employee, Admin, HR" },
  { review: "Yearly", period: "Apr to Mar", opens: "11 May 2027", due: "20 May 2027", who: "Admin, HR" },
];

export const SELF_REVIEW =
  "I closed most tickets inside the time limit and moved the camera status page to production. The offline map slipped because the field testing was delayed.";
export const ADMIN_NOTE = {
  by: "Super Admin",
  on: "28 Oct",
  text: "Reliable on tickets and backups. Needs to plan feature work earlier. Ready to guide a junior.",
  strong: "Fixing faults, clear notes",
  grow: "Planning, estimates",
};

export const DEPT_COMPARE = { people: 6, average: 79, highest: 91, position: 2 };

// ── Goal templates for Assign goals ──

export const COUNTED_FROM = [
  "Service Desk tickets",
  "Backlog and Boards",
  "MIS data corrections",
  "Changes and backup log",
  "Documents",
  "Code reviews",
  "Learning",
  "Shed visit log",
  "Stage photos",
  "Reports",
  "Inspections",
  "Work orders",
  "Attendance",
  "Call log",
  "Complaints",
  "CRM leads",
] as const;

export const VISIBLE_TO = ["Employee, Admin, HR", "Admin, HR"] as const;

export type GoalRow = { goal: string; weight: number; target: string; from: string; visible: string };
export type GoalTemplate = { key: string; title: string; grade?: string; sub: string; goals: GoalRow[] };

const g = (goal: string, weight: number, target: string, from: string): GoalRow => ({ goal, weight, target, from, visible: VISIBLE_TO[0] });

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    key: "se-e2",
    title: "Software Engineer",
    grade: "E2",
    sub: "5 goals, weights total 100%",
    goals: [
      g("Fix tickets within the time limit", 25, "90% on time", "Service Desk tickets"),
      g("Deliver planned features", 25, "8 delivered", "Backlog and Boards"),
      g("Close data corrections", 20, "90% in 5 days", "MIS data corrections"),
      g("Backup and security tasks", 15, "Every restore test passed", "Changes and backup log"),
      g("Update runbooks", 15, "6 updated", "Documents"),
    ],
  },
  {
    key: "sse-e3",
    title: "Senior Software Engineer",
    grade: "E3",
    sub: "6 goals, includes mentoring",
    goals: [
      g("Fix tickets within the time limit", 20, "95% on time", "Service Desk tickets"),
      g("Deliver planned features", 25, "10 delivered", "Backlog and Boards"),
      g("Review teammates' changes", 15, "Every change reviewed in 2 days", "Code reviews"),
      g("Close data corrections", 10, "95% in 5 days", "MIS data corrections"),
      g("Backup and security tasks", 15, "Every restore test passed", "Changes and backup log"),
      g("Mentor a junior", 15, "2 courses finished by the junior", "Learning"),
    ],
  },
  {
    key: "supervisor",
    title: "Supervisor",
    sub: "Shed visits, stage photos, reports",
    goals: [
      g("Visit every assigned shed", 35, "4 visits a month each", "Shed visit log"),
      g("Upload stage photos", 25, "95% accepted first time", "Stage photos"),
      g("Send weekly reports", 20, "Every Monday", "Reports"),
      g("Close shed issues", 20, "90% in 3 days", "Service Desk tickets"),
    ],
  },
  {
    key: "site-engineer",
    title: "Site Engineer",
    sub: "Inspections, work order checks",
    goals: [
      g("Complete site inspections", 40, "All planned inspections", "Inspections"),
      g("Check work orders", 35, "90% checked in 2 days", "Work orders"),
      g("Send inspection reports", 25, "Within 1 day of the visit", "Reports"),
    ],
  },
  {
    key: "fabricator",
    title: "Fabricator",
    sub: "Work orders on time, rework",
    goals: [
      g("Finish work orders on time", 50, "90% by the due date", "Work orders"),
      g("Keep rework low", 30, "Under 5% rework", "Work orders"),
      g("Attendance", 20, "95% present", "Attendance"),
    ],
  },
  {
    key: "telecaller",
    title: "Telecaller",
    sub: "Calls, follow-ups, complaints closed",
    goals: [
      g("Make planned calls", 30, "60 calls a day", "Call log"),
      g("Follow up on time", 25, "Every follow-up on its date", "Call log"),
      g("Close complaints", 25, "85% closed in 2 days", "Complaints"),
      g("Convert leads", 20, "8% of leads converted", "CRM leads"),
    ],
  },
];

export function templateFor(title: string, grade: string | null): GoalTemplate | undefined {
  const t = title.toLowerCase();
  return GOAL_TEMPLATES.find((x) => x.title.toLowerCase() === t && (!x.grade || !grade || x.grade === grade)) ?? GOAL_TEMPLATES.find((x) => x.title.toLowerCase() === t);
}

export const GOAL_CHANGES = [
  { title: "Runbooks target 6 to 4", sub: "12 Oct · Reason: release freeze · Approved by Super Admin" },
  { title: "Backup task added", sub: "1 Oct · Added by Super Admin" },
  { title: "Weights set", sub: "1 Oct · Published to the employee" },
];
