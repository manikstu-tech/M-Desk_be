import type { TechItemType, TechPriority } from "@prisma/client";
import { db } from "./db";
import { visibleItemsWhere, type TechAccess } from "./tech";
import {
  DEV_TYPES,
  hasSla,
  monthlyCost,
  RAG_RULES,
  slaUsed,
  techHref,
  type Rag,
} from "./tech-catalogue";

// Command Centre (blueprint §7): "in 10 seconds, know if anything is on fire; in
// 60 seconds, know where to act". Everything below the loader is pure so the
// tile maths is tested against fixtures (T3 done-when: tiles match DB counts).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type CcItem = {
  key: string;
  title: string;
  type: TechItemType;
  status: string;
  priority: TechPriority;
  component: string;
  category: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  requesterDept: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  resolveDueAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedMs: number;
  csat: number | null;
  reassignCount: number;
  storyPoints: number | null;
  windowStart: Date | null;
};

export type CcLicence = { id: string; product: string; seats: number; used: number; renewsAt: Date; monthly: number };

export type Tile = { id: string; label: string; value: string; sub?: string; rag: Rag; href: string; pending?: string };

export type Insight = { tone: "red" | "amber" | "green" | "blue"; text: string; href: string };

export const isOpen = (i: Pick<CcItem, "closedAt" | "resolvedAt">) => !i.closedAt && !i.resolvedAt;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

function resolvedWithin(items: CcItem[], now: Date, days: number) {
  const from = now.getTime() - days * DAY;
  return items.filter((i) => i.resolvedAt && i.resolvedAt.getTime() >= from);
}

/** Open backlog at a past instant (excludes epics, like the live count). */
export function backlogAt(items: CcItem[], at: Date): number {
  const t = at.getTime();
  return items.filter(
    (i) =>
      i.type !== "EPIC" &&
      i.createdAt.getTime() <= t &&
      !(i.closedAt && i.closedAt.getTime() <= t) &&
      !(i.resolvedAt && i.resolvedAt.getTime() <= t),
  ).length;
}

