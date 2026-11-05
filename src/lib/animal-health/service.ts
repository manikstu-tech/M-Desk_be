// Animal Health & Veterinary Services — service layer.
//
// Every data-driven component reads through these functions (never by importing
// records directly). No backend is connected yet, so each function resolves an
// EMPTY, backend-ready payload: KPI cards keep their titles but report
// "Not available", and every list/series is empty so the UI shows its
// unavailable / empty states. No demonstration data is returned anywhere.
//
// When a real backend exists, replace each body with a fetch() against
// `${API_BASE}/animal-health/...` and keep these return shapes identical — no
// component or page will need to change.
//
// Base URL follows the Next.js convention (NOT Vite's VITE_*). Client-exposed
// env vars must be prefixed NEXT_PUBLIC_.

import * as S from "./structure";
import type {
  FpoData,
  HealthCasesData,
  InventoryData,
  KpiMetric,
  OverviewData,
  VaccinationData,
} from "./types";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Simulated network latency so skeleton loaders are visible. */
const LATENCY_MS = 400;
const wait = (ms = LATENCY_MS) => new Promise<void>((r) => setTimeout(r, ms));

/** KPI cards that keep their titles but report no value until the backend fills them. */
const blankKpis = (labels: readonly string[]): KpiMetric[] =>
  labels.map((label) => ({ label, value: "--", sub: "Not available", unavailable: true }));

// Example of the real implementation shape (kept for the integration guide):
//   async function get<T>(path: string): Promise<T> {
//     const res = await fetch(`${API_BASE}/animal-health${path}`, { headers: authHeaders() });
//     if (!res.ok) throw new Error(`Request failed (${res.status})`);
//     return (await res.json()) as T;
//   }

export const animalHealthService = {
  async getOverview(): Promise<OverviewData> {
    await wait();
    return { kpis: blankKpis(S.OVERVIEW_KPI_LABELS), coverage: [], livestockCoverage: [], schedules: [], schedulesTotal: 0, alerts: [] };
  },

  async getVaccination(): Promise<VaccinationData> {
    await wait();
    return { kpis: blankKpis(S.VACCINATION_KPI_LABELS), drives: [], drivesTotal: 0, districtCoverage: [] };
  },

  async getHealthCases(): Promise<HealthCasesData> {
    await wait();
    return { kpis: blankKpis(S.HEALTH_KPI_LABELS), cases: [], casesTotal: 0, severity: [], outbreaks: [] };
  },

  async getFpoCamps(): Promise<FpoData> {
    await wait();
    return { kpis: blankKpis(S.FPO_KPI_LABELS), fpos: [], fposTotal: 0, upcoming: [] };
  },

  async getInventory(): Promise<InventoryData> {
    await wait();
    return { kpis: blankKpis(S.INVENTORY_KPI_LABELS), categories: [], items: [], itemsTotal: 0 };
  },
};

export type AnimalHealthService = typeof animalHealthService;
