import {
  BarChart3,
  Building2,
  FileClock,
  FileText,
  LineChart,
  ListChecks,
  Inbox,
  LifeBuoy,
  AlertTriangle,
  Settings,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

/** SUPER_ADMIN → "Super Admin". */
export function roleLabel(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: BarChart3, exact: true },
  { label: "My Desk", href: "/my", icon: Inbox, exact: true },
  { label: "Departments", href: "/departments", icon: Building2 },
  { label: "Documents", href: "/documents", icon: FileText },
  { label: "IT Service Portal", href: "/it", icon: LifeBuoy },
  { label: "Workflows & Approvals", href: "/workflows", icon: ListChecks },
  { label: "Users & Permissions", href: "/users", icon: Users },
  { label: "Audit Logs", href: "/audit", icon: FileClock },
  { label: "Exceptions & Alerts", href: "/exceptions", icon: AlertTriangle },
  { label: "Command Centre", href: "/reports", icon: LineChart },
  { label: "Settings", href: "/settings", icon: Settings },
];