export function computeTiles(
  items: CcItem[],
  now: Date,
  extra: { approvalsWaiting: number; approvalsOverdue: number; licences: CcLicence[] },
): Tile[] {
  const open = items.filter(isOpen);
  const p1 = open.filter((i) => i.priority === "P1").length;
  const p2 = open.filter((i) => i.priority === "P2").length;

  const res30 = resolvedWithin(items, now, 30);
  const slaRes = res30.filter((i) => i.resolveDueAt);
  const slaPct = pct(slaRes.filter((i) => (i.resolvedAt as Date) <= (i.resolveDueAt as Date)).length, slaRes.length);

  const in4h = open.filter(
    (i) => hasSla(i.type) && !i.slaPausedAt && i.resolveDueAt && i.resolveDueAt > now && i.resolveDueAt.getTime() - now.getTime() <= 4 * HOUR,
  ).length;
  const breached = open.filter((i) => !i.slaPausedAt && i.resolveDueAt && i.resolveDueAt <= now).length;

  const backlog = open.filter((i) => i.type !== "EPIC").length;
  const before = backlogAt(items, new Date(now.getTime() - 7 * DAY));
  const trend = before === 0 ? (backlog === 0 ? 0 : null) : Math.round(((backlog - before) / before) * 100);

  const ttr = res30.map((i) => ((i.resolvedAt as Date).getTime() - i.createdAt.getTime() - i.slaPausedMs) / HOUR);
  const mttr = median(ttr);
  const byP = (["P1", "P2", "P3", "P4"] as TechPriority[])
    .map((p) => {
      const m = median(res30.filter((i) => i.priority === p).map((i) => ((i.resolvedAt as Date).getTime() - i.createdAt.getTime() - i.slaPausedMs) / HOUR));
      return m === null ? null : `${p} ${fmtHours(m)}`;
    })
    .filter(Boolean)
    .join(" · ");

  const desk = res30.filter((i) => i.component === "SD");
  const fcr = pct(desk.filter((i) => i.reassignCount === 0).length, desk.length);

  const rated = res30.filter((i) => i.csat !== null);
  const csat = rated.length ? Math.round((rated.reduce((s, i) => s + (i.csat as number), 0) / rated.length) * 10) / 10 : null;

  const soon = extra.licences.filter((l) => l.renewsAt.getTime() - now.getTime() <= 30 * DAY && l.renewsAt >= new Date(now.getTime() - DAY));
  const urgent = soon.filter((l) => l.renewsAt.getTime() - now.getTime() <= 7 * DAY).length;

  return [
    { id: "p1p2", label: "Open P1 / P2", value: `${p1} / ${p2}`, sub: "Unresolved critical and high", rag: RAG_RULES.openP1P2(p1, p2), href: `${techHref("service-desk")}?priority=${p1 ? "P1" : "P2"}` },
    {
      id: "sla",
      label: "SLA compliance (30d)",
      value: slaPct === null ? "—" : `${slaPct}%`,
      sub: slaRes.length ? `${slaRes.length} resolved with an SLA` : "Nothing resolved yet",
      rag: RAG_RULES.slaCompliance(slaPct),
      href: `${techHref("service-desk")}?status=closed&days=30`,
    },
    {
      id: "breaching",
      label: "Breaching in next 4 h",
      value: String(in4h),
      sub: breached ? `${breached} already breached` : "None breached",
      rag: breached > 0 ? "red" : RAG_RULES.breachingSoon(in4h),
      href: `${techHref("service-desk")}?sla=at_risk`,
    },
    {
      id: "backlog",
      label: "Open backlog",
      value: String(backlog),
      sub: trend === null ? "No baseline a week ago" : `${trend > 0 ? "↑" : trend < 0 ? "↓" : "→"} ${Math.abs(trend)}% vs 7 days ago`,
      rag: RAG_RULES.backlogTrend(trend),
      href: techHref("service-desk"),
    },
    { id: "mttr", label: "Median time to resolve (30d)", value: mttr === null ? "—" : fmtHours(mttr), sub: byP || "Nothing resolved yet", rag: "grey", href: `${techHref("service-desk")}?status=closed&days=30` },
    { id: "fcr", label: "First-contact resolution", value: fcr === null ? "—" : `${fcr}%`, sub: `${desk.length} service-desk items resolved (30d)`, rag: RAG_RULES.fcr(fcr), href: `${techHref("service-desk")}?lane=SD&status=closed&days=30` },
    {
      id: "csat",
      label: "CSAT (30d)",
      value: csat === null ? "—" : `${csat} / 5`,
      sub: res30.length ? `${Math.round((rated.length / res30.length) * 100)}% response rate` : "No ratings yet",
      rag: RAG_RULES.csat(csat),
      href: `${techHref("service-desk")}?status=closed&days=30`,
    },
    {
      id: "approvals",
      label: "Pending approvals",
      value: String(extra.approvalsWaiting),
      sub: extra.approvalsOverdue ? `${extra.approvalsOverdue} overdue` : "None overdue",
      rag: RAG_RULES.approvals(extra.approvalsOverdue),
      href: techHref("changes"),
    },
    {
      id: "renewals",
      label: "Renewals ≤ 30 days",
      value: String(soon.length),
      sub: urgent ? `${urgent} within 7 days` : "Licences and subscriptions",
      rag: RAG_RULES.renewals(urgent, soon.length),
      href: techHref("licences"),
    },
    { id: "leavers", label: "Leaver access open", value: "—", rag: "grey", href: techHref("workflows"), pending: "T2 · access register" },
    { id: "systems", label: "Systems up", value: "—", rag: "grey", href: techHref("settings"), pending: "T6 · monitoring (TM-D12)" },
    { id: "backup", label: "Last backup", value: "—", rag: "grey", href: techHref("settings"), pending: "T6 · backup log" },
  ];
}

export function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} m`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} d`;
}

