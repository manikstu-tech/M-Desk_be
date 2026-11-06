import { RoleName, TaskStatus, UserStatus, WfStatus } from "@prisma/client";
import { WF_TERMINAL, amountOf, currentStep, resolveStep } from "./workflows";
import type { WorkflowDefinition, WorkflowInstance } from "@prisma/client";

// B5 Command Centre v1 (blueprint §8): pure aggregations + the Master KPI
// Register. Callers fetch the rows, this module computes; KPIs whose source
// data does not exist yet sit in the register flagged source-pending and are
// NEVER faked (§8 rule [R]).

// ---------------------------------------------------------------------------
// Master KPI Register (§8 "Every KPI enters the register with these fields…")

export type KpiTier = "T1" | "T2" | "T3";
export type KpiArea = "tasks" | "approvals" | "payments" | "people" | "finance" | "projects";
export type KpiRefresh = "daily" | "monthly";
export type KpiAccess = { tiers: KpiTier[]; financeOnly?: boolean };

export type KpiEntry = {
  id: string;
  area: KpiArea;
  label: string;
  definition: string;
  calculation: string;
  /** null ⇒ "source pending" tile until the register/source system exists. */
  source: string | null;
  /** Which wave delivers the missing source; null = not scheduled yet. */
  pendingWave: 2 | 3 | null;
  pendingNote?: string;
  owner: string;
  access: KpiAccess;
  refresh: KpiRefresh;
};

const T1_T2 = (financeOnly?: boolean): KpiAccess => ({ tiers: ["T1", "T2"], ...(financeOnly ? { financeOnly } : {}) });

export const KPI_REGISTER: KpiEntry[] = [
  {
    id: "overdue_tasks",
    area: "tasks",
    label: "Overdue tasks",
    definition: "Tasks past due date, not Completed/Cancelled",
    calculation: "Count by department",
    source: "Task Engine",
    pendingWave: null,
    owner: "Dept heads",
    access: T1_T2(),
    refresh: "daily",
  },
  {
    id: "approval_backlog",
    area: "approvals",
    label: "Approval backlog",
    definition: "Approvals pending beyond SLA",
    calculation: "Count by workflow and approver",
    source: "Approvals Engine",
    pendingWave: null,
    owner: "Process owners",
    access: T1_T2(),
    refresh: "daily",
  },
  {
    id: "payment_backlog",
    area: "payments",
    label: "Payment approval backlog",
    definition: "Payments approved by dept, awaiting Finance/DoA",
    calculation: "Count and ₹ value",
    source: "Approvals Engine (money chains)",
    pendingWave: null,
    owner: "Finance Head",
    access: T1_T2(true),
    refresh: "daily",
  },
  {
    id: "headcount",
    area: "people",
    label: "Headcount",
    definition: "Active employees by department and type",
    calculation: "Count",
    // roles stand in for the payroll/casual split until an employee master exists
    source: "Users + memberships",
    pendingWave: null,
    owner: "HR",
    access: T1_T2(),
    refresh: "monthly",
  },
  // ---- v1=Yes in §8, but their source systems do not exist yet -------------
  {
    id: "active_projects",
    area: "projects",
    label: "Active projects",
    definition: "Projects with status Active in Project Master",
    calculation: "Count",
    source: null,
    pendingWave: 2,
    pendingNote: "Project Master Register arrives with Wave 2 (project initiation)",
    owner: "PMO",
    access: { tiers: ["T1", "T2", "T3"] },
    refresh: "daily",
  },
  {
    id: "projects_on_track",
    area: "projects",
    label: "Projects on track",
    definition: "Active projects with no milestone overdue",
    calculation: "Count and % of active",
    source: null,
    pendingWave: null,
    pendingNote: "Milestone Tracker has no scheduled wave yet",
    owner: "PMO",
    access: { tiers: ["T1", "T2", "T3"] },
    refresh: "daily",
  },
  {
    id: "critical_milestones",
    area: "projects",
    label: "Critical milestones due 30 days",
    definition: "Milestones flagged critical, due within 30 days",
    calculation: "Count, list",
    source: null,
    pendingWave: null,
    pendingNote: "Milestone Tracker has no scheduled wave yet",
    owner: "PMO",
    access: { tiers: ["T1", "T2", "T3"] },
    refresh: "daily",
  },
  {
    id: "pending_decisions",
    area: "finance",
    label: "Pending decisions",
    definition: "Open items in Decision Register / Executive Approval Queue",
    calculation: "Count, oldest age in days",
    source: null,
    pendingWave: 2,
    pendingNote: "Decision Register arrives with Wave 2 registers",
    owner: "CEO office",
    access: { tiers: ["T1"] },
    refresh: "daily",
  },
  {
    id: "contracts_expiring",
    area: "finance",
    label: "Contracts expiring 90 days",
    definition: "Active contracts with end date within 90 days",
    calculation: "Count, list",
    source: null,
    pendingWave: 2,
    pendingNote: "Contract Repository arrives with Wave 2 (contracts)",
    owner: "Legal",
    access: T1_T2(),
    refresh: "daily",
  },
  {
    id: "statutory_deadlines",
    area: "finance",
    label: "Statutory deadlines 30 days",
    definition: "Compliance calendar items due within 30 days, not filed",
    calculation: "Count, list",
    source: null,
    pendingWave: 2,
    pendingNote: "Compliance Calendar arrives with Wave 2 registers",
    owner: "Compliance owner",
    access: T1_T2(),
    refresh: "daily",
  },
];

