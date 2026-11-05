import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  Building,
  ClipboardList,
  Cpu,
  Crown,
  Handshake,
  HardHat,
  HeartPulse,
  Landmark,
  Megaphone,
  ShoppingCart,
  Sprout,
  Truck,
  Users,
} from "lucide-react";

// Static homepage content from the approved "Manikstu Digital Office" design.
// Not database-backed: edit here until projects/platforms get their own models.

export type FeaturedProject = {
  slug: string;
  name: string;
  location: string;
  blurb: string;
  image: string;
  /** CSS object-position keeping the people in frame when the image is cropped. */
  focus: string;
};

export const FEATURED_PROJECTS: FeaturedProject[] = [
  {
    slug: "ajah",
    name: "Project AJAH",
    location: "Jajpur, Chhattisgarh",
    blurb: "Our flagship — from a goat to a growing enterprise.",
    image: "/dashboard/project-ajah.webp",
    focus: "50% 60%",
  },
  {
    slug: "sujalam-suphalam",
    name: "Project Sujalam Suphalam",
    location: "Kalahandi, Odisha",
    blurb: "Livestock linked livelihood without a grain of waste.",
    image: "/dashboard/project-sujalam.webp",
    focus: "50% 55%",
  },
  {
    slug: "anang-laxmi",
    name: "Project Anang Laxmi",
    location: "Dhamtari, Chhattisgarh",
    blurb: "The AJAH model, scaled — bigger herds, stronger partnerships.",
    image: "/dashboard/project-anang.webp",
    focus: "50% 50%",
  },
  {
    slug: "meghdeep",
    name: "Project MeghDeep",
    location: "Nareshim, Maharashtra",
    blurb: "1,000 rural micro-entrepreneurs. One proven model.",
    image: "/dashboard/project-meghdeep.webp",
    focus: "35% 60%",
  },
];

export type BusinessPlatform = {
  name: string;
  blurb: string;
  cta: string;
  icon: LucideIcon;
};

// No platform is integrated yet (IntegrationConnection rows are PLANNED), so cards render without links.
export const BUSINESS_PLATFORMS: BusinessPlatform[] = [
  {
    name: "CRM",
    blurb: "Farmers, customers and partners — leads, follow ups and service history in one place.",
    cta: "Open CRM",
    icon: Users,
  },
  {
    name: "Digital Marketplace",
    blurb: "Online sale of goats, meat and farm inputs, with orders and buyer management.",
    cta: "Open Marketplace",
    icon: ShoppingCart,
  },
  {
    name: "FPO Collaboration",
    blurb: "Work with Farmer Producer Organisations to aggregate, finance and market at scale.",
    cta: "Open FPO Portal",
    icon: Sprout,
  },
  {
    name: "Goatpreneur Hub Partner",
    blurb: "Onboarding and enabling hub partners who grow women-led enterprises.",
    cta: "Open Partner Portal",
    icon: Handshake,
  },
];

// Icon per seeded department number (DESIGN.MD department table).
export const DEPARTMENT_ICONS: Record<number, LucideIcon> = {
  1: Crown,
  2: ClipboardList,
  3: Sprout,
  4: Truck,
  5: HardHat,
  6: HeartPulse,
  7: Landmark,
  8: ShoppingCart,
  9: Users,
  10: Cpu,
  11: Megaphone,
  12: Briefcase,
};

export const DEFAULT_DEPARTMENT_ICON: LucideIcon = Building;

export const COMPANY = {
  legalName: "Manikstu Agro Private Limited",
  tagline: "Healthy Animals | Empowered Communities | Sustainable Livelihoods | Stronger Rural India",
  founder: "Biren Sahoo, Founder & CEO",
  phone: "+91 98330 30312",
  email: "info@manikstu.com",
  website: "www.manikstu.com",
};
