import { Action } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { hrCan } from "./hr";
import { onboardingDocuments } from "./hr-catalogue";

// New-employee wizard: what every step page needs, and how far each step is.

export const WIZARD_STEPS = [
  { n: 1, title: "Basic Information", hint: "Personal & job details" },
  { n: 2, title: "Documents", hint: "Identity, education etc." },
  { n: 3, title: "Bank & Payroll", hint: "Salary & bank details" },
  { n: 4, title: "Policies & Compliance", hint: "Policies, agreements" },
  { n: 5, title: "Review & Create", hint: "Verify and submit" },
] as const;

export type StepState = "done" | "progress" | "pending";

/** Options for the step-1 selects. */
export async function wizardOptions() {
  const [positions, managers, locations, departments] = await Promise.all([
    db.position.findMany({
      where: { active: true },
      orderBy: [{ department: { number: "asc" } }, { title: "asc" }],
      select: { id: true, title: true, departmentId: true },
    }),
    db.user.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.employee.findMany({ distinct: ["location"], orderBy: { location: "asc" }, select: { location: true } }),
    db.department.findMany({ where: { active: true }, orderBy: { number: "asc" }, select: { id: true, name: true } }),
  ]);
  return {
    positions: positions.map((p) => ({ id: p.id, title: p.title, departmentId: p.departmentId })),
    managers: managers.map((m) => ({ value: m.id, label: m.name })),
    locations: locations.map((l) => l.location),
    // Only departments that have a position to choose.
    departments: departments.filter((d) => positions.some((p) => p.departmentId === d.id)).map((d) => ({ value: d.id, label: d.name })),
  };
}

export async function wizardRecord(session: AuthSession, id: string) {
  const emp = await db.employee.findUnique({
    where: { id },
    include: {
      position: { select: { title: true } },
      department: { select: { name: true } },
      manager: { select: { name: true } },
      documents: {
        orderBy: { createdAt: "desc" },
        include: { document: { select: { id: true, currentVersion: true, versions: { orderBy: { version: "desc" }, take: 1, select: { sizeBytes: true, mimeType: true } } } } },
      },
      policyAssignments: { include: { policy: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!emp) return null;

  const [canUpload, canApprove] = await Promise.all([hrCan(session, Action.UPLOAD), hrCan(session, Action.APPROVE)]);
  const docs = onboardingDocuments(emp.employmentType, emp.qualification);
  const have = new Set(emp.documents.filter((d) => d.verification !== "REJECTED").map((d) => d.label));
  const requiredDone = docs.required.filter((d) => have.has(d.label)).length;
  const acked = emp.policyAssignments.filter((a) => a.acknowledgedAt).length;
  const bankDone = !!(emp.bankAccountNumber && emp.bankIfsc && emp.compensation);

  const steps: Record<number, StepState> = {
    1: "done",
    2: requiredDone === docs.required.length && emp.qualification ? "done" : requiredDone > 0 ? "progress" : "pending",
    3: bankDone ? "done" : emp.bankAccountNumber || emp.compensation ? "progress" : "pending",
    4: emp.policyAssignments.length === 0 ? "pending" : acked === emp.policyAssignments.length ? "done" : "progress",
    5: emp.stage === "DRAFT" ? "pending" : "done",
  };
  return { emp, docs, requiredDone, acked, bankDone, steps, canUpload, canApprove };
}
