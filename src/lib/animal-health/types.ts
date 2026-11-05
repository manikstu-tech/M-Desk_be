// Animal Health & Veterinary Services — shared TypeScript models.
// Frontend-only module: these types describe the data shown in the five
// reference screens and form the request/response contract the service layer
// returns. When a real REST API arrives, the services swap their mock source
// for fetch() while keeping these exact shapes, so components never change.

export const AH_SLUG = "animal-health-veterinary-services";
export const AH_BASE = `/departments/${AH_SLUG}`;
export const AH_DEPT_NO = "06";

// ---- Reference enumerations (only values present in the reference) ----------

export const DISTRICTS = ["Balasore", "Mayurbhanj", "Udala", "Baripada", "Keonjhar", "Rairangpur"] as const;
export type District = (typeof DISTRICTS)[number];

export const LIVESTOCK = ["Cattle", "Goat", "Poultry", "Sheep", "Mixed livestock"] as const;
export type Livestock = (typeof LIVESTOCK)[number];

export const DRIVE_STATUSES = ["In Progress", "Planned", "Completed", "Scheduled"] as const;
export type DriveStatus = (typeof DRIVE_STATUSES)[number];

export const CASE_SEVERITIES = ["High", "Medium", "Low"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export const CASE_STATUSES = ["Under Treatment", "Investigating", "Monitoring", "Recovered"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const FPO_STATUSES = ["Active", "Upcoming", "Completed"] as const;
export type FpoStatus = (typeof FPO_STATUSES)[number];

export const INV_CATEGORIES = ["Vaccine", "Dewormer", "Antibiotic", "Supplement"] as const;
export type InvCategory = (typeof INV_CATEGORIES)[number];

export const INV_STATUSES = ["In Stock", "Low Stock", "Reorder", "Expiring Soon"] as const;
export type InvStatus = (typeof INV_STATUSES)[number];

// ---- Entity models ----------------------------------------------------------

export interface KpiMetric {
  label: string;
  value: string;
  sub: string;
  /** colours the sub line when the metric is urgent */
  urgent?: boolean;
  /** render the card in a muted "not available" state (no backend value yet) */
  unavailable?: boolean;
}

export interface CoveragePoint {
  month: string; // Jun … Nov
  coverage: number; // %
  target: number; // %
}

export interface LivestockCoverage {
  livestock: Livestock;
  pct: number;
}

export interface VaccinationDrive {
  id: string;
  name: string;
  district: District;
  livestock: Livestock;
  vet: string;
  achieved: number; // %
  status: DriveStatus;
  date: string; // "08 Nov"
}

export interface Alert {
  id: string;
  title: string;
  meta: string; // location · time OR doses remaining
  level: "High" | "Alert" | "Low" | "Reorder";
}

export interface DistrictCoverage {
  district: District;
  pct: number;
}

export interface HealthCase {
  id: string;
  name: string; // disease
  caseId: string; // CASE-1182
  livestock: Livestock;
  district: District;
  severity: CaseSeverity;
  status: CaseStatus;
  date: string; // "02 Nov"
}

export interface SeverityCount {
  severity: CaseSeverity;
  count: number;
}

export interface Outbreak {
  id: string;
  disease: string;
  district: District;
  detail: string;
  level: "High Priority" | "Monitoring";
  date: string;
}

export interface Fpo {
  id: string;
  name: string;
  district: District;
  focus: string; // "Mixed livestock" | "Cattle" …
  farmers: number;
  animals: number;
  status: FpoStatus;
}

export interface UpcomingCamp {
  id: string;
  day: string; // "10"
  month: string; // "NOV"
  fpo: string;
  detail: string; // "Cattle · FMD vaccination"
}

export interface CategoryStock {
  category: InvCategory;
  pct: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  sub: string; // "Peste des Petits Ruminants"
  code: string; // VAC-PPR
  category: InvCategory;
  stock: number;
  unit: string; // doses | units | vials
  level: number; // 0–100 bar fill
  expiry: string; // "Mar 2027"
  status: InvStatus;
}

// ---- Page payloads (one per screen) ----------------------------------------

export interface OverviewData {
  kpis: KpiMetric[];
  coverage: CoveragePoint[];
  livestockCoverage: LivestockCoverage[];
  schedules: VaccinationDrive[];
  schedulesTotal: number;
  alerts: Alert[];
}

export interface VaccinationData {
  kpis: KpiMetric[];
  drives: VaccinationDrive[];
  drivesTotal: number;
  districtCoverage: DistrictCoverage[];
}

export interface HealthCasesData {
  kpis: KpiMetric[];
  cases: HealthCase[];
  casesTotal: number;
  severity: SeverityCount[];
  outbreaks: Outbreak[];
}

export interface FpoData {
  kpis: KpiMetric[];
  fpos: Fpo[];
  fposTotal: number;
  upcoming: UpcomingCamp[];
}

export interface InventoryData {
  kpis: KpiMetric[];
  categories: CategoryStock[];
  items: InventoryItem[];
  itemsTotal: number;
}
