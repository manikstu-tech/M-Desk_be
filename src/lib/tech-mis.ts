import { db } from "@/lib/db";
import { ALL_TERMINAL } from "@/lib/tech-catalogue";

// MIS & Data: a live catalogue of the platform's main datasets and a few quality checks on them.
// Counts only — no record contents leave their module.

export type DataCheck = { label: string; dataset: string; owner: string; failing: number; total: number };
export type Dataset = { name: string; holds: string; owner: string; records: number; newest: Date | null; quality: number | null };

export async function misCatalogue(now = new Date()) {
  const open = { status: { notIn: ALL_TERMINAL } };
  const [emp, empNoPhone, empNoCode, doc, hrDoc, hrPending, items, openItems, itemsNoCat, assets, inUse, inUseNoCustodian, assetsNoWarranty, licences, licencesLapsed, audit] =
    await Promise.all([
      db.employee.aggregate({ _count: true, _max: { createdAt: true } }),
      db.employee.count({ where: { phone: null } }),
      db.employee.count({ where: { code: null } }),
      db.document.aggregate({ _count: true, _max: { createdAt: true } }),
      db.hrDocument.aggregate({ _count: true, _max: { createdAt: true } }),
      db.hrDocument.count({ where: { verification: "PENDING" } }),
      db.techItem.aggregate({ _count: true, _max: { createdAt: true } }),
      db.techItem.count({ where: open }),
      db.techItem.count({ where: { ...open, category: null } }),
      db.asset.aggregate({ _count: true, _max: { createdAt: true } }),
      db.asset.count({ where: { status: "IN_USE" } }),
      db.asset.count({ where: { status: "IN_USE", custodianId: null } }),
      db.asset.count({ where: { warrantyUntil: null, status: { notIn: ["RETIRED", "DISPOSED"] } } }),
      db.licence.aggregate({ _count: true, _max: { createdAt: true } }),
      db.licence.count({ where: { renewsAt: { lt: now } } }),
      db.auditEvent.aggregate({ _count: true, _max: { createdAt: true } }),
    ]);

  const checks: DataCheck[] = [
    { label: "Employees without a mobile number", dataset: "Employees", owner: "HR", failing: empNoPhone, total: emp._count },
    { label: "Employees without an employee ID", dataset: "Employees", owner: "HR", failing: empNoCode, total: emp._count },
    { label: "Employee documents waiting for verification", dataset: "Employee documents", owner: "HR", failing: hrPending, total: hrDoc._count },
    { label: "Open tickets without a category", dataset: "Tickets and work items", owner: "Technology", failing: itemsNoCat, total: openItems },
    { label: "Devices in use without a custodian", dataset: "Devices", owner: "Technology", failing: inUseNoCustodian, total: inUse },
    { label: "Devices without a warranty date", dataset: "Devices", owner: "Technology", failing: assetsNoWarranty, total: assets._count },
    { label: "Licences past their renewal date", dataset: "Licences", owner: "Technology", failing: licencesLapsed, total: licences._count },
  ];

  const quality = (name: string) => {
    const mine = checks.filter((c) => c.dataset === name && c.total > 0);
    if (!mine.length) return null;
    const total = mine.reduce((n, c) => n + c.total, 0);
    const failing = mine.reduce((n, c) => n + c.failing, 0);
    return Math.round(((total - failing) / total) * 100);
  };

  const datasets: Dataset[] = [
    { name: "Employees", holds: "People, position, department, joining", owner: "HR", records: emp._count, newest: emp._max.createdAt, quality: quality("Employees") },
    { name: "Employee documents", holds: "ID proofs, certificates, verification", owner: "HR", records: hrDoc._count, newest: hrDoc._max.createdAt, quality: quality("Employee documents") },
    { name: "Documents", holds: "Files and versions in the library", owner: "Every department", records: doc._count, newest: doc._max.createdAt, quality: null },
    { name: "Tickets and work items", holds: "Service Desk, backlog, changes, MIS requests", owner: "Technology", records: items._count, newest: items._max.createdAt, quality: quality("Tickets and work items") },
    { name: "Devices", holds: "Phones, laptops, cameras, routers, custodians", owner: "Technology", records: assets._count, newest: assets._max.createdAt, quality: quality("Devices") },
    { name: "Licences", holds: "Subscriptions, seats, cost, renewals", owner: "Technology", records: licences._count, newest: licences._max.createdAt, quality: quality("Licences") },
    { name: "Audit log", holds: "Every recorded action, append-only", owner: "Automatic", records: audit._count, newest: audit._max.createdAt, quality: null },
  ];

  const checked = checks.filter((c) => c.total > 0);
  const totalChecked = checked.reduce((n, c) => n + c.total, 0);
  const score = totalChecked ? Math.round(((totalChecked - checked.reduce((n, c) => n + c.failing, 0)) / totalChecked) * 100) : null;
  const newest = datasets.reduce<Date | null>((d, s) => (s.newest && (!d || s.newest > d) ? s.newest : d), null);
  return { checks, datasets, score, failingChecks: checks.filter((c) => c.failing > 0).length, newest };
}
