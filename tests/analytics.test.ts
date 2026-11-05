import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  buildAnalytics,
  buildBuckets,
  countSeries,
  cumulativeSeries,
  parseRange,
} from "@/lib/analytics";

const now = new Date(2026, 9, 26, 15, 0); // 26 Oct 2026, 15:00 local
const day = (d: number, h = 10) => new Date(2026, 9, d, h);

describe("buckets", () => {
  it("7d is seven contiguous days ending today", () => {
    const b = buildBuckets("7d", now);
    expect(b).toHaveLength(7);
    expect(b[0].start).toEqual(new Date(2026, 9, 20));
    expect(b[6].end).toEqual(new Date(2026, 9, 27));
    for (let i = 1; i < b.length; i++) expect(b[i].start).toEqual(b[i - 1].end);
  });

  it("1d is twenty-four hours ending with the current one", () => {
    const b = buildBuckets("1d", now);
    expect(b).toHaveLength(24);
    expect(b[0].start).toEqual(new Date(2026, 9, 25, 16));
    expect(b[23].end).toEqual(new Date(2026, 9, 26, 16));
    expect(b[23].label).toBe("15:00");
    for (let i = 1; i < b.length; i++) expect(b[i].start).toEqual(b[i - 1].end);
  });

  it("12m is calendar months ending with the current one", () => {
    const b = buildBuckets("12m", now);
    expect(b).toHaveLength(12);
    expect(b[0].start).toEqual(new Date(2025, 10, 1));
    expect(b[11].end).toEqual(new Date(2026, 10, 1));
  });

  it("90d is thirteen weeks ending today", () => {
    const b = buildBuckets("90d", now);
    expect(b).toHaveLength(13);
    expect(b[12].end).toEqual(new Date(2026, 9, 27));
  });

  it("bucketIndex finds the right bucket and rejects out-of-range dates", () => {
    const b = buildBuckets("7d", now);
    expect(bucketIndex(day(20, 0), b)).toBe(0);
    expect(bucketIndex(day(26, 23), b)).toBe(6);
    expect(bucketIndex(day(19, 23), b)).toBe(-1);
    expect(bucketIndex(day(27, 0), b)).toBe(-1);
  });

  it("parseRange falls back to 30d", () => {
    expect(parseRange("90d")).toBe("90d");
    expect(parseRange("bogus")).toBe("30d");
    expect(parseRange(null)).toBe("30d");
  });
});

describe("series", () => {
  const b = buildBuckets("7d", now);

  it("counts per bucket and running totals", () => {
    expect(countSeries([day(20), day(20), day(26), day(1)], b)).toEqual([2, 0, 0, 0, 0, 0, 1]);
    // Older items count toward every running total.
    expect(cumulativeSeries([day(1), day(22), day(26)], b)).toEqual([1, 1, 2, 2, 2, 2, 3]);
  });

  it("buildAnalytics assembles growth, flow and status", () => {
    const p = buildAnalytics(
      {
        docs: [
          { status: "APPROVED", createdAt: day(21) },
          { status: "IN_REVIEW", createdAt: day(1) },
        ],
        users: [{ createdAt: day(1) }, { createdAt: day(22) }],
        transitions: [
          { detail: { to: "IN_REVIEW" }, createdAt: day(21, 9) },
          { detail: { to: "APPROVED" }, createdAt: day(21, 13) },
          { detail: { to: "CHANGES_REQUESTED" }, createdAt: day(23) },
          { detail: { bad: true }, createdAt: day(23) },
        ],
      },
      "7d",
      now,
    );
    expect(p.labels).toHaveLength(7);
    expect(p.growth.documents).toEqual([1, 2, 2, 2, 2, 2, 2]);
    expect(p.growth.users).toEqual([1, 1, 2, 2, 2, 2, 2]);
    expect(p.flow).toEqual({
      submitted: [0, 1, 0, 0, 0, 0, 0],
      approved: [0, 1, 0, 0, 0, 0, 0],
      changes: [0, 0, 0, 1, 0, 0, 0],
    });
    expect(p.status.find((s) => s.name === "Completed")?.value).toBe(1);
  });
});