// §7.2 rule-based insight cards — plain language, each with a link to the items.
export function computeInsights(items: CcItem[], licences: CcLicence[], now: Date): Insight[] {
  const out: Insight[] = [];
  const open = items.filter(isOpen);
  const endOfDay = new Date(now);
  endOfDay.setHours(18, 0, 0, 0);

  const breaching = open.filter((i) => (i.priority === "P1" || i.priority === "P2") && !i.slaPausedAt && i.resolveDueAt && i.resolveDueAt > now && i.resolveDueAt <= endOfDay);
  if (breaching.length) {
    const owners = new Map<string, number>();
    for (const i of breaching) if (i.assigneeName) owners.set(i.assigneeName, (owners.get(i.assigneeName) ?? 0) + 1);
    const top = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
    const load = top ? open.filter((i) => i.assigneeName === top[0]).length : 0;
    out.push({
      tone: "red",
      text: `${breaching.length} P1/P2 item${breaching.length === 1 ? "" : "s"} will breach SLA before 6 pm${top ? `; ${top[1]} assigned to ${top[0]}, who has ${load} open items` : "; none is assigned"}.`,
      href: `${techHref("service-desk")}?sla=at_risk`,
    });
  }

  const overdue = open.filter((i) => !i.slaPausedAt && i.resolveDueAt && i.resolveDueAt <= now);
  if (overdue.length) out.push({ tone: "red", text: `${overdue.length} open item${overdue.length === 1 ? " has" : "s have"} already breached SLA.`, href: `${techHref("service-desk")}?sla=breached` });

  const unassigned = open.filter((i) => !i.assigneeId && now.getTime() - i.createdAt.getTime() > HOUR);
  if (unassigned.length) out.push({ tone: "amber", text: `${unassigned.length} item${unassigned.length === 1 ? " has" : "s have"} been unassigned for more than an hour.`, href: `${techHref("service-desk")}?assignee=unassigned` });

  // A13: ≥ 3 incidents in a category in 14 days and up on the 14 days before → suggest a problem
  const incidents = items.filter((i) => i.type === "INCIDENT" && i.category);
  const window = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (const i of incidents) {
      const age = now.getTime() - i.createdAt.getTime();
      if (age >= from * DAY && age < to * DAY) m.set(i.category as string, (m.get(i.category as string) ?? 0) + 1);
    }
    return m;
  };
  const recent = window(0, 14);
  const prior = window(14, 28);
  for (const [cat, n] of recent) {
    const was = prior.get(cat) ?? 0;
    if (n >= 3 && n > was) {
      const up = was === 0 ? "new this fortnight" : `up ${Math.round(((n - was) / was) * 100)}%`;
      out.push({ tone: "amber", text: `${cat} incidents are ${up} (${n} vs ${was} the fortnight before) — consider a problem record.`, href: `${techHref("service-desk")}?q=${encodeURIComponent(cat)}&status=all&days=14` });
    }
  }

  for (const l of licences) {
    const daysLeft = Math.ceil((l.renewsAt.getTime() - now.getTime()) / DAY);
    const idle = l.seats - l.used;
    if (daysLeft >= 0 && daysLeft <= 60 && idle > 0 && idle / l.seats >= 0.3) {
      const saving = Math.round((idle / l.seats) * l.monthly * 12);
      out.push({
        tone: "blue",
        text: `${l.product}: ${l.seats} seats paid, ${l.used} assigned — about ₹${saving.toLocaleString("en-IN")}/yr to save if downsized at renewal on ${l.renewsAt.toLocaleDateString("en-GB")}.`,
        href: techHref("licences"),
      });
    }
  }

  const changes = open.filter((i) => i.type === "CHANGE" && i.windowStart && i.windowStart >= now && i.windowStart.getTime() - now.getTime() <= 7 * DAY);
  if (changes.length) out.push({ tone: "blue", text: `${changes.length} change${changes.length === 1 ? " is" : "s are"} scheduled in the next 7 days.`, href: techHref("changes") });

  const lowCsat = items.filter((i) => i.csat !== null && i.csat <= 2 && i.resolvedAt && now.getTime() - i.resolvedAt.getTime() <= 7 * DAY);
  if (lowCsat.length) out.push({ tone: "amber", text: `${lowCsat.length} requester${lowCsat.length === 1 ? "" : "s"} rated the service 2 or lower this week.`, href: `${techHref("service-desk")}?status=all&days=7` });

  // weeks[0] = the last 7 days, weeks[1..8] = the eight weeks before
  const weeks = Array.from({ length: 9 }, () => 0);
  for (const i of items) {
    if (!i.resolvedAt) continue;
    const w = Math.floor((now.getTime() - i.resolvedAt.getTime()) / (7 * DAY));
    if (w >= 0 && w < weeks.length) weeks[w]++;
  }
  const [thisWeek, ...previous] = weeks;
  const best = Math.max(...previous);
  if (thisWeek > 0 && thisWeek > best) out.push({ tone: "green", text: `The team resolved ${thisWeek} item${thisWeek === 1 ? "" : "s"} this week — the best in 8 weeks.`, href: `${techHref("service-desk")}?status=closed&days=7` });

  return out;
}

