import type { AuthSession } from "./authorize";
import { db } from "./db";
import { techAccess, techAudit } from "./tech";
import { listItems } from "./tech-items";
import { listAssets, listLicences } from "./tech-registers";
import { ASSET_STATUS_LABEL, LANES, monthlyCost, statusLabel, TYPE_META, type Lane } from "./tech-catalogue";
import type { ItemFilters } from "./tech-validation";
import { ApiError } from "./validation";

// §9: every report exports as CSV, filtered by confidentiality (the same ladder as
// the lists) and audited as LIST_EXPORTED with the filters and row count.

function cell(value: unknown): string {
  let v = String(value ?? "");
  // spreadsheet formula injection guard
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");

function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export async function exportTech(session: AuthSession, register: "items" | "assets" | "licences", filters: ItemFilters) {
  const access = await techAccess(session);
  if (!access.member || !access.exporter) throw new ApiError(403, "FORBIDDEN", "Exports need a lead, auditor or EXPORT grant in Technology & MIS");

  let body: string;
  let count: number;
  if (register === "assets") {
    const assets = await listAssets();
    count = assets.length;
    body = csv(
      ["Tag", "Kind", "Make", "Model", "Serial", "Status", "Custodian", "Location", "Purchased", "Cost", "Warranty until"],
      assets.map((a) => [a.tag, a.kind, a.make, a.model, a.serial, ASSET_STATUS_LABEL[a.status] ?? a.status, a.custodian?.name, a.location, iso(a.purchasedAt), a.cost?.toString(), iso(a.warrantyUntil)]),
    );
  } else if (register === "licences") {
    const licences = await listLicences();
    count = licences.length;
    body = csv(
      ["Product", "Vendor", "Seats", "Assigned", "Cost per period", "Period", "Cost per month", "Renews", "Owner", "Auto-renew"],
      licences.map((l) => [l.product, l.vendor, l.seats, l.assignments.length, l.costPerPeriod.toString(), l.period, monthlyCost(Number(l.costPerPeriod), l.period).toFixed(2), iso(l.renewsAt), l.owner.name, l.autoRenew ? "yes" : "no"]),
    );
  } else {
    const items = await listItems(access, filters, 5000);
    count = items.length;
    body = csv(
      ["Key", "Type", "Title", "Status", "Priority", "Lane", "Category", "Confidentiality", "Reporter", "Assignee", "Created", "Resolve due", "Resolved", "Closed", "Resolution", "CSAT"],
      items.map((i) => [
        i.key,
        TYPE_META[i.type].label,
        i.title,
        statusLabel(i.status),
        i.priority,
        LANES[i.component as Lane]?.label ?? i.component,
        [i.category, i.subcategory].filter(Boolean).join(" › "),
        i.confidentiality,
        i.reporter.name,
        i.assignee?.name,
        iso(i.createdAt),
        iso(i.resolveDueAt),
        iso(i.resolvedAt),
        iso(i.closedAt),
        i.resolutionCode,
        i.csat,
      ]),
    );
  }

  await db.$transaction((tx) =>
    techAudit(tx, session, access.dept.id, {
      action: "TECH_LIST_EXPORTED",
      targetType: register === "items" ? "TechItemList" : register === "assets" ? "AssetList" : "LicenceList",
      detail: { register, count, filters },
    }),
  );
  return body;
}
