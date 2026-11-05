// Technology & MIS catalogue — docs/TECH-MIS-BLUEPRINT-v1.0.md (draft v1.0, 28 Oct 2026).
// Pure data and rules (no DB) so client components and tests can import it.
// Values tagged [D] in the blueprint (SLA targets TM-D2, categories TM-D3, change
// risk classes TM-D7, WIP limits) are the blueprint's recommended starting values
// and stay placeholders until the Tech Head confirms them.

import type { TechItemType, TechPriority } from "@prisma/client";

export const TECH_SLUG = "technology-mis";
export const TECH_BASE = `/departments/${TECH_SLUG}`;
export const PORTAL_BASE = "/it";
export const KEY_PREFIX = "TM";

export type TechNavItem = { slug: string; label: string; scope: string };

// §3 workspace modules this build ships, in the blueprint's order. Modules still
// waiting on a milestone are listed in TECH_ROADMAP instead of the tab strip.
export const TECH_NAV: TechNavItem[] = [
  { slug: "", label: "Command Centre", scope: "KPIs, insight cards, SLA health, today's risks and team load" },
  { slug: "queue", label: "My Queue", scope: "Work the Super Admin assigned to me, breaching soon first; the Super Admin assigns from here" },
  { slug: "service-desk", label: "Service Desk", scope: "All incidents and service requests: list, filters, SLA timers, CSAT" },
  { slug: "boards", label: "Boards", scope: "Kanban per lane with WIP limits and SLA chips" },
  { slug: "backlog", label: "Backlog", scope: "Bugs, features, stories and epics for the APP and MIS lanes" },
  { slug: "changes", label: "Changes", scope: "Change requests, approvals by risk class and the change calendar" },
  { slug: "mis", label: "MIS & Data", scope: "Ad-hoc MIS requests and data-quality issues" },
  { slug: "security", label: "Security", scope: "Security incidents (L4), phishing reports and policy exceptions" },
  { slug: "assets", label: "Assets", scope: "IT asset register with an append-only custody chain and warranty dates" },
  { slug: "licences", label: "Licences", scope: "Seats bought vs assigned, cost per month and renewal dates" },
  { slug: "documents", label: "Documents", scope: "SOPs, runbooks, policies, vendor contracts and files attached to work items" },
  { slug: "workflows", label: "Workflows", scope: "WF-TM-01…14 with steps, controls and decision points" },
  { slug: "reports", label: "Reports", scope: "Standard reports and confidentiality-filtered CSV exports" },
  { slug: "settings", label: "Settings", scope: "SLA policies, priority matrix, lanes, categories and automation rules" },
];

export const TECH_ROADMAP: { module: string; milestone: string; note: string }[] = [
  { module: "Access & Identity", milestone: "T2", note: "Runs on the it_access approval chain; needs the access catalogue (TM-D5)" },
  { module: "Sprints, roadmap & knowledge base", milestone: "T5", note: "Backlog list ships now; sprint planning, burndown and KB come next" },
  { module: "Vendors & AMCs", milestone: "T4", note: "Vendor contracts and AMC terms" },
  { module: "Infra health, integrations & data-quality rules", milestone: "T6", note: "Needs the monitoring tool choice (TM-D12)" },
  { module: "MIS report catalogue (recurring items)", milestone: "T5", note: "Needs the MIS report list and owners (TM-D10)" },
];

// Document library categories (TechDocument.category). Files uploaded from the
// main Documents page with no Tech row show as GENERAL.
export const TECH_DOC_CATEGORIES = {
  SOP: "SOP / runbook",
  POLICY: "Policy",
  ARCHITECTURE: "Architecture & design",
  CONTRACT: "Vendor contract / AMC",
  PURCHASE: "Quotation / invoice",
  REPORT: "MIS report",
  EVIDENCE: "Evidence / screenshot",
  OTHER: "Other",
} as const;

export type TechDocCategory = keyof typeof TECH_DOC_CATEGORIES;

export function techDocCategoryLabel(category: string | null | undefined): string {
  return category && category in TECH_DOC_CATEGORIES ? TECH_DOC_CATEGORIES[category as TechDocCategory] : "General";
}

export function techHref(slug: string): string {
  return slug ? `${TECH_BASE}/${slug}` : TECH_BASE;
}

export function itemHref(key: string): string {
  return `${TECH_BASE}/items/${key}`;
}

export function portalHref(key?: string): string {
  return key ? `${PORTAL_BASE}/${key}` : PORTAL_BASE;
}

// ───────────── lanes (§1.1) ─────────────

export const LANES = {
  SD: { label: "Service Desk", covers: "Helpdesk tickets, how-to questions, device problems, first-line triage" },
  IAM: { label: "Identity & Access", covers: "M365 / Entra ID accounts, groups, MFA, joiner–mover–leaver, access reviews" },
  INF: { label: "Infrastructure & Cloud", covers: "Network, Wi-Fi, servers, hosting, backups, domains, DNS, email deliverability" },
  APP: { label: "Applications & Development", covers: "M-DESK, AjahFi, website, internal tools: bugs, features, releases" },
  MIS: { label: "MIS & Reporting", covers: "Scheduled MIS reports, Power BI, KPI register, ad-hoc data requests" },
  DATA: { label: "Data Quality & Integrations", covers: "Feeds from ERP / accounting / AjahFi, data-quality rules, master data" },
  SEC: { label: "Security & Compliance", covers: "Incidents, vulnerabilities, phishing, policy, audit evidence, DLP" },
  PROC: { label: "IT Procurement & Vendors", covers: "Hardware/software purchases, AMCs, vendor contracts, licence renewals" },
} as const;

export type Lane = keyof typeof LANES;
export const LANE_CODES = Object.keys(LANES) as Lane[];

export function isLane(v: string): v is Lane {
  return v in LANES;
}

// ───────────── item types (§4.1) and their workflows (§4.5) ─────────────

export type FlowKey = "SERVICE" | "DEV" | "CHANGE" | "SECURITY" | "ACCESS";

export type TypeMeta = {
  label: string;
  short: string;
  lane: Lane;
  confidentiality: "L2" | "L3" | "L4";
  flow: FlowKey;
  /** Anyone in the organisation may raise it from the service portal. */
  portal: boolean;
  /** False while the milestone that owns it is not built (access → T2). */
  creatable: boolean;
};

