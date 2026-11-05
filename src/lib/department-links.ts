import { HR_BASE, HR_SLUG } from "./hr-catalogue";
import { TECH_BASE, TECH_SLUG } from "./tech-catalogue";
import { FIN_BASE, FIN_SLUG } from "./finance-types";
import { AH_BASE, AH_SLUG } from "./animal-health/types";

export const DEPARTMENT_WORKSPACES: Record<string, string> = { [HR_SLUG]: HR_BASE, [TECH_SLUG]: TECH_BASE, [FIN_SLUG]: FIN_BASE, [AH_SLUG]: AH_BASE };

// Departments with their own workspace open it; the rest open their documents.
export function departmentHref(d: { id: string; slug: string }): string {
  return DEPARTMENT_WORKSPACES[d.slug] ?? `/documents?departmentId=${d.id}`;
}
