import type { DocStatus } from "@prisma/client";
import { statusBreakdown, transitionTarget } from "./dashboard-stats";

// Pure time-series aggregations behind the dashboard Analytics charts. Callers pass only
// documents (and their status transitions) the viewer may see.

export const RANGE_KEYS = ["1d", "7d", "30d", "90d", "12m"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

const RANGES: Record<RangeKey, { unit: "hour" | "day" | "week" | "month"; count: number }> = {
  "1d": { unit: "hour", count: 24 },
  "7d": { unit: "day", count: 7 },
  "30d": { unit: "day", count: 30 },
  "90d": { unit: "week", count: 13 },
  "12m": { unit: "month", count: 12 },
};

export function parseRange(value: string | null): RangeKey {
  return (RANGE_KEYS as readonly string[]).includes(value ?? "") ? (value as RangeKey) : "30d";
}

export type Bucket = { start: Date; end: Date; label: string };

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Contiguous buckets ending with the one that contains `now`. */
export function buildBuckets(range: RangeKey, now: Date): Bucket[] {
  const { unit, count } = RANGES[range];
  return Array.from({ length: count }, (_, i) => {
    const back = count - 1 - i;
    if (unit === "month") {
      const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
      return { start, end, label: start.toLocaleDateString("en-GB", { month: "short" }) };
    }
    if (unit === "hour") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - back);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - back + 1);
      return { start, end, label: start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) };
    }
    const span = unit === "week" ? 7 : 1;
    const end = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1 - back * span);
    const start = addDays(end, -span);
    return { start, end, label: start.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) };
  });
}

/** The selected period and the equally long period just before it (for % change). */
export function periodBounds(buckets: Bucket[]) {
  const start = buckets[0].start;
  const end = buckets[buckets.length - 1].end;
  return { start, end, prevStart: new Date(start.getTime() - (end.getTime() - start.getTime())) };
}

export function bucketIndex(date: Date, buckets: Bucket[]): number {
  const t = date.getTime();
  if (!buckets.length || t < buckets[0].start.getTime() || t >= buckets[buckets.length - 1].end.getTime()) {
    return -1;
  }
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid].start.getTime() <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function countSeries(dates: Date[], buckets: Bucket[]): number[] {
  const out = buckets.map(() => 0);
  for (const d of dates) {
    const i = bucketIndex(d, buckets);
    if (i >= 0) out[i]++;
  }
  return out;
}

/** Running total at the end of each bucket (everything created before `bucket.end`). */
export function cumulativeSeries(dates: Date[], buckets: Bucket[]): number[] {
  const sorted = dates.map((d) => d.getTime()).sort((a, b) => a - b);
  let j = 0;
  return buckets.map((b) => {
    const end = b.end.getTime();
    while (j < sorted.length && sorted[j] < end) j++;
    return j;
  });
}

export type AnalyticsInput = {
  docs: { status: DocStatus; createdAt: Date }[];
  users: { createdAt: Date }[];
  /** DOCUMENT_STATUS_CHANGED events on visible documents. */
  transitions: { detail: unknown; createdAt: Date }[];
};

export type AnalyticsPayload = {
  range: RangeKey;
  labels: string[];
  growth: { documents: number[]; users: number[] };
  flow: { submitted: number[]; approved: number[]; changes: number[] };
  status: { name: string; value: number }[];
};

export function buildAnalytics(input: AnalyticsInput, range: RangeKey, now: Date): AnalyticsPayload {
  const buckets = buildBuckets(range, now);
  const datesTo = (to: string) =>
    input.transitions.filter((t) => transitionTarget(t.detail) === to).map((t) => t.createdAt);

  return {
    range,
    labels: buckets.map((b) => b.label),
    growth: {
      documents: cumulativeSeries(input.docs.map((d) => d.createdAt), buckets),
      users: cumulativeSeries(input.users.map((u) => u.createdAt), buckets),
    },
    flow: {
      submitted: countSeries(datesTo("IN_REVIEW"), buckets),
      approved: countSeries(datesTo("APPROVED"), buckets),
      changes: countSeries(datesTo("CHANGES_REQUESTED"), buckets),
    },
    status: statusBreakdown(input.docs),
  };
}