export const TYPE_META: Record<TechItemType, TypeMeta> = {
  INCIDENT: { label: "Incident", short: "INC", lane: "SD", confidentiality: "L2", flow: "SERVICE", portal: true, creatable: true },
  SERVICE_REQUEST: { label: "Service request", short: "REQ", lane: "SD", confidentiality: "L2", flow: "SERVICE", portal: true, creatable: true },
  ACCESS_REQUEST: { label: "Access request", short: "ACC", lane: "IAM", confidentiality: "L3", flow: "ACCESS", portal: false, creatable: false },
  CHANGE: { label: "Change", short: "CHG", lane: "INF", confidentiality: "L2", flow: "CHANGE", portal: false, creatable: true },
  PROBLEM: { label: "Problem", short: "PRB", lane: "INF", confidentiality: "L2", flow: "SERVICE", portal: false, creatable: true },
  BUG: { label: "Bug", short: "BUG", lane: "APP", confidentiality: "L2", flow: "DEV", portal: false, creatable: true },
  FEATURE: { label: "Feature", short: "FEA", lane: "APP", confidentiality: "L2", flow: "DEV", portal: false, creatable: true },
  STORY: { label: "Story", short: "STY", lane: "APP", confidentiality: "L2", flow: "DEV", portal: false, creatable: true },
  EPIC: { label: "Epic", short: "EPC", lane: "APP", confidentiality: "L2", flow: "DEV", portal: false, creatable: true },
  SUBTASK: { label: "Sub-task", short: "SUB", lane: "APP", confidentiality: "L2", flow: "DEV", portal: false, creatable: true },
  MIS_REQUEST: { label: "MIS / data request", short: "MIS", lane: "MIS", confidentiality: "L3", flow: "SERVICE", portal: true, creatable: true },
  DQ_ISSUE: { label: "Data-quality issue", short: "DQ", lane: "DATA", confidentiality: "L3", flow: "SERVICE", portal: false, creatable: true },
  SECURITY_INCIDENT: { label: "Security incident", short: "SEC", lane: "SEC", confidentiality: "L4", flow: "SECURITY", portal: true, creatable: true },
};

export const ITEM_TYPES = Object.keys(TYPE_META) as TechItemType[];
export const PORTAL_TYPES = ITEM_TYPES.filter((t) => TYPE_META[t].portal && TYPE_META[t].creatable);
export const CREATABLE_TYPES = ITEM_TYPES.filter((t) => TYPE_META[t].creatable);
export const DEV_TYPES: TechItemType[] = ["BUG", "FEATURE", "STORY", "EPIC", "SUBTASK"];

/** SLA policies apply to tickets; dev and change work runs on due dates instead. */
export function hasSla(type: TechItemType): boolean {
  const flow = TYPE_META[type].flow;
  return flow === "SERVICE" || flow === "SECURITY";
}

// Who may perform a transition:
//   AGENT     department staff who work items (ADMIN / MANAGER / OFFICER, or an EDIT grant)
//   LEAD      team lead or head (MANAGER / ADMIN, or an APPROVE grant)
//   HEAD      Tech & MIS Head (ADMIN in technology-mis) or Super Admin
//   REQUESTER the reporter or the person it was raised for
export type ActorKind = "AGENT" | "LEAD" | "HEAD" | "REQUESTER";

// What the transition demands before the server accepts it.
export type Need =
  | "reason" // free-text reason (pause, reject, duplicate, won't do…)
  | "resolution" // resolution code + note (§4.5 guard rail)
  | "outcome" // change review outcome
  | "pir" // post-incident review for P1 incidents (WF-TM-06)
  | "plan" // change plan + rollback plan
  | "reviewer" // reviewer ≠ assignee
  | "approver" // approver ≠ requester; risk class sets the approver level
  | "reopenWindow" // requester reopens within 7 days
  | "p1"; // major-incident mode is P1 only

export type Transition = { to: string; label: string; as: ActorKind[]; needs?: Need[] };

export type Flow = { initial: string; statuses: string[]; terminal: string[]; transitions: Record<string, Transition[]> };

const reject = (to: "REJECTED" | "DUPLICATE"): Transition => ({
  to,
  label: to === "REJECTED" ? "Reject" : "Mark duplicate",
  as: ["AGENT"],
  needs: ["reason"],
});

