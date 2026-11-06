import { Action } from "@prisma/client";
import type { z } from "zod";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { createDocument } from "./documents";
import { ApiError } from "./validation";
import { hrAudit, hrDept, requireHr } from "./hr";
import type { companyPolicySchema } from "./hr-validation";

// Company policies (new-employee step 4): HR publishes them, assigns them to a
// person, and the person acknowledges them from My HR. HR can also record a
// signed paper copy for someone whose account is not linked yet.

export function activePolicies() {
  return db.companyPolicy.findMany({ where: { active: true }, orderBy: [{ mandatory: "desc" }, { title: "asc" }] });
}

export async function publishPolicy(session: AuthSession, input: z.infer<typeof companyPolicySchema>, file?: File) {
  const dept = await requireHr(session, Action.EDIT);
  // Policies are for everyone to read, so the PDF goes in the library as L1.
  const doc = file
    ? await createDocument(session, { title: `${input.title} (${input.version})`, departmentId: dept.id, confidentiality: "L1" }, file)
    : null;
  return db.$transaction(async (tx) => {
    const policy = await tx.companyPolicy.create({
      data: { ...input, documentId: doc?.id, createdById: session.user.id },
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_POLICY_PUBLISHED",
      targetType: "CompanyPolicy",
      targetId: policy.id,
      detail: { title: policy.title, version: policy.version, mandatory: policy.mandatory },
    });
    return policy;
  });
}

export async function retirePolicy(session: AuthSession, id: string) {
  const dept = await requireHr(session, Action.EDIT);
  const policy = await db.companyPolicy.findUnique({ where: { id } });
  if (!policy) throw new ApiError(404, "NOT_FOUND", "Policy not found");
  if (!policy.active) throw new ApiError(409, "CONFLICT", "This policy is already retired");
  return db.$transaction(async (tx) => {
    const row = await tx.companyPolicy.update({ where: { id }, data: { active: false } });
    await hrAudit(tx, session, dept.id, {
      action: "HR_POLICY_RETIRED",
      targetType: "CompanyPolicy",
      targetId: id,
      detail: { title: policy.title, version: policy.version },
    });
    return row;
  });
}

/** Sets the person's assigned policies; acknowledged ones are kept even if unticked (the record stands). */
export async function assignPolicies(session: AuthSession, employeeId: string, policyIds: string[]) {
  const dept = await requireHr(session, Action.EDIT);
  const emp = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  const wanted = [...new Set(policyIds)];
  const found = await db.companyPolicy.count({ where: { id: { in: wanted }, active: true } });
  if (found !== wanted.length) throw new ApiError(422, "VALIDATION", "Choose active policies only");

  return db.$transaction(async (tx) => {
    const current = await tx.policyAssignment.findMany({ where: { employeeId } });
    const have = new Set(current.map((a) => a.policyId));
    const added = wanted.filter((p) => !have.has(p));
    const removed = current.filter((a) => !wanted.includes(a.policyId) && !a.acknowledgedAt).map((a) => a.id);
    if (added.length) {
      await tx.policyAssignment.createMany({ data: added.map((policyId) => ({ policyId, employeeId, assignedById: session.user.id })) });
    }
    if (removed.length) await tx.policyAssignment.deleteMany({ where: { id: { in: removed } } });
    if (added.length || removed.length) {
      await hrAudit(tx, session, dept.id, {
        action: "HR_POLICIES_ASSIGNED",
        targetType: "Employee",
        targetId: employeeId,
        detail: { added: added.length, removed: removed.length },
      });
    }
    return { added: added.length, removed: removed.length };
  });
}

/** The person acknowledges their own policy; anyone else needs HR edit rights (recording a signed copy). */
export async function acknowledgePolicy(session: AuthSession, assignmentId: string) {
  const a = await db.policyAssignment.findUnique({
    where: { id: assignmentId },
    include: { employee: { select: { userId: true } }, policy: { select: { title: true, version: true } } },
  });
  if (!a) throw new ApiError(404, "NOT_FOUND", "Policy assignment not found");
  const self = a.employee.userId === session.user.id;
  const dept = self ? await hrDept() : await requireHr(session, Action.EDIT);
  if (a.acknowledgedAt) throw new ApiError(409, "CONFLICT", "This policy is already acknowledged");

  return db.$transaction(async (tx) => {
    const row = await tx.policyAssignment.update({
      where: { id: assignmentId },
      data: { acknowledgedAt: new Date(), acknowledgedById: session.user.id },
    });
    await hrAudit(tx, session, dept.id, {
      action: self ? "HR_POLICY_ACKNOWLEDGED" : "HR_POLICY_ACK_RECORDED",
      targetType: "PolicyAssignment",
      targetId: assignmentId,
      detail: { employeeId: a.employeeId, policy: a.policy.title, version: a.policy.version },
    });
    return row;
  });
}
