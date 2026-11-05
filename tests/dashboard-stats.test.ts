import { describe, expect, it } from "vitest";
import {
  approvalTrend,
  deptPerformance,
  docsByDepartment,
  shortDeptName,
  statusBreakdown,
  transitionTarget,
  type StatDoc,
} from "@/lib/dashboard-stats";

const depts = [
  { id: "fin", name: "Finance & Accounts" },
  { id: "hr", name: "HR & Administration" },
  { id: "it", name: "Technology & MIS" },
];

const docs: StatDoc[] = [
  { departmentId: "fin", status: "PUBLISHED" },
  { departmentId: "fin", status: "APPROVED" },
  { departmentId: "fin", status: "DRAFT" },
  { departmentId: "fin", status: "ARCHIVED" },
  { departmentId: "hr", status: "IN_REVIEW" },
  { departmentId: "hr", status: "CHANGES_REQUESTED" },
];

describe("dashboard stats", () => {
  it("buckets document statuses and leaves archived out", () => {
    expect(statusBreakdown(docs)).toEqual([
      { name: "Completed", value: 2 },
      { name: "In Progress", value: 1 },
      { name: "On Hold", value: 1 },
      { name: "Not Started", value: 1 },
    ]);
  });

  it("shortens department names to their first word", () => {
    expect(shortDeptName("Finance & Accounts")).toBe("Finance");
    expect(shortDeptName("HR & Administration")).toBe("HR");
    expect(shortDeptName("Animal Health & Veterinary Services")).toBe("Animal");
  });

  it("counts documents per department, skipping empty ones, and folds the tail into Others", () => {
    expect(docsByDepartment(docs, depts)).toEqual([
      { name: "Finance", count: 4 },
      { name: "HR", count: 2 },
    ]);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, name: `Dept${i}` }));
    const manyDocs: StatDoc[] = many.flatMap((d, i) =>
      Array.from({ length: 10 - i }, () => ({ departmentId: d.id, status: "DRAFT" as const })),
    );
    const rows = docsByDepartment(manyDocs, many, 7);
    expect(rows).toHaveLength(8);
    expect(rows[7]).toEqual({ name: "Others", count: 3 + 2 + 1 });
  });

  it("scores departments by the share of live documents that are completed", () => {
    // Finance: 2 completed of 3 live (archived excluded) → 67%; HR: 0 of 2 → 0%
    expect(deptPerformance(docs, depts)).toEqual([
      { name: "Finance", pct: 67 },
      { name: "HR", pct: 0 },
    ]);
  });

  it("reads the transition target only from well-formed audit detail", () => {
    expect(transitionTarget({ from: "DRAFT", to: "IN_REVIEW" })).toBe("IN_REVIEW");
    expect(transitionTarget({ to: 3 })).toBeNull();
    expect(transitionTarget(null)).toBeNull();
    expect(transitionTarget("APPROVED")).toBeNull();
  });

  it("counts approvals and review submissions per month in the window", () => {
    const now = new Date(2026, 9, 24); // Oct 2026
    const trend = approvalTrend(
      [
        { detail: { to: "APPROVED" }, createdAt: new Date(2026, 9, 3) },
        { detail: { to: "IN_REVIEW" }, createdAt: new Date(2026, 9, 2) },
        { detail: { to: "APPROVED" }, createdAt: new Date(2026, 5, 15) },
        { detail: { to: "PUBLISHED" }, createdAt: new Date(2026, 9, 4) },
        { detail: { to: "APPROVED" }, createdAt: new Date(2026, 3, 1) }, // outside window
      ],
      now,
    );
    expect(trend.map((t) => t.month)).toEqual(["May", "Jun", "Jul", "Aug", "Sept", "Oct"]);
    expect(trend[1]).toMatchObject({ approved: 1, pending: 0 });
    expect(trend[5]).toMatchObject({ approved: 1, pending: 1 });
  });
});
