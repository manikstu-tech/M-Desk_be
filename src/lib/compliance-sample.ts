// SAMPLE DATA for the Policies & Compliance "Compliance" and "Reports" tabs.
// Same approach as the other Policies & Compliance tabs: fixed figures until the
// module reads live records. Every page that uses this shows a "Sample data" badge.

export const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"] as const;

export const TREND: Record<"Overall" | "Policy" | "Training" | "Documents", number[]> = {
  Overall: [76, 80, 82, 85, 87, 88, 90],
  Policy: [80, 83, 86, 88, 89, 91, 92],
  Training: [72, 76, 79, 82, 84, 86, 88],
  Documents: [78, 81, 83, 85, 86, 88, 89],
};

export const TOTAL_EMPLOYEES = 126;
/** Overall compliance at the end of the previous review cycle. */
export const LAST_CYCLE_OVERALL = 86;

export const AREAS = [
  { label: "Policy Acknowledgement", pct: 92, count: 116, color: "#1f9d5b" },
  { label: "Mandatory Training", pct: 88, count: 111, color: "#e0a82e" },
  { label: "Employee Documents", pct: 89, count: 112, color: "#3b82f6" },
];

export const SUMMARY = { compliant: 114, pending: 8, overdue: 4 };

export const REASONS = [
  { label: "Training Not Completed", count: 4, color: "bg-red-500" },
  { label: "Policy Not Acknowledged", count: 3, color: "bg-amber-400" },
  { label: "Documents Missing", count: 1, color: "bg-amber-400" },
];

export type Status = "Compliant" | "In Progress" | "Non-Compliant";
export type EmployeeRow = { name: string; code: string; department: string; policy: number; training: number; documents: number };

export const EMPLOYEES: EmployeeRow[] = [
  { name: "Hemant Sahu", code: "EMP001", department: "Operations", policy: 100, training: 100, documents: 100 },
  { name: "Kunti Sahu", code: "EMP002", department: "Field Operations", policy: 100, training: 75, documents: 100 },
  { name: "Ramadhan Behera", code: "EMP003", department: "Supply Chain", policy: 100, training: 0, documents: 100 },
  { name: "Jyoti Sahoo", code: "EMP004", department: "Program", policy: 100, training: 100, documents: 80 },
  { name: "Aruna Sahu", code: "EMP005", department: "Finance", policy: 80, training: 100, documents: 100 },
  { name: "Jitu Pradhan", code: "EMP006", department: "HR & Admin", policy: 100, training: 100, documents: 100 },
  { name: "Sanjay Mohanty", code: "EMP007", department: "Animal Health", policy: 100, training: 100, documents: 100 },
  { name: "Puja Nayak", code: "EMP008", department: "Field Operations", policy: 60, training: 50, documents: 100 },
  { name: "Bikash Das", code: "EMP009", department: "Technology & MIS", policy: 100, training: 100, documents: 100 },
  { name: "Lipika Rout", code: "EMP010", department: "Operations", policy: 100, training: 100, documents: 60 },
  { name: "Manoj Barik", code: "EMP011", department: "Supply Chain", policy: 0, training: 25, documents: 80 },
  { name: "Sasmita Jena", code: "EMP012", department: "Finance", policy: 100, training: 100, documents: 100 },
];

export function statusOf(r: EmployeeRow): Status {
  if (r.policy === 100 && r.training === 100 && r.documents === 100) return "Compliant";
  if (r.policy === 0 || r.training === 0 || r.documents === 0) return "Non-Compliant";
  return "In Progress";
}

export const REPORT_TILES = [
  { label: "Total Reports Generated", value: 48, change: 26 },
  { label: "Policy Reports", value: 18, change: 20 },
  { label: "Training Reports", value: 16, change: 33 },
  { label: "Compliance Reports", value: 14, change: 27 },
];

export const REPORT_DISTRIBUTION = [
  { label: "Policy Reports", count: 18, color: "#1f9d5b" },
  { label: "Training Reports", count: 16, color: "#3b82f6" },
  { label: "Compliance Reports", count: 14, color: "#e0a82e" },
];

