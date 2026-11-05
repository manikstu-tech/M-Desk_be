import { Confidentiality, TechItemType, TechPriority } from "@prisma/client";
import { z } from "zod";
import { CHANGE_OUTCOMES, CHANGE_RISK, IMPACTS, LANES, LINK_KINDS, RESOLUTION_CODES, SOURCES, TECH_DOC_CATEGORIES, URGENCIES } from "./tech-catalogue";

const keys = <T extends Record<string, unknown>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const optionalText = (max: number) => z.string().trim().max(max).optional();

// Type-specific `details` (§4.1): only the fields each type needs.
export const changeDetailsSchema = z.object({
  risk: z.enum(keys(CHANGE_RISK)).default("MINOR"),
  plan: optionalText(4000),
  rollback: optionalText(4000),
  testEvidence: optionalText(2000),
  affected: optionalText(500),
  windowStart: z.coerce.date().optional(),
  windowEnd: z.coerce.date().optional(),
  outcome: z.enum(keys(CHANGE_OUTCOMES)).optional(),
});

export const misDetailsSchema = z.object({
  purpose: optionalText(1000),
  period: optionalText(200),
  audience: optionalText(200),
});

export const incidentDetailsSchema = z.object({
  pir: optionalText(4000),
});

export const DETAILS_SCHEMA: Partial<Record<TechItemType, z.ZodType>> = {
  CHANGE: changeDetailsSchema,
  MIS_REQUEST: misDetailsSchema,
  INCIDENT: incidentDetailsSchema,
};

export const createItemSchema = z.object({
  type: z.nativeEnum(TechItemType),
  title: z.string().trim().min(5, "Title needs at least 5 characters").max(140, "Title is at most 140 characters"),
  description: optionalText(8000),
  category: z.string().trim().min(1, "Pick a category").max(80),
  subcategory: optionalText(80),
  impact: z.enum(keys(IMPACTS)).optional(),
  urgency: z.enum(keys(URGENCIES)).optional(),
  // agent-only fields below; the engine ignores them for plain requesters
  component: z.enum(keys(LANES)).optional(),
  priority: z.nativeEnum(TechPriority).optional(),
  priorityReason: optionalText(500),
  assigneeId: z.string().min(1).optional(),
  requestedForId: z.string().min(1).optional(),
  confidentiality: z.nativeEnum(Confidentiality).optional(),
  parentKey: optionalText(20),
  storyPoints: z.coerce.number().int().min(0).max(100).optional(),
  dueAt: z.coerce.date().optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  source: z.enum(SOURCES).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const updateItemSchema = z.object({
  assigneeId: z.string().min(1).nullable().optional(),
  // the assigner's instructions: which part of the work is the assignee's
  assignNote: optionalText(1000),
  priority: z.nativeEnum(TechPriority).optional(),
  priorityReason: optionalText(500),
  component: z.enum(keys(LANES)).optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  storyPoints: z.coerce.number().int().min(0).max(100).nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const transitionSchema = z.object({
  to: z.string().min(1).max(40),
  reason: optionalText(2000),
  resolutionCode: z.enum(keys(RESOLUTION_CODES)).optional(),
  resolutionNote: optionalText(4000),
  outcome: z.enum(keys(CHANGE_OUTCOMES)).optional(),
  pir: optionalText(4000),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Write something first").max(8000),
  internal: z.boolean().optional(),
});

export const linkSchema = z.object({
  toKey: z.string().trim().min(1).max(20),
  kind: z.enum(keys(LINK_KINDS)),
});

export const csatSchema = z.object({
  csat: z.coerce.number().int().min(1).max(5),
  comment: optionalText(1000),
});

export const techDocMetaSchema = z.object({
  title: z.string().trim().min(2, "Give the document a title").max(200),
  category: z.enum(keys(TECH_DOC_CATEGORIES)),
  confidentiality: z.nativeEnum(Confidentiality).default("L2"),
  itemKey: optionalText(20),
});

export const itemFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  types: z.array(z.nativeEnum(TechItemType)).optional(),
  status: z.enum(["open", "closed", "all"]).optional(),
  priority: z.nativeEnum(TechPriority).optional(),
  lane: z.enum(keys(LANES)).optional(),
  assignee: z.enum(["me", "unassigned"]).optional(),
  sla: z.enum(["breached", "at_risk"]).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
});

export type ItemFilters = z.infer<typeof itemFiltersSchema>;

// ───────────── registers ─────────────

export const createAssetSchema = z.object({
  tag: z.string().trim().min(2).max(40),
  kind: z.string().trim().min(1).max(40),
  make: optionalText(80),
  model: optionalText(80),
  serial: optionalText(80),
  location: optionalText(120),
  purchasedAt: z.coerce.date().optional(),
  cost: z.coerce.number().nonnegative().optional(),
  warrantyUntil: z.coerce.date().optional(),
});

export const assetMoveSchema = z.object({
  kind: z.enum(["ISSUE", "RETURN", "TRANSFER", "REPAIR", "RETIRE", "DISPOSE"]),
  toUserId: z.string().min(1).optional(),
  note: optionalText(1000),
});

export const createLicenceSchema = z.object({
  product: z.string().trim().min(2).max(120),
  vendor: optionalText(120),
  seats: z.coerce.number().int().min(1).max(100_000),
  costPerPeriod: z.coerce.number().nonnegative(),
  period: z.enum(["MONTHLY", "ANNUAL"]),
  renewsAt: z.coerce.date(),
  ownerId: z.string().min(1),
  autoRenew: z.boolean().optional(),
});

export const licenceActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ASSIGN"), userId: z.string().min(1) }),
  z.object({ action: z.literal("REVOKE"), userId: z.string().min(1) }),
  z.object({
    action: z.literal("RENEW"),
    renewsAt: z.coerce.date(),
    seats: z.coerce.number().int().min(1).max(100_000).optional(),
    costPerPeriod: z.coerce.number().nonnegative().optional(),
  }),
]);

/** URL search params → filters. Unknown values are dropped (unfiltered), never an error. */
export function filtersFromParams(sp: Record<string, string | string[] | undefined>, preset: Partial<ItemFilters> = {}): ItemFilters {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const types = one("types")
    ?.split(",")
    .filter((t): t is TechItemType => t in TechItemType);
  const pick = <K extends keyof ItemFilters>(k: K, v: unknown): Partial<ItemFilters> => {
    const r = itemFiltersSchema.shape[k].safeParse(v);
    return r.success && r.data !== undefined ? { [k]: r.data } : {};
  };
  return {
    ...preset,
    ...pick("q", one("q")),
    ...(types?.length ? { types } : {}),
    ...pick("status", one("status")),
    ...pick("priority", one("priority")),
    ...pick("lane", one("lane")),
    ...pick("assignee", one("assignee")),
    ...pick("sla", one("sla")),
    ...pick("days", one("days")),
  };
}
