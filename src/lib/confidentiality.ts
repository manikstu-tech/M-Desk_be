// Plain-language names for the L1–L4 confidentiality ladder (see canViewDocument in
// documents.ts). The L-codes stay as stored values; people see these labels instead.

export type ConfidentialityLevel = "L1" | "L2" | "L3" | "L4";

export type ConfidentialityInfo = {
  level: ConfidentialityLevel;
  name: string;
  /** Who can open a document at this level. */
  audience: string;
  /** When to pick it. */
  hint: string;
};

export const CONFIDENTIALITY: ConfidentialityInfo[] = [
  {
    level: "L1",
    name: "Everyone",
    audience: "Anyone in the company",
    hint: "Notices, policies and general information",
  },
  {
    level: "L2",
    name: "Department",
    audience: "Members of this department",
    hint: "Everyday team work — the usual choice",
  },
  {
    level: "L3",
    name: "Restricted",
    audience: "Department members with extra permission",
    hint: "Budgets, contracts and internal reviews",
  },
  {
    level: "L4",
    name: "Confidential",
    audience: "Only specific people given named access",
    hint: "Salaries, legal and board matters",
  },
];

export const DEFAULT_CONFIDENTIALITY: ConfidentialityLevel = "L2";

export function confidentialityInfo(level: string): ConfidentialityInfo {
  return CONFIDENTIALITY.find((c) => c.level === level) ?? CONFIDENTIALITY[1];
}