export const FLOWS: Record<FlowKey, Flow> = {
  SERVICE: {
    initial: "NEW",
    statuses: ["NEW", "TRIAGED", "IN_PROGRESS", "WAITING_ON_REQUESTER", "WAITING_ON_VENDOR", "ESCALATED", "RESOLVED", "REOPENED", "CLOSED", "REJECTED", "DUPLICATE"],
    terminal: ["CLOSED", "REJECTED", "DUPLICATE"],
    transitions: {
      NEW: [
        { to: "TRIAGED", label: "Triage", as: ["AGENT"] },
        { to: "IN_PROGRESS", label: "Start work", as: ["AGENT"] },
        reject("REJECTED"),
        reject("DUPLICATE"),
      ],
      TRIAGED: [{ to: "IN_PROGRESS", label: "Start work", as: ["AGENT"] }, reject("REJECTED"), reject("DUPLICATE")],
      IN_PROGRESS: [
        { to: "WAITING_ON_REQUESTER", label: "Wait on requester", as: ["AGENT"], needs: ["reason"] },
        { to: "WAITING_ON_VENDOR", label: "Wait on vendor", as: ["AGENT"], needs: ["reason"] },
        { to: "ESCALATED", label: "Declare major incident", as: ["AGENT"], needs: ["p1"] },
        { to: "RESOLVED", label: "Resolve", as: ["AGENT"], needs: ["resolution"] },
      ],
      WAITING_ON_REQUESTER: [
        { to: "IN_PROGRESS", label: "Resume", as: ["AGENT"] },
        { to: "RESOLVED", label: "Resolve", as: ["AGENT"], needs: ["resolution"] },
      ],
      WAITING_ON_VENDOR: [
        { to: "IN_PROGRESS", label: "Resume", as: ["AGENT"] },
        { to: "RESOLVED", label: "Resolve", as: ["AGENT"], needs: ["resolution"] },
      ],
      ESCALATED: [
        { to: "IN_PROGRESS", label: "Stand down major incident", as: ["AGENT"] },
        { to: "RESOLVED", label: "Resolve", as: ["AGENT"], needs: ["resolution"] },
      ],
      RESOLVED: [
        { to: "CLOSED", label: "Confirm & close", as: ["REQUESTER", "LEAD"], needs: ["pir"] },
        { to: "REOPENED", label: "Reopen", as: ["REQUESTER"], needs: ["reason", "reopenWindow"] },
      ],
      REOPENED: [{ to: "IN_PROGRESS", label: "Pick up again", as: ["AGENT"] }],
      CLOSED: [],
      REJECTED: [],
      DUPLICATE: [],
    },
  },
  DEV: {
    initial: "BACKLOG",
    statuses: ["BACKLOG", "SELECTED", "IN_PROGRESS", "IN_REVIEW", "QA", "READY_FOR_RELEASE", "DONE", "WONT_DO"],
    terminal: ["DONE", "WONT_DO"],
    transitions: {
      BACKLOG: [
        { to: "SELECTED", label: "Select for sprint", as: ["AGENT"] },
        { to: "IN_PROGRESS", label: "Start work", as: ["AGENT"] },
        { to: "WONT_DO", label: "Won't do", as: ["AGENT"], needs: ["reason"] },
      ],
      SELECTED: [
        { to: "IN_PROGRESS", label: "Start work", as: ["AGENT"] },
        { to: "BACKLOG", label: "Back to backlog", as: ["AGENT"] },
        { to: "WONT_DO", label: "Won't do", as: ["AGENT"], needs: ["reason"] },
      ],
      IN_PROGRESS: [
        { to: "IN_REVIEW", label: "Send for code review", as: ["AGENT"] },
        { to: "WONT_DO", label: "Won't do", as: ["AGENT"], needs: ["reason"] },
      ],
      IN_REVIEW: [
        { to: "QA", label: "Approve review → QA", as: ["AGENT"], needs: ["reviewer"] },
        { to: "IN_PROGRESS", label: "Request changes", as: ["AGENT"], needs: ["reviewer", "reason"] },
      ],
      QA: [
        { to: "READY_FOR_RELEASE", label: "QA passed", as: ["AGENT"] },
        { to: "IN_PROGRESS", label: "QA failed", as: ["AGENT"], needs: ["reason"] },
      ],
      READY_FOR_RELEASE: [{ to: "DONE", label: "Released — done", as: ["AGENT"] }],
      DONE: [],
      WONT_DO: [],
    },
  },
  CHANGE: {
    initial: "DRAFT",
    statuses: ["DRAFT", "SUBMITTED", "RISK_ASSESSED", "APPROVED", "SCHEDULED", "IMPLEMENTING", "IMPLEMENTED", "REVIEWED", "CLOSED", "REJECTED", "CANCELLED"],
    terminal: ["CLOSED", "REJECTED", "CANCELLED"],
    transitions: {
      DRAFT: [
        { to: "SUBMITTED", label: "Submit change", as: ["AGENT", "REQUESTER"], needs: ["plan"] },
        { to: "CANCELLED", label: "Cancel", as: ["AGENT", "REQUESTER"] },
      ],
      SUBMITTED: [
        { to: "RISK_ASSESSED", label: "Risk assessed", as: ["AGENT"] },
        { to: "REJECTED", label: "Reject", as: ["LEAD"], needs: ["reason"] },
        { to: "CANCELLED", label: "Cancel", as: ["AGENT", "REQUESTER"] },
      ],
      RISK_ASSESSED: [
        { to: "APPROVED", label: "Approve change", as: ["AGENT"], needs: ["approver"] },
        { to: "REJECTED", label: "Reject", as: ["LEAD"], needs: ["reason"] },
      ],
      APPROVED: [
        { to: "SCHEDULED", label: "Schedule", as: ["AGENT"] },
        { to: "CANCELLED", label: "Cancel", as: ["AGENT"] },
      ],
      SCHEDULED: [
        { to: "IMPLEMENTING", label: "Start implementation", as: ["AGENT"] },
        { to: "CANCELLED", label: "Cancel", as: ["AGENT"] },
      ],
      IMPLEMENTING: [{ to: "IMPLEMENTED", label: "Mark implemented", as: ["AGENT"] }],
      IMPLEMENTED: [{ to: "REVIEWED", label: "Record post-implementation review", as: ["AGENT"], needs: ["outcome"] }],
      REVIEWED: [{ to: "CLOSED", label: "Close change", as: ["LEAD"] }],
      CLOSED: [],
      REJECTED: [],
      CANCELLED: [],
    },
  },
  SECURITY: {
    initial: "REPORTED",
    statuses: ["REPORTED", "TRIAGED", "CONTAINED", "ERADICATED", "RECOVERED", "LESSONS_LEARNED", "CLOSED", "REJECTED"],
    terminal: ["CLOSED", "REJECTED"],
    transitions: {
      REPORTED: [
        { to: "TRIAGED", label: "Triage", as: ["AGENT"] },
        { to: "REJECTED", label: "Not a security incident", as: ["AGENT"], needs: ["reason"] },
      ],
      TRIAGED: [
        { to: "CONTAINED", label: "Contained", as: ["AGENT"] },
        { to: "REJECTED", label: "Not a security incident", as: ["AGENT"], needs: ["reason"] },
      ],
      CONTAINED: [{ to: "ERADICATED", label: "Eradicated", as: ["AGENT"] }],
      ERADICATED: [{ to: "RECOVERED", label: "Recovered", as: ["AGENT"], needs: ["resolution"] }],
      RECOVERED: [{ to: "LESSONS_LEARNED", label: "Record lessons learned", as: ["AGENT"], needs: ["reason"] }],
      LESSONS_LEARNED: [{ to: "CLOSED", label: "Close", as: ["LEAD"] }],
      CLOSED: [],
      REJECTED: [],
    },
  },
  // T2: access requests mirror the it_access approval chain; no item is created
  // with this flow until that milestone wires the engine in.
  ACCESS: {
    initial: "REQUESTED",
    statuses: ["REQUESTED", "MANAGER_APPROVED", "OWNER_APPROVED", "PROVISIONED", "VERIFIED", "CLOSED", "REJECTED"],
    terminal: ["CLOSED", "REJECTED"],
    transitions: {},
  },
};

export function flowOf(type: TechItemType): Flow {
  return FLOWS[TYPE_META[type].flow];
}

export function transitionFor(type: TechItemType, from: string, to: string): Transition | undefined {
  return flowOf(type).transitions[from]?.find((t) => t.to === to);
}