// §7.3 chart series
export function createdVsResolved(items: CcItem[], now: Date, days = 30) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const rows = Array.from({ length: days }, (_, d) => {
    const day = new Date(start.getTime() + d * DAY);
    return { key: day.toDateString(), day: day.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }), created: 0, resolved: 0 };
  });
  const idx = new Map(rows.map((r, n) => [r.key, n]));
  for (const i of items) {
    const c = idx.get(i.createdAt.toDateString());
    if (c !== undefined) rows[c].created++;
    if (i.resolvedAt) {
      const r = idx.get(i.resolvedAt.toDateString());
      if (r !== undefined) rows[r].resolved++;
    }
  }
  return rows.map(({ day, created, resolved }) => ({ day, created, resolved }));
}

export function ageingBuckets(items: CcItem[], now: Date) {
  const buckets = [
    { label: "0–2 days", max: 2 },
    { label: "3–7 days", max: 7 },
    { label: "8–30 days", max: 30 },
    { label: "30+ days", max: Infinity },
  ];
  const counts = buckets.map((b) => ({ label: b.label, value: 0 }));
  for (const i of items.filter(isOpen)) {
    const age = (now.getTime() - i.createdAt.getTime()) / DAY;
    const n = buckets.findIndex((b) => age <= b.max);
    counts[n].value++;
  }
  return counts;
}

function countBy(items: CcItem[], key: (i: CcItem) => string | null, top = 10) {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([label, value]) => ({ label, value }));
}