export type ReportKind = "Policy" | "Training" | "Compliance" | "Documents";
export const AVAILABLE_REPORTS: { key: string; title: string; description: string; kind: ReportKind }[] = [
  { key: "policy-ack", title: "Policy Acknowledgement Report", description: "Employee-wise policy acknowledgement status.", kind: "Policy" },
  { key: "policy-versions", title: "Policy Version History Report", description: "All policy versions with publish and review details.", kind: "Policy" },
  { key: "training", title: "Mandatory Training Report", description: "Course enrolment, completion and assessment status.", kind: "Training" },
  { key: "training-compliance", title: "Training Compliance Report", description: "Department-wise training compliance and gaps.", kind: "Training" },
  { key: "documents", title: "Employee Document Compliance Report", description: "Mandatory documents submission and verification status.", kind: "Documents" },
  { key: "overall", title: "Overall Compliance Report", description: "Combined view of policy, training and document compliance.", kind: "Compliance" },
  { key: "non-compliance", title: "Non-Compliance Report", description: "List of pending, overdue and non-compliant items.", kind: "Compliance" },
  { key: "summary", title: "HR Compliance Summary", description: "Organisation-level compliance summary with key metrics.", kind: "Compliance" },
];

export const RECENT_REPORTS: { report: string; kind: ReportKind; by: string; filters: string; on: string }[] = [
  { report: "policy-ack", kind: "Policy", by: "Aftab Khan", filters: "All Departments • All Policies", on: "2026-10-20T15:24:00+05:30" },
  { report: "training", kind: "Training", by: "Kunti Sahu", filters: "Operations • All Training", on: "2026-10-18T11:10:00+05:30" },
  { report: "summary", kind: "Compliance", by: "Ramadhan Behera", filters: "All Departments • FY 2026 – 27", on: "2026-10-15T17:42:00+05:30" },
  { report: "documents", kind: "Documents", by: "Aruna Sahu", filters: "Finance • Mandatory Documents", on: "2026-10-12T16:18:00+05:30" },
];

export const SAMPLE_POLICIES = ["Code of Conduct Policy", "POSH Policy", "Information Security Policy", "Work from Home Policy", "Travel & Expense Policy"];
export const SAMPLE_TRAININGS = ["POSH Training", "Code of Conduct Training", "Information Security Awareness"];

/** CSV rows for a report, built from the sample employees and the chosen filters. */
export function reportCsv(key: string, filters: { department?: string } = {}): string {
  const rows = EMPLOYEES.filter((e) => !filters.department || e.department === filters.department);
  const cell = (v: string | number) => {
    const s = String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // formula-injection guard, as in the other exporters
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["Employee", "Employee ID", "Department"];
  const pick: Record<string, [string[], (e: EmployeeRow) => (string | number)[]]> = {
    "policy-ack": [["Policy %"], (e) => [e.policy]],
    "policy-versions": [["Policies acknowledged"], (e) => [`${Math.round((e.policy / 100) * SAMPLE_POLICIES.length)} of ${SAMPLE_POLICIES.length}`]],
    training: [["Training %"], (e) => [e.training]],
    "training-compliance": [["Training %", "Status"], (e) => [e.training, e.training === 100 ? "Complete" : "Gap"]],
    documents: [["Documents %"], (e) => [e.documents]],
    overall: [["Policy %", "Training %", "Documents %", "Overall status"], (e) => [e.policy, e.training, e.documents, statusOf(e)]],
    "non-compliance": [["Policy %", "Training %", "Documents %", "Overall status"], (e) => [e.policy, e.training, e.documents, statusOf(e)]],
    summary: [["Overall status"], (e) => [statusOf(e)]],
  };
  const [extra, fn] = pick[key] ?? pick.overall;
  const list = key === "non-compliance" ? rows.filter((e) => statusOf(e) !== "Compliant") : rows;
  return [["SAMPLE DATA — not live records"], [...head, ...extra], ...list.map((e) => [e.name, e.code, e.department, ...fn(e)])]
    .map((r) => r.map(cell).join(","))
    .join("\n");
}