// ---------------------------------------------------------------------------
// Tasks — overdue by department (§8: past due, not Completed/Cancelled)

export type TaskLite = {
  id: string;
  departmentId: string | null;
  dueAt: Date | null;
  status: TaskStatus;
};
export type DeptLite = { id: string; name: string; slug: string };
export type DeptOverdue = { deptId: string; deptName: string; deptSlug: string; count: number; oldestDueAt: Date | null };

export function overdueTasksByDept(tasks: TaskLite[], depts: DeptLite[], now: Date): DeptOverdue[] {
  const open = tasks.filter(
    (t) => t.dueAt !== null && t.dueAt.getTime() < now.getTime() && t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.CANCELLED,
  );
  const oldest = new Map<string, Date>();
  const counts = new Map<string, number>();
  for (const t of open) {
    if (!t.departmentId) continue; // dept-less tasks cannot be grouped by department
    counts.set(t.departmentId, (counts.get(t.departmentId) ?? 0) + 1);
    const cur = oldest.get(t.departmentId);
    if (!cur || t.dueAt!.getTime() < cur.getTime()) oldest.set(t.departmentId, t.dueAt!);
  }
  return depts
    .filter((d) => (counts.get(d.id) ?? 0) > 0)
    .map((d) => ({ deptId: d.id, deptName: d.name, deptSlug: d.slug, count: counts.get(d.id)!, oldestDueAt: oldest.get(d.id) ?? null }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Approvals — open chains pending beyond SLA, grouped by workflow + approver

const dayMs = 86_400_000;
const ageDays = (from: Date, now: Date): number => Math.floor((now.getTime() - from.getTime()) / dayMs);

// M4 §8: stale-data guard. Live-schedule tiles (asOf === now) never flag stale;
// extract-fed tiles (Wave 2+) pass their last-seen asOf and amber up past a grace
// window (daily→36h, monthly→45d). Grace absorbs normal clock lag without hiding a
// real missed refresh.
export type RefreshGranularity = KpiRefresh;

export function isStale(asOf: Date | null, refresh: RefreshGranularity, now = new Date()): boolean {
  if (!asOf) return true;
  const grace = refresh === "monthly" ? 45 * dayMs : 36 * 3600 * 1000; // 36h daily, 45d monthly
  return now.getTime() - asOf.getTime() > grace;
}

export type WfQueueRow = Pick<WorkflowInstance, "id" | "currentStep" | "amount" | "dueAt" | "status" | "createdAt"> & {
  definition: Pick<WorkflowDefinition, "key" | "name" | "steps">;
};

export type ApprovalBacklogRow = {
  key: string;
  name: string;
  /** Current step name; returned chains show that they wait on the filer. */
  step: string;
  role: RoleName | null;
  dept: string | null;
  count: number;
  oldestDays: number | null;
};

export function approvalBacklog(instances: WfQueueRow[], now: Date): ApprovalBacklogRow[] {
  const groups = new Map<string, ApprovalBacklogRow & { oldestAt: Date }>();
  for (const i of instances) {
    if ((WF_TERMINAL as WfStatus[]).includes(i.status)) continue;
    if (i.dueAt === null || i.dueAt.getTime() >= now.getTime()) continue; // within SLA
    const waitingOnFiler = i.status !== WfStatus.IN_PROGRESS;
    const step = waitingOnFiler ? undefined : currentStep(i);
    const resolved = step ? resolveStep(step, amountOf(i)) : { role: null, dept: null };
    const gk = `${i.definition.key}|${waitingOnFiler ? "revision" : step!.name}|${String(resolved.role)}|${String(resolved.dept)}`;
    const cur = groups.get(gk);
    if (cur) {
      cur.count++;
      if (i.createdAt.getTime() < cur.oldestAt.getTime()) cur.oldestAt = i.createdAt;
    } else {
      groups.set(gk, {
        key: i.definition.key,
        name: i.definition.name,
        step: waitingOnFiler ? "Returned to requester" : step!.name,
        role: resolved.role,
        dept: resolved.dept,
        count: 1,
        oldestAt: i.createdAt,
        oldestDays: null,
      });
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, oldestDays: ageDays(g.oldestAt, now) }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Payments — open money chains and where they wait (§8 Finance Backlog)

/** Money chain definitions (seed-coupled) — §8 payment backlog source. */
export const MONEY_DEFS = ["purchase_requisition", "vendor_invoice"] as const;

/** Finance department slug where Finance/DoA steps wait (seed + P-06). */
export const FINANCE_DEPT = "finance-accounts";

type StageKey = { step: string; role: RoleName | null; dept: string | null };

const stageKey = (s: StageKey): string => `${s.step}|${String(s.role)}|${String(s.dept)}`;

export type PaymentStage = StageKey & { count: number; total: number };
export type PaymentBacklog = {
  /** all open money chains, any stage */
  chains: number;
  totalAmount: number;
  /** chains sitting at a Finance/DoA gate (the Finance Head's queue) */
  awaitingFinance: number;
  awaitingFinanceTotal: number;
  /** open chains past due */
  overdue: number;
  byStage: PaymentStage[];
};

export function paymentBacklog(instances: WfQueueRow[], now: Date): PaymentBacklog {
  const money = instances.filter(
    (i) => (MONEY_DEFS as readonly string[]).includes(i.definition.key) && !(WF_TERMINAL as WfStatus[]).includes(i.status),
  );
  const counts = new Map<string, PaymentStage>();
  let total = 0;
  let overdue = 0;
  for (const i of money) {
    total += amountOf(i) ?? 0;
    if (i.dueAt !== null && i.dueAt.getTime() < now.getTime()) overdue++;
    const waitingOnFiler = i.status !== WfStatus.IN_PROGRESS;
    const step = waitingOnFiler ? undefined : currentStep(i);
    const resolved = step ? resolveStep(step, amountOf(i)) : { role: null, dept: null };
    const s: StageKey = {
      step: waitingOnFiler ? "Returned to requester" : step!.name,
      role: resolved.role,
      dept: resolved.dept,
    };
    const k = stageKey(s);
    const cur = counts.get(k);
    if (cur) {
      cur.count++;
      cur.total += amountOf(i) ?? 0;
    } else {
      counts.set(k, { ...s, count: 1, total: amountOf(i) ?? 0 });
    }
  }
  const byStage = [...counts.values()].sort((a, b) => b.count - a.count);
  const fin = byStage.filter(
    (s) => s.dept === FINANCE_DEPT || s.role === RoleName.SUPER_ADMIN, // MD/DoA gate (P-06 top tier)
  );
  return {
    chains: money.length,
    totalAmount: total,
    awaitingFinance: fin.reduce((n, s) => n + s.count, 0),
    awaitingFinanceTotal: fin.reduce((n, s) => n + s.total, 0),
    overdue,
    byStage,
  };
}

// ---------------------------------------------------------------------------
// People — headcount by department (§8 Employee Master substitute)

export type UserLite = { id: string; status: UserStatus; role: { name: RoleName } };
export type MembershipLite = { userId: string; departmentId: string };
export type DeptHeadcount = { deptId: string; deptName: string; deptSlug: string; total: number; byRole: Record<RoleName, number> };

export function headcountByDept(
  users: UserLite[],
  memberships: MembershipLite[],
  depts: DeptLite[],
): DeptHeadcount[] {
  const active = new Set(users.filter((u) => u.status === UserStatus.ACTIVE).map((u) => u.id));
  const perUser = new Map<string, RoleName>();
  for (const u of users) perUser.set(u.id, u.role.name);
  const rows = new Map<string, DeptHeadcount>();
  for (const m of memberships) {
    if (!active.has(m.userId)) continue;
    const role = perUser.get(m.userId);
    if (!role) continue;
    const cur = rows.get(m.departmentId) ?? { deptId: m.departmentId, deptName: "", deptSlug: "", total: 0, byRole: emptyRoles() };
    cur.total++;
    cur.byRole[role]++;
    rows.set(m.departmentId, cur);
  }
  return depts
    .filter((d) => rows.has(d.id))
    .map((d) => {
      const r = rows.get(d.id)!;
      r.deptName = d.name;
      r.deptSlug = d.slug;
      return r;
    })
    .sort((a, b) => b.total - a.total);
}

const emptyRoles = (): Record<RoleName, number> =>
  Object.fromEntries(Object.values(RoleName).map((r) => [r, 0])) as Record<RoleName, number>;

// ---------------------------------------------------------------------------
// Tier access (M2): T1 = super admin (MD), T2 = admin/manager (dept-head tier),
// T3 = everyone else (documents + open-information tiles only).

const TIER_OF: Partial<Record<RoleName, KpiTier>> = {
  [RoleName.SUPER_ADMIN]: "T1",
  [RoleName.ADMIN]: "T2",
  [RoleName.MANAGER]: "T2",
};

export function tierOf(role: RoleName): KpiTier {
  return TIER_OF[role] ?? "T3";
}

export type KpiViewer = { role: RoleName; financeMember: boolean };

/** Register gate: tier plus the finance-department qualifier. T1 overrides financeOnly (MD/DoA gate). */
export function maySeeKpi(entry: KpiEntry, viewer: KpiViewer): boolean {
  if (!entry.access.tiers.includes(tierOf(viewer.role))) return false;
  if (entry.access.financeOnly) return viewer.role === RoleName.SUPER_ADMIN || viewer.financeMember;
  return true;
}

/** ₹ with Indian digit grouping, whole numbers — the register's money format. */
export function inr(n: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

// ---------------------------------------------------------------------------
// M3 filters (§8 dashboard rule: "Filters on every tab: Department, Period" —
// State/Programme deferred by standing decision). Period narrows rows to those
// raised/due inside the window; department narrows tasks/headcount to the
// department and chains to the gate they wait at. Filtering never grants
// register access — the tier gates run first (maySeeKpi).

export type CcPeriod = "7d" | "30d" | "90d" | "all";

export const CC_PERIODS: { key: CcPeriod; label: string; days: number | null }[] = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

/** Parses a URL value; anything unknown falls back to "all". */
export function ccPeriodKey(value: string | undefined): CcPeriod {
  return CC_PERIODS.find((p) => p.key === value)?.key ?? "all";
}

/** Window start for a period key; null ⇒ all time. */
export function periodStart(key: CcPeriod, now: Date): Date | null {
  const p = CC_PERIODS.find((x) => x.key === key);
  return p && p.days !== null ? new Date(now.getTime() - p.days * dayMs) : null;
}

/** Raw task rows: department match + became overdue inside the window. */
export function ccFilterTasks(tasks: TaskLite[], deptId: string | null, start: Date | null): TaskLite[] {
  return tasks.filter(
    (t) => (!deptId || t.departmentId === deptId) && (!start || (t.dueAt !== null && t.dueAt.getTime() >= start.getTime())),
  );
}

/** Raw chain rows: raised inside the window (department applies post-aggregation). */
export function ccFilterInstances(instances: WfQueueRow[], start: Date | null): WfQueueRow[] {
  return start ? instances.filter((i) => i.createdAt.getTime() >= start.getTime()) : instances;
}

/** Backlog rows: only chains waiting at the selected department's gate. */
export function ccFilterBacklog(rows: ApprovalBacklogRow[], deptSlug: string | null): ApprovalBacklogRow[] {
  return deptSlug ? rows.filter((r) => r.dept === deptSlug) : rows;
}

/** Payment stage rows: only stages at the selected department's gate. */
export function ccFilterStages(stages: PaymentStage[], deptSlug: string | null): PaymentStage[] {
  return deptSlug ? stages.filter((s) => s.dept === deptSlug) : stages;
}

/** Headcount rows: only the selected department. */
export function ccFilterHeadcount(rows: DeptHeadcount[], deptId: string | null): DeptHeadcount[] {
  return deptId ? rows.filter((r) => r.deptId === deptId) : rows;
}