export function isTerminal(type: TechItemType, status: string): boolean {
  return flowOf(type).terminal.includes(status);
}

export const PAUSE_STATUSES = ["WAITING_ON_REQUESTER", "WAITING_ON_VENDOR"];
// Entering one of these stops the resolution clock (resolvedAt is stamped).
export const RESOLVED_STATUSES = ["RESOLVED", "RECOVERED", "DONE"];

export const ALL_TERMINAL = [...new Set(Object.values(FLOWS).flatMap((f) => f.terminal))];

export function statusLabel(status: string): string {
  const special: Record<string, string> = {
    WAITING_ON_REQUESTER: "Waiting on requester",
    WAITING_ON_VENDOR: "Waiting on vendor",
    QA: "QA",
    WONT_DO: "Won't do",
    ESCALATED: "Major incident",
  };
  if (special[status]) return special[status];
  const s = status.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Board columns (§6.1): status groups shared across types, with WIP limits [D].
export type StatusGroup = "TODO" | "ACTIVE" | "WAITING" | "REVIEW" | "DONE";

export const STATUS_GROUP: Record<string, StatusGroup> = {
  NEW: "TODO",
  TRIAGED: "TODO",
  REOPENED: "TODO",
  BACKLOG: "TODO",
  SELECTED: "TODO",
  DRAFT: "TODO",
  SUBMITTED: "TODO",
  REPORTED: "TODO",
  RISK_ASSESSED: "REVIEW",
  IN_PROGRESS: "ACTIVE",
  ESCALATED: "ACTIVE",
  APPROVED: "ACTIVE",
  SCHEDULED: "ACTIVE",
  IMPLEMENTING: "ACTIVE",
  CONTAINED: "ACTIVE",
  ERADICATED: "ACTIVE",
  WAITING_ON_REQUESTER: "WAITING",
  WAITING_ON_VENDOR: "WAITING",
  IN_REVIEW: "REVIEW",
  QA: "REVIEW",
  IMPLEMENTED: "REVIEW",
  LESSONS_LEARNED: "REVIEW",
  RESOLVED: "DONE",
  RECOVERED: "DONE",
  READY_FOR_RELEASE: "DONE",
  REVIEWED: "DONE",
};

export const BOARD_COLUMNS: { group: StatusGroup; label: string; wip: number | null }[] = [
  { group: "TODO", label: "To do", wip: null },
  { group: "ACTIVE", label: "In progress", wip: 12 },
  { group: "WAITING", label: "Waiting", wip: 8 },
  { group: "REVIEW", label: "Review & approval", wip: 6 },
  { group: "DONE", label: "Resolved / ready", wip: null },
];

/** Amber at the WIP limit, red over it (§6.1). */
export function wipTone(count: number, wip: number | null): "ok" | "amber" | "red" {
  if (wip === null) return "ok";
  if (count > wip) return "red";
  if (count === wip) return "amber";
  return "ok";
}

// ───────────── priority and SLA (§4.4) ─────────────

export const IMPACTS = {
  ORG: "Org-wide / many users / money or data at risk",
  TEAM: "One team / one site",
  USER: "One user",
} as const;
export const URGENCIES = {
  HIGH: "High — work stopped",
  MEDIUM: "Medium — degraded",
  LOW: "Low — can wait",
} as const;
export type Impact = keyof typeof IMPACTS;
export type Urgency = keyof typeof URGENCIES;

export const PRIORITY_MATRIX: Record<Impact, Record<Urgency, TechPriority>> = {
  ORG: { HIGH: "P1", MEDIUM: "P2", LOW: "P3" },
  TEAM: { HIGH: "P2", MEDIUM: "P3", LOW: "P3" },
  USER: { HIGH: "P3", MEDIUM: "P3", LOW: "P4" },
};

export function priorityFor(impact: Impact = "USER", urgency: Urgency = "MEDIUM"): TechPriority {
  return PRIORITY_MATRIX[impact][urgency];
}

export const PRIORITIES: TechPriority[] = ["P1", "P2", "P3", "P4"];

type Span = { minutes: number } | { workdays: number };

export type SlaPolicy = {
  label: string;
  response: Span;
  resolve: Span;
  responseText: string;
  resolveText: string;
  cadence: string;
  hours: string;
  escalation: string;
};

// Placeholder targets until TM-D2 (SLA targets and business hours) is decided.
export const SLA_POLICY: Record<TechPriority, SlaPolicy> = {
  P1: { label: "P1 Critical", response: { minutes: 15 }, resolve: { minutes: 240 }, responseText: "15 min", resolveText: "4 h", cadence: "Every 30 min", hours: "24×7", escalation: "Tech Head + MD notified" },
  P2: { label: "P2 High", response: { minutes: 60 }, resolve: { workdays: 1 }, responseText: "1 h", resolveText: "1 working day", cadence: "Every 4 h", hours: "Business hours", escalation: "Tech Head" },
  P3: { label: "P3 Medium", response: { minutes: 240 }, resolve: { workdays: 3 }, responseText: "4 h", resolveText: "3 working days", cadence: "Daily", hours: "Business hours", escalation: "Team lead" },
  P4: { label: "P4 Low", response: { workdays: 1 }, resolve: { workdays: 7 }, responseText: "1 working day", resolveText: "7 working days", cadence: "On change", hours: "Business hours", escalation: "Team lead" },
};

/** Mon–Fri working days, same rule as the approvals engine (holidays join with WF-HR-07). */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  while (days > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) days--;
  }
  return d;
}

function addSpan(from: Date, span: Span): Date {
  return "minutes" in span ? new Date(from.getTime() + span.minutes * 60_000) : addWorkingDays(from, span.workdays);
}

export function slaTargets(priority: TechPriority, from: Date): { responseDueAt: Date; resolveDueAt: Date } {
  const p = SLA_POLICY[priority];
  return { responseDueAt: addSpan(from, p.response), resolveDueAt: addSpan(from, p.resolve) };
}

export type SlaState = "none" | "met" | "missed" | "paused" | "breached" | "at_risk" | "ok";

export type SlaItem = {
  createdAt: Date;
  resolveDueAt: Date | null;
  resolvedAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedMs: number;
};

