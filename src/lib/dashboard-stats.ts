import type { DocStatus } from "@prisma/client";

// Pure aggregations for the dashboard. Callers pass only documents the viewer may see.

export type StatDoc = { departmentId: string; status: DocStatus };
export type StatDept = { id: string; name: string };

export const STATUS_BUCKETS = ["Completed", "In Progress", "On Hold", "Not Started"] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

const BUCKET_OF: Record<DocStatus, StatusBucket | null> = {
  APPROVED: "Completed",
  PUBLISHED: "Completed",
  IN_REVIEW: "In Progress",
  REVISED: "In Progress",
  CHANGES_REQUESTED: "On Hold",
  DRAFT: "Not Started",
  ARCHIVED: null, // retired documents are not part of current work
};

export function statusBreakdown(docs: Pick<StatDoc, "status">[]): { name: StatusBucket; value: number }[] {
  const counts = new Map<StatusBucket, number>(STATUS_BUCKETS.map((b) => [b, 0]));
  for (const d of docs) {
    const b = BUCKET_OF[d.status];
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return STATUS_BUCKETS.map((name) => ({ name, value: counts.get(name) ?? 0 }));
}

/** "Finance & Accounts" → "Finance"; keeps chart axes readable. */
export function shortDeptName(name: string): string {
  return name.split(/\s*&\s*|\s+/)[0] || name;
}

/** Document count per department, largest first; the tail past `top` folds into "Others". */
export function docsByDepartment(docs: StatDoc[], depts: StatDept[], top = 7) {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.departmentId, (counts.get(d.departmentId) ?? 0) + 1);
  const rows = depts
    .map((d) => ({ name: shortDeptName(d.name), count: counts.get(d.id) ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  if (rows.length <= top + 1) return rows;
  const others = rows.slice(top).reduce((sum, r) => sum + r.count, 0);
  return [...rows.slice(0, top), { name: "Others", count: others }];
}

/** Share of each department's live documents that are approved or published. */
export function deptPerformance(docs: StatDoc[], depts: StatDept[]) {
  const total = new Map<string, number>();
  const done = new Map<string, number>();
  for (const d of docs) {
    const b = BUCKET_OF[d.status];
    if (!b) continue;
    total.set(d.departmentId, (total.get(d.departmentId) ?? 0) + 1);
    if (b === "Completed") done.set(d.departmentId, (done.get(d.departmentId) ?? 0) + 1);
  }
  return depts
    .filter((d) => (total.get(d.id) ?? 0) > 0)
    .map((d) => ({
      name: shortDeptName(d.name),
      pct: Math.round(((done.get(d.id) ?? 0) / (total.get(d.id) ?? 1)) * 100),
    }))
    .sort((a, b) => b.pct - a.pct);
}

/** Target status of a DOCUMENT_STATUS_CHANGED audit event (`detail.to`), if well-formed. */
export function transitionTarget(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null || !("to" in detail)) return null;
  return typeof detail.to === "string" ? detail.to : null;
}

export type TransitionEvent = { detail: unknown; createdAt: Date };

/** Monthly approvals vs submissions-for-review over the last `months` calendar months. */
export function approvalTrend(events: TransitionEvent[], now: Date, months = 6) {
  const buckets = Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    return {
      key: `${d.getFullYear()}-${d.getMonth()}`,
      month: d.toLocaleDateString("en-GB", { month: "short" }),
      approved: 0,
      pending: 0,
    };
  });
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const ev of events) {
    const b = byKey.get(`${ev.createdAt.getFullYear()}-${ev.createdAt.getMonth()}`);
    if (!b) continue;
    const to = transitionTarget(ev.detail);
    if (to === "APPROVED") b.approved++;
    else if (to === "IN_REVIEW") b.pending++;
  }
  return buckets.map(({ month, approved, pending }) => ({ month, approved, pending }));
}
