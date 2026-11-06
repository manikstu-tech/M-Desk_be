// Animal Health & Veterinary Services — STRUCTURAL definitions only.
//
// These are UI structure (the KPI card titles for each screen), not data —
// the equivalent of table headers. They let the service return cards that keep
// their original titles while showing a "--" / "Not available" state until a
// real backend supplies the values. No records, metrics, names or quantities
// live here.

export const OVERVIEW_KPI_LABELS = [
  "Active Vaccination Drives",
  "Animals Inspected (Month)",
  "Critical Disease Alerts",
  "Veterinary Field Doctors",
] as const;

export const VACCINATION_KPI_LABELS = ["Active Drives", "In Progress", "Completed", "Animals Targeted"] as const;

export const HEALTH_KPI_LABELS = ["Open Cases", "Under Treatment", "Recovered", "Active Outbreaks"] as const;

export const FPO_KPI_LABELS = ["Registered FPOs", "Farmers Enrolled", "Camps This Month", "Animals Covered"] as const;

export const INVENTORY_KPI_LABELS = ["Total SKUs", "Low Stock", "Reorder Required", "Expiring"] as const;