/** Share of the resolution window used, excluding paused time (0..∞). */
export function slaUsed(item: SlaItem, now: Date): number | null {
  if (!item.resolveDueAt) return null;
  const window = item.resolveDueAt.getTime() - item.createdAt.getTime() - item.slaPausedMs;
  if (window <= 0) return 1;
  const pausedNow = item.slaPausedAt ? now.getTime() - item.slaPausedAt.getTime() : 0;
  const end = item.resolvedAt ?? now;
  const elapsed = end.getTime() - item.createdAt.getTime() - item.slaPausedMs - pausedNow;
  return Math.max(0, elapsed / window);
}

export function slaState(item: SlaItem, now: Date): SlaState {
  if (!item.resolveDueAt) return "none";
  if (item.resolvedAt) return item.resolvedAt <= item.resolveDueAt ? "met" : "missed";
  if (item.slaPausedAt) return "paused";
  const used = slaUsed(item, now) ?? 0;
  if (used >= 1) return "breached";
  if (used >= 0.75) return "at_risk";
  return "ok";
}

/** "2 h 10 m left" / "3 h over" for SLA chips. */
export function timeLeft(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  const text = mins < 60 ? `${mins} m` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${Math.round(mins / 1440)} d`;
  return ms >= 0 ? `${text} left` : `${text} over`;
}

// ───────────── categories, resolution codes, change risk (samples, [D]) ─────────────

// Category tree v1 — sample until TM-D3 (category tree and service catalogue).
export const CATEGORIES: { name: string; lane: Lane; subs: string[] }[] = [
  { name: "Hardware", lane: "SD", subs: ["Laptop / desktop", "Printer / scanner", "Phone / tablet", "Peripheral"] },
  { name: "Software", lane: "SD", subs: ["Install / update", "Licence", "Error / crash", "How-to"] },
  { name: "Email & M365", lane: "IAM", subs: ["Mailbox", "Teams / SharePoint", "MFA / sign-in", "Password reset"] },
  { name: "Network & Wi-Fi", lane: "INF", subs: ["Office Wi-Fi", "VPN", "Internet outage", "Field connectivity"] },
  { name: "M-DESK", lane: "APP", subs: ["Bug", "Access", "Feature request", "Data correction"] },
  { name: "AjahFi & other apps", lane: "APP", subs: ["Bug", "Access", "Feature request"] },
  { name: "Reports & data", lane: "MIS", subs: ["New report", "Report change", "Data extract", "Dashboard"] },
  { name: "Security", lane: "SEC", subs: ["Phishing", "Lost / stolen device", "Malware", "Data leak", "Policy exception"] },
  { name: "Purchase", lane: "PROC", subs: ["Hardware", "Software", "Subscription renewal"] },
];

export const RESOLUTION_CODES: Record<string, string> = {
  FIXED: "Fixed",
  WORKAROUND: "Workaround provided",
  CONFIGURATION: "Configuration change",
  HARDWARE_REPLACED: "Hardware replaced / repaired",
  USER_GUIDANCE: "User guided / trained",
  FULFILLED: "Request fulfilled",
  VENDOR_FIX: "Fixed by vendor",
  NO_FAULT_FOUND: "No fault found",
};

export const CHANGE_RISK = {
  STANDARD: { label: "Standard (pre-approved)", approver: "AGENT", example: "Password reset, adding a user to a group", leadTime: "–" },
  MINOR: { label: "Minor", approver: "LEAD", example: "Config change, report tweak", leadTime: "1 working day" },
  MAJOR: { label: "Major", approver: "HEAD", example: "DB migration, M-DESK release, firewall rule", leadTime: "3 working days" },
  EMERGENCY: { label: "Emergency", approver: "HEAD", example: "Fix for a live P1", leadTime: "Immediate; retro-approval within 24 h" },
} as const satisfies Record<string, { label: string; approver: ActorKind; example: string; leadTime: string }>;

export type ChangeRisk = keyof typeof CHANGE_RISK;

export const CHANGE_OUTCOMES = {
  SUCCESS: "Successful",
  PARTIAL: "Partially successful",
  ROLLED_BACK: "Rolled back",
} as const;

export type ChangeOutcome = keyof typeof CHANGE_OUTCOMES;

export const LINK_KINDS = {
  blocks: "blocks",
  relates: "relates to",
  duplicates: "duplicates",
  caused_by: "was caused by",
} as const;

export type LinkKind = keyof typeof LINK_KINDS;

export const SOURCES = ["PORTAL", "EMAIL", "PHONE", "WALK_IN", "AUTOMATION", "MONITORING", "HR_TRIGGER"] as const;

export const REOPEN_DAYS = 7;
export const AUTO_CLOSE_WORKDAYS = 3;

// ───────────── registers (§5 WF-TM-08 / 09) ─────────────

export const ASSET_KINDS = ["Laptop", "Desktop", "Phone", "Tablet", "Printer", "Network device", "Server", "Monitor", "Other"];

export const ASSET_STATUS_LABEL: Record<string, string> = {
  IN_STOCK: "In stock",
  IN_USE: "In use",
  REPAIR: "In repair",
  RETIRED: "Retired",
  DISPOSED: "Disposed",
};

// Custody moves; the event is appended and the asset status follows.
export const ASSET_MOVES: Record<string, { kind: string; label: string; to: string; needsUser?: boolean; needsNote?: boolean }[]> = {
  IN_STOCK: [
    { kind: "ISSUE", label: "Issue", to: "IN_USE", needsUser: true },
    { kind: "REPAIR", label: "Send for repair", to: "REPAIR", needsNote: true },
    { kind: "RETIRE", label: "Retire", to: "RETIRED", needsNote: true },
  ],
  IN_USE: [
    { kind: "RETURN", label: "Return", to: "IN_STOCK" },
    { kind: "TRANSFER", label: "Transfer", to: "IN_USE", needsUser: true },
    { kind: "REPAIR", label: "Send for repair", to: "REPAIR", needsNote: true },
  ],
  REPAIR: [{ kind: "RETURN", label: "Back from repair", to: "IN_STOCK" }],
  RETIRED: [{ kind: "DISPOSE", label: "Dispose", to: "DISPOSED", needsNote: true }],
  DISPOSED: [],
};

export function monthlyCost(cost: number, period: string): number {
  return period === "ANNUAL" ? cost / 12 : cost;
}

export const RENEWAL_ALERT_DAYS = [60, 30, 7];

// ───────────── Command Centre tiles (§7.1) ─────────────

export type Rag = "green" | "amber" | "red" | "grey";

export const RAG_RULES = {
  openP1P2: (p1: number, p2: number): Rag => (p1 > 0 ? "red" : p2 > 0 ? "amber" : "green"),
  slaCompliance: (pct: number | null): Rag => (pct === null ? "grey" : pct >= 95 ? "green" : pct >= 85 ? "amber" : "red"),
  breachingSoon: (n: number): Rag => (n === 0 ? "green" : n <= 3 ? "amber" : "red"),
  backlogTrend: (pct: number | null): Rag => (pct === null ? "grey" : pct < 0 ? "green" : pct > 10 ? "red" : "amber"),
  fcr: (pct: number | null): Rag => (pct === null ? "grey" : pct >= 70 ? "green" : pct >= 50 ? "amber" : "red"),
  csat: (avg: number | null): Rag => (avg === null ? "grey" : avg >= 4.3 ? "green" : avg >= 3.8 ? "amber" : "red"),
  approvals: (overdue: number): Rag => (overdue > 0 ? "red" : "green"),
  renewals: (undecidedIn7d: number, in30d: number): Rag => (undecidedIn7d > 0 ? "red" : in30d > 0 ? "amber" : "green"),
};

// ───────────── workflow catalogue (§5) ─────────────

export type TechWorkflow = {
  code: string;
  name: string;
  tags: string;
  wave: string;
  /** What this build ships for it. */
  status: "Live" | "Partial" | "Planned";
  built: string;
  trigger: string;
  steps: { step: string; action: string; control: string }[];
  decisions?: string;
  controls?: string;
};

export const TECH_WORKFLOWS: TechWorkflow[] = [
  {
    code: "WF-TM-01",
    name: "IT helpdesk ticket → resolution",
    tags: "[C][R]",
    wave: "Core ★",
    status: "Live",
    built: "Portal + agent logging, priority matrix, Super Admin dispatch, SLA clock with pauses, resolution code, requester confirm/reopen, CSAT, auto-close.",
    trigger: "Employee raises from the portal, or the agent logs a phone call or walk-in.",
    steps: [
      { step: "Log", action: "Requester picks category; form asks only what that category needs", control: "Mandatory category; duplicate detection on same requester + category within 24 h" },
      { step: "Triage", action: "Super Admin / Tech Head assigns the owner, the part (lane) and instructions from My Queue", control: "First-response SLA clock starts at log time; only they assign work to someone else" },
      { step: "Work", action: "Agent updates, links items, may pause for requester/vendor", control: "Pause needs a reason; every status change audited" },
      { step: "Resolve", action: "Resolution code + note", control: "Cannot resolve without code" },
      { step: "Confirm", action: "Requester confirms or reopens within 7 days; CSAT asked", control: "Auto-close after 3 working days" },
    ],
    decisions: "Categories list, business hours, whether field staff raise by WhatsApp/phone proxy.",
    controls: "Requester sees only their own tickets; internal notes hidden from the requester.",
  },
  {
    code: "WF-TM-02",
    name: "Access request → grant → revocation",
    tags: "[C]",
    wave: "Core ★ · engine key it_access",
    status: "Partial",
    built: "The it_access approval chain is live under Workflows & Approvals; the access catalogue, grants register and revocation items come with T2.",
    trigger: "Joiner, role change or leaver (from HR), or an individual request.",
    steps: [
      { step: "Request", action: "Pick system + access level from the Access Catalogue", control: "Only catalogue items; free-text only via an exception path" },
      { step: "Manager approval", action: "Line manager approves the business need", control: "Existing engine step 1; requester ≠ approver" },
      { step: "Data-owner approval", action: "Owner of the system approves the level", control: "Existing engine step 2 (technology-mis ADMIN)" },
      { step: "Provision", action: "IAM grants in M365/Entra or the target app", control: "Provisioning evidence required" },
      { step: "Verify", action: "Requester confirms access works", control: "Auto-verify after 2 days" },
      { step: "Revoke", action: "On leaver/mover or expiry, revocation item auto-created", control: "Leaver: same day; overdue revocation = red insight card" },
    ],
    decisions: "Access catalogue owners, privileged-access policy, expiry defaults for contractors and guests.",
  },
  {
    code: "WF-TM-03",
    name: "Quarterly access review",
    tags: "[R]",
    wave: "Wave 2",
    status: "Planned",
    built: "Needs the access register from T2.",
    trigger: "Quarterly, per system.",
    steps: [
      { step: "Review", action: "Data owner marks keep / remove / change for everyone with access", control: "Reviewers cannot review their own access" },
      { step: "Act", action: "Removals become WF-TM-02 revocations", control: "Overdue reviews escalate to the Tech Head" },
      { step: "Sign off", action: "Review sign-off stored as audit evidence", control: "Append-only audit" },
    ],
  },
  {
    code: "WF-TM-04",
    name: "Joiner / mover / leaver orchestration",
    tags: "[C]",
    wave: "Core ★",
    status: "Planned",
    built: "T2: HR status change → JML parent item with sub-tasks.",
    trigger: "HR employee status change.",
    steps: [
      { step: "Joiner", action: "Account, mailbox, groups, licence seat, device issue, M-DESK membership, app access", control: "Ready by joining day" },
      { step: "Leaver", action: "Disable sign-in, revoke sessions, transfer files, recover asset, reclaim licence seat", control: "Same day; feeds HR exit clearance" },
      { step: "Close", action: "Parent closes when every sub-task is done", control: "Parent cannot close while any sub-task is open" },
    ],
  },
  {
    code: "WF-TM-05",
    name: "Change request → CAB → release",
    tags: "[C][R]",
    wave: "Wave 2",
    status: "Live",
    built: "Change items with plan, rollback, window and risk class; approval level by risk class (approver ≠ requester); post-implementation review; rolled-back change opens a linked incident.",
    trigger: "Anyone in the department plans a change to a production system.",
    steps: [
      { step: "Draft", action: "Plan, rollback plan, test evidence, window, affected systems", control: "Cannot submit without plan and rollback" },
      { step: "Assess", action: "Risk class: standard / minor / major / emergency", control: "Approval level follows the risk class" },
      { step: "Approve", action: "Standard: none · Minor: team lead · Major/Emergency: Tech Head", control: "Requester never approves own change" },
      { step: "Implement", action: "Scheduled → implementing → implemented", control: "Change calendar shows windows" },
      { step: "Review", action: "Outcome: success / partial / rolled back", control: "Rolled back auto-opens an incident linked as caused by" },
    ],
    decisions: "Risk classes, CAB membership, freeze calendar (TM-D7).",
  },
  {
    code: "WF-TM-06",
    name: "Major incident (P1)",
    tags: "[R]",
    wave: "Wave 2",
    status: "Partial",
    built: "P1 notifies the Tech Head on creation; major-incident status; P1 cannot close without a post-incident review. Status banner comes later.",
    trigger: "Any P1 incident.",
    steps: [
      { step: "Declare", action: "Incident commander assigned; Head notified", control: "P1 only" },
      { step: "Update", action: "Updates every 30 min", control: "SLA cadence" },
      { step: "Review", action: "Post-incident review within 5 working days", control: "P1 cannot close without a PIR" },
    ],
  },
  {
    code: "WF-TM-07",
    name: "Problem management",
    tags: "[R]",
    wave: "Wave 3",
    status: "Partial",
    built: "Problem items exist; the Command Centre flags category spikes and suggests a problem record.",
    trigger: "Three or more incidents with the same category in 14 days.",
    steps: [
      { step: "Suggest", action: "System suggests a Problem", control: "Insight card" },
      { step: "RCA", action: "Root cause analysis", control: "Linked incidents" },
      { step: "Fix", action: "Known-error article, permanent fix via Change", control: "Change workflow" },
    ],
  },
  {
    code: "WF-TM-08",
    name: "IT asset lifecycle",
    tags: "[C]",
    wave: "Wave 2",
    status: "Live",
    built: "Asset register; receive, issue, transfer, return, repair, retire and dispose as append-only custody events.",
    trigger: "Asset received from a purchase.",
    steps: [
      { step: "Receive", action: "Tag (asset ID) and record make, model, serial, warranty", control: "Unique tag" },
      { step: "Issue", action: "Issue to employee", control: "Custody chain is append-only" },
      { step: "Return / repair", action: "Return to stock or send for repair", control: "Every move audited" },
      { step: "Dispose", action: "Retire then dispose with wipe certificate note", control: "Disposal needs a note" },
    ],
    decisions: "Tagging standard, depreciation method, disposal/wipe policy (TM-D8).",
  },
  {
    code: "WF-TM-09",
    name: "Licence & subscription management",
    tags: "[C]",
    wave: "Wave 2",
    status: "Live",
    built: "Licence register with seats, cost and owner; seat assignment; utilisation; renewal alerts at 60/30/7 days in the scan.",
    trigger: "A new subscription is bought.",
    steps: [
      { step: "Register", action: "Vendor, product, seats, cost, term, renewal date, owner", control: "Owner required" },
      { step: "Assign", action: "Seats linked to users", control: "Cannot assign beyond seats bought" },
      { step: "Renew", action: "Alerts at 60 / 30 / 7 days; renew / downsize / cancel using utilisation", control: "Over-DoA renewals route through Finance (TM-D9)" },
    ],
  },
  {
    code: "WF-TM-10",
    name: "MIS report production",
    tags: "[R]",
    wave: "Wave 2",
    status: "Planned",
    built: "T5: needs the MIS report list (TM-D10).",
    trigger: "Each catalogue report generates a recurring item per cycle.",
    steps: [
      { step: "Prepare", action: "Data pull → DQ checks pass → analyst prepares", control: "Failed DQ check carries a visible caveat" },
      { step: "Review", action: "Reviewer checks (≠ preparer)", control: "Late report = breach" },
      { step: "Publish", action: "Publish to audience and acknowledge", control: "Audited" },
    ],
  },
  {
    code: "WF-TM-11",
    name: "Ad-hoc MIS / data request",
    tags: "[R]",
    wave: "Core",
    status: "Live",
    built: "MIS request items from the portal with purpose, period and audience; L3 by default.",
    trigger: "Anyone needs a report, extract or dashboard change.",
    steps: [
      { step: "Request", action: "Purpose, fields, period and audience", control: "L3 by default" },
      { step: "Deliver", action: "Analyst delivers", control: "Exports of L3/L4 data audited" },
      { step: "Confirm", action: "Requester confirms", control: "Same resolve/confirm path as tickets" },
    ],
  },
  {
    code: "WF-TM-12",
    name: "Data-quality issue",
    tags: "[C]",
    wave: "Wave 3",
    status: "Partial",
    built: "DQ issue items can be logged by hand; scheduled DQ rules come with T6.",
    trigger: "A data-quality rule fails.",
    steps: [
      { step: "Flag", action: "DQ item for the data owner with failing row count", control: "M-DESK never writes to systems of record" },
      { step: "Fix", action: "Fix at source, re-run", control: "Close on pass" },
    ],
  },
  {
    code: "WF-TM-13",
    name: "Security incident",
    tags: "[C]",
    wave: "Wave 3 · L4",
    status: "Live",
    built: "Anyone reports from the portal; L4 by default with named access; triage → contain → eradicate → recover → lessons learned.",
    trigger: "Phishing, malware, data leak, lost device.",
    steps: [
      { step: "Report", action: "Anyone reports from the portal", control: "Reporter sees only received / closed" },
      { step: "Triage", action: "SEC triage within 1 h", control: "L4 by default, named access only" },
      { step: "Contain → recover", action: "Contain, eradicate, recover", control: "Every step audited" },
      { step: "Lessons", action: "Lessons learned recorded", control: "Notification obligations are a decision (TM-D11)" },
    ],
  },
  {
    code: "WF-TM-14",
    name: "Software / hardware purchase request",
    tags: "[R]",
    wave: "Wave 2",
    status: "Partial",
    built: "Raise as a service request in the Purchase category; the purchase requisition chain is live under Workflows & Approvals.",
    trigger: "Someone needs software or hardware.",
    steps: [
      { step: "Request", action: "Need + justification", control: "Tech Head checks standards and existing licences" },
      { step: "Requisition", action: "Hand over to purchase requisition (DoA)", control: "Finance tiers" },
      { step: "Receive", action: "Asset or licence record created", control: "Registers" },
    ],
  },
];

// ───────────── automation rules (§8) ─────────────

export const AUTOMATIONS: { code: string; trigger: string; action: string; live: boolean }[] = [
  { code: "A1", trigger: "Item created with no assignee", action: "Wait in My Queue for the Super Admin / Tech Head to assign (who, which part, instructions); they are notified", live: true },
  { code: "A2", trigger: "Item created at P1", action: "Notify Tech Head and leads", live: true },
  { code: "A3", trigger: "SLA 50% / 75% / 100%", action: "Remind assignee / warn lead / escalate Head (idempotent stamps)", live: true },
  { code: "A4", trigger: "Resolved for 3 working days with no reply", action: "Close automatically (P1 waits for its PIR)", live: true },
  { code: "A5", trigger: "Requester comments while waiting on requester", action: "Back to in progress, SLA resumes", live: true },
  { code: "A6", trigger: "HR employee status → joiner / leaver / mover", action: "Create WF-TM-04 parent with sub-tasks", live: false },
  { code: "A7", trigger: "Licence renewal date − 60 / 30 / 7 days", action: "Notify licence owner; at 7 days also Head", live: true },
  { code: "A8", trigger: "Asset warranty − 30 days", action: "Notify the Head", live: false },
  { code: "A9", trigger: "Backup job failed or missing > 26 h", action: "Create P2 incident", live: false },
  { code: "A10", trigger: "Uptime check down > 5 min", action: "Create P1/P2 by service criticality", live: false },
  { code: "A11", trigger: "Integration run failed twice", action: "Create incident, notify data owner", live: false },
  { code: "A12", trigger: "DQ rule fails", action: "Create/update DQ issue for data owner", live: false },
  { code: "A13", trigger: "≥ 3 incidents in the same category in 14 days", action: "Suggest a problem record (insight card)", live: true },
  { code: "A14", trigger: "CSAT ≤ 2", action: "Notify leads; flag the item", live: true },
  { code: "A15", trigger: "Change reviewed as rolled back", action: "Open a linked incident", live: true },
  { code: "A16", trigger: "Item inactive 14 days", action: "Nudge assignee; 30 days → lead", live: false },
];

// ───────────── reports (§9) ─────────────

export const TECH_REPORTS: { name: string; audience: string; frequency: string; contents: string; export?: string }[] = [
  { name: "IT Service Weekly", audience: "Tech Head, team", frequency: "Weekly", contents: "Volumes, SLA, breaches, top categories, CSAT, ageing", export: "types=INCIDENT,SERVICE_REQUEST&days=7" },
  { name: "IT Monthly Management Report", audience: "CEO, MD, COO", frequency: "Monthly", contents: "Uptime, P1 summary + PIRs, SLA trend, projects, spend vs budget, risks", export: "days=30" },
  { name: "Change Log", audience: "Auditor, Tech Head", frequency: "Monthly", contents: "All changes, risk class, approvals, outcomes", export: "types=CHANGE&days=30" },
  { name: "Security Summary (L4)", audience: "MD, Compliance", frequency: "Monthly", contents: "Incidents by type and severity, phishing reports", export: "types=SECURITY_INCIDENT&days=30" },
  { name: "MIS & data requests", audience: "MIS lead, data owners", frequency: "Monthly", contents: "Ad-hoc requests and data-quality issues", export: "types=MIS_REQUEST,DQ_ISSUE&days=30" },
  { name: "Asset Register Extract", audience: "Finance, Auditor", frequency: "Quarterly", contents: "All assets, custodian, location, value, warranty", export: "register=assets" },
  { name: "Licence Utilisation & Spend", audience: "Finance, Head", frequency: "Monthly", contents: "Seats paid vs used, cost, upcoming renewals", export: "register=licences" },
  { name: "Access & JML Report", audience: "HR, Compliance, Auditor", frequency: "Monthly", contents: "Joiners/leavers on time, overdue revocations (T2)" },
  { name: "Quarterly Access Review Evidence", audience: "Auditor", frequency: "Quarterly", contents: "Per system: reviewer, date, decisions (T2)" },
  { name: "MIS Delivery Scorecard", audience: "Leadership", frequency: "Monthly", contents: "Reports due vs on time, DQ caveats (T5)" },
  { name: "Data Quality Scorecard", audience: "Data owners", frequency: "Weekly", contents: "Rule pass rates by domain (T6)" },
  { name: "Team Productivity (not surveillance)", audience: "Head only", frequency: "Monthly", contents: "Throughput and cycle time by lane — never keystroke or location data" },
];

// ───────────── open decisions (§15) ─────────────

export const TECH_DECISIONS: { code: string; decision: string; owner: string; blocks: string }[] = [
  { code: "TM-D1", decision: "Name the Tech & MIS Head (department ADMIN) and lane owners", owner: "MD", blocks: "T0" },
  { code: "TM-D2", decision: "SLA targets and business hours (field locations, 24×7 for P1?)", owner: "Tech Head + COO", blocks: "T1" },
  { code: "TM-D3", decision: "Category tree and service catalogue v1", owner: "Tech Head", blocks: "T1" },
  { code: "TM-D4", decision: "Separate TechItem model vs extend Task — built as a separate model (recommended)", owner: "Tech lead", blocks: "T1" },
  { code: "TM-D5", decision: "Access catalogue: systems, levels, data owners, privileged-access policy", owner: "Tech Head + data owners", blocks: "T2" },
  { code: "TM-D6", decision: "Does M-DESK write to Entra ID or only record manual grants?", owner: "Tech Head + Security", blocks: "T2" },
  { code: "TM-D7", decision: "Change risk classes, CAB membership, freeze calendar", owner: "Tech Head + Finance", blocks: "T4" },
  { code: "TM-D8", decision: "Asset tagging standard, depreciation, disposal/wipe policy", owner: "Finance + Tech", blocks: "T4" },
  { code: "TM-D9", decision: "Licence renewal approval limits (ties to DoA P-06)", owner: "MD + Finance Head", blocks: "T4" },
  { code: "TM-D10", decision: "MIS report list, owners, audiences and due days", owner: "COO + MIS lead", blocks: "T5" },
  { code: "TM-D11", decision: "Security incident notification obligations and timelines", owner: "Legal & Compliance", blocks: "T6" },
  { code: "TM-D12", decision: "Email-to-ticket mailbox and monitoring tool choice", owner: "Tech Head", blocks: "Wave 2–3" },
  { code: "TM-D13", decision: "Retention period for tickets, worklogs and security records", owner: "Compliance", blocks: "T1" },
];