export function workload(items: CcItem[]) {
  const open = items.filter(isOpen);
  const m = new Map<string, { label: string; value: number; points: number }>();
  for (const i of open) {
    const name = i.assigneeName ?? "Unassigned";
    const row = m.get(name) ?? { label: name, value: 0, points: 0 };
    row.value++;
    row.points += i.storyPoints ?? 0;
    m.set(name, row);
  }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

// ───────────── loader ─────────────

export async function loadCommandCentre(access: TechAccess, now = new Date()) {
  const since = new Date(now.getTime() - 90 * DAY);
  const [rows, licences, itAccess, assets, warranty, activity] = await Promise.all([
    db.techItem.findMany({
      where: {
        AND: [visibleItemsWhere(access), { OR: [{ closedAt: null }, { createdAt: { gte: since } }, { resolvedAt: { gte: since } }] }],
      },
      select: {
        key: true,
        title: true,
        type: true,
        status: true,
        priority: true,
        component: true,
        category: true,
        assigneeId: true,
        createdAt: true,
        resolvedAt: true,
        closedAt: true,
        resolveDueAt: true,
        slaPausedAt: true,
        slaPausedMs: true,
        csat: true,
        reassignCount: true,
        storyPoints: true,
        details: true,
        assignee: { select: { name: true } },
        reporter: { select: { memberships: { select: { department: { select: { name: true } } }, take: 1 } } },
      },
    }),
    db.licence.findMany({ include: { _count: { select: { assignments: { where: { revokedAt: null } } } } } }),
    db.workflowInstance.findMany({
      where: { status: "IN_PROGRESS", currentStep: 1, definition: { key: "it_access" } },
      select: { dueAt: true },
    }),
    db.asset.groupBy({ by: ["status"], _count: { _all: true } }),
    db.asset.findMany({
      where: { status: "IN_USE", warrantyUntil: { gte: now, lte: new Date(now.getTime() + 90 * DAY) } },
      select: { id: true, tag: true, kind: true, warrantyUntil: true },
      orderBy: { warrantyUntil: "asc" },
      take: 5,
    }),
    db.auditEvent.findMany({
      where: { departmentId: access.dept.id, NOT: { action: { startsWith: "DENIED_" } } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, action: true, createdAt: true, actorEmail: true, actor: { select: { name: true } }, detail: true },
    }),
  ]);

  const items: CcItem[] = rows.map((r) => {
    const d = r.details && typeof r.details === "object" && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {};
    const ws = typeof d.windowStart === "string" ? new Date(d.windowStart) : null;
    return {
      key: r.key,
      title: r.title,
      type: r.type,
      status: r.status,
      priority: r.priority,
      component: r.component,
      category: r.category,
      assigneeId: r.assigneeId,
      assigneeName: r.assignee?.name ?? null,
      requesterDept: r.reporter.memberships[0]?.department.name ?? null,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      closedAt: r.closedAt,
      resolveDueAt: r.resolveDueAt,
      slaPausedAt: r.slaPausedAt,
      slaPausedMs: r.slaPausedMs,
      csat: r.csat,
      reassignCount: r.reassignCount,
      storyPoints: r.storyPoints,
      windowStart: ws && !Number.isNaN(ws.getTime()) ? ws : null,
    };
  });

  const ccLicences: CcLicence[] = licences.map((l) => ({
    id: l.id,
    product: l.product,
    seats: l.seats,
    used: l._count.assignments,
    renewsAt: l.renewsAt,
    monthly: monthlyCost(Number(l.costPerPeriod), l.period),
  }));

  const changesWaiting = items.filter((i) => i.type === "CHANGE" && ["SUBMITTED", "RISK_ASSESSED"].includes(i.status));
  const approvalsWaiting = changesWaiting.length + itAccess.length;
  // a change still waiting for approval once its window has opened is overdue
  const approvalsOverdue =
    itAccess.filter((w) => w.dueAt && w.dueAt < now).length + changesWaiting.filter((c) => c.windowStart && c.windowStart < now).length;

  const open = items.filter(isOpen);
  const slaOpen = open.filter((i) => hasSla(i.type) && !i.slaPausedAt && i.resolveDueAt);
  const breachingSoon = [...slaOpen].sort((a, b) => (a.resolveDueAt as Date).getTime() - (b.resolveDueAt as Date).getTime()).slice(0, 10);

  return {
    asOf: now,
    tiles: computeTiles(items, now, { approvalsWaiting, approvalsOverdue, licences: ccLicences }),
    insights: computeInsights(items, ccLicences, now),
    charts: {
      trend: createdVsResolved(items, now),
      ageing: ageingBuckets(items, now),
      categories: countBy(items.filter((i) => now.getTime() - i.createdAt.getTime() <= 30 * DAY), (i) => i.category),
      departments: countBy(items.filter((i) => now.getTime() - i.createdAt.getTime() <= 30 * DAY && !DEV_TYPES.includes(i.type)), (i) => i.requesterDept),
      workload: workload(items),
    },
    lists: {
      breachingSoon: breachingSoon.map((i) => ({ ...i, used: slaUsed(i, now) ?? 0 })),
      unassigned: open.filter((i) => !i.assigneeId && now.getTime() - i.createdAt.getTime() > HOUR).slice(0, 10),
      waiting: items.filter((i) => isOpen(i) && i.slaPausedAt).slice(0, 10),
      changes: open.filter((i) => i.type === "CHANGE" && i.windowStart && i.windowStart.getTime() - now.getTime() <= 7 * DAY && i.windowStart >= new Date(now.getTime() - DAY)),
      renewals: ccLicences.filter((l) => l.renewsAt >= now && l.renewsAt.getTime() - now.getTime() <= 30 * DAY),
      warranty,
    },
    assets: assets.map((a) => ({ status: a.status, count: a._count._all })),
    licences: ccLicences,
    activity,
  };
}
