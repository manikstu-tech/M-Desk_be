import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import type { AuthSession } from "@/lib/authorize";
import { HR_SLUG, missingMandatoryDocs, onboardingDocuments } from "@/lib/hr-catalogue";
import { createEmployee, transitionEmployee, updateEmployee } from "@/lib/hr-employees";
import { acknowledgePolicy, assignPolicies, publishPolicy, retirePolicy } from "@/lib/hr-policies";
import { companyPolicySchema, employeeSchema, employeeUpdateSchema } from "@/lib/hr-validation";

// New-employee wizard: personal / payroll fields, the draft payroll rule, and company policies.

const editorEmail = "test-ne-editor@mdesk.test";
const joinerEmail = "test-ne-joiner@mdesk.test";
const outsiderEmail = "test-ne-outsider@mdesk.test";
const createdUserIds: string[] = [];
const createdEmployeeIds: string[] = [];
const createdPolicyIds: string[] = [];

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return { id: "s", token: "x", userId: user.id, expiresAt: new Date(Date.now() + 1e12), userAgent: null, createdAt: new Date(), user } as unknown as AuthSession;
}

async function mkUser(email: string) {
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
  createdUserIds.push(u.id);
  return u;
}

async function cleanup() {
  const emails = [editorEmail, joinerEmail, outsiderEmail];
  const emps = await db.employee.findMany({ where: { OR: [{ id: { in: createdEmployeeIds } }, { email: { endsWith: "@ne.mdesk.test" } }] }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  await db.policyAssignment.deleteMany({ where: { OR: [{ employeeId: { in: ids } }, { policyId: { in: createdPolicyIds } }] } });
  await db.companyPolicy.deleteMany({ where: { OR: [{ id: { in: createdPolicyIds } }, { title: { startsWith: "TEST-NE " } }] } });
  await db.onboardingTask.deleteMany({ where: { employeeId: { in: ids } } });
  await db.employee.deleteMany({ where: { id: { in: ids } } });
  await db.delegationGrant.deleteMany({ where: { user: { email: { in: emails } } } });
  await db.departmentMembership.deleteMany({ where: { user: { email: { in: emails } } } });
  await db.notification.deleteMany({ where: { user: { email: { in: emails } } } });
  await db.user.deleteMany({ where: { email: { in: emails } } });
}

let admin: AuthSession;
let editor: AuthSession;
let positionId: string;

beforeAll(async () => {
  await cleanup(); // leftovers from a crashed run
  const hr = await db.department.findUniqueOrThrow({ where: { slug: HR_SLUG } });
  const ed = await mkUser(editorEmail);
  await mkUser(joinerEmail);
  await mkUser(outsiderEmail);
  await db.departmentMembership.create({ data: { userId: ed.id, departmentId: hr.id } });
  // HR edit rights only — no APPROVE.
  await db.delegationGrant.create({ data: { userId: ed.id, departmentId: hr.id, action: "EDIT", grantedById: ed.id, reason: "new-employee test" } });
  admin = await sessionFor("admin@manikstu.local");
  editor = await sessionFor(editorEmail);
  positionId = (await db.position.findFirstOrThrow({ where: { active: true } })).id;
});

afterAll(cleanup);

// Own IDs, so these records never race other test files for the next generated number.
let n = 0;
const base = () =>
  employeeSchema.parse({
    code: `TEST-NE-${Date.now().toString(36)}-${++n}`.toUpperCase(),
    name: "NE Joiner",
    email: `joiner-${Date.now()}@ne.mdesk.test`,
    positionId,
    location: "Head office",
    employmentType: "PERMANENT",
    joiningDate: "2026-12-01",
  });

describe("personal and payroll fields", () => {
  it("validates the new formats", () => {
    expect(() => employeeUpdateSchema.parse({ reason: "set-up", uanNumber: "1234" })).toThrow(/UAN/);
    expect(() => employeeUpdateSchema.parse({ reason: "set-up", payrollStartMonth: "2026-13" })).toThrow(/Payroll start month/);
    expect(() => employeeUpdateSchema.parse({ reason: "set-up", gender: "Unknown" })).toThrow();
    const ok = employeeUpdateSchema.parse({ reason: "set-up", uanNumber: "1001 2345 6789", esiNumber: "3100123456", pfApplicable: true });
    expect(ok.uanNumber).toBe("100123456789");
  });

  it("stores them on create, and keeps sensitive values out of the audit log", async () => {
    const emp = await createEmployee(admin, { ...base(), fatherName: "Ramesh", dateOfBirth: new Date("1998-05-04"), gender: "Female", remarks: "Joins after notice" });
    createdEmployeeIds.push(emp.id);
    expect(emp).toMatchObject({ fatherName: "Ramesh", gender: "Female", remarks: "Joins after notice" });

    await updateEmployee(admin, emp.id, employeeUpdateSchema.parse({ reason: "set-up", dateOfBirth: "1998-05-05", personalEmail: "me@example.com" }));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { targetId: emp.id, action: "HR_EMPLOYEE_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit.detail)).not.toContain("1998");
    expect(JSON.stringify(audit.detail)).not.toContain("me@example.com");
  });

  it("lets an HR editor set payroll while the record is a draft, then needs an approver", async () => {
    const emp = await createEmployee(editor, base());
    createdEmployeeIds.push(emp.id);
    const payroll = employeeUpdateSchema.parse({ reason: "set-up", compensation: 720000, bankAccountNumber: "123456789012", salaryStructure: "Standard Employee Structure" });
    await expect(updateEmployee(editor, emp.id, payroll)).resolves.toBeTruthy();

    await transitionEmployee(editor, emp.id, "PENDING_REVIEW");
    await expect(updateEmployee(editor, emp.id, employeeUpdateSchema.parse({ reason: "later", payGrade: "E3" }))).rejects.toMatchObject({ status: 403 });
    // Non-payroll edits still work for the editor.
    await expect(updateEmployee(editor, emp.id, employeeUpdateSchema.parse({ reason: "later", remarks: "Updated" }))).resolves.toBeTruthy();
  });
});

describe("onboarding document list", () => {
  it("covers every mandatory document once the required files are uploaded", () => {
    for (const type of ["PERMANENT", "INTERN", "CONTRACT"] as const) {
      const { required } = onboardingDocuments(type, "GRADUATION");
      const docs = required.map((d) => ({ label: d.label, verification: "PENDING" }));
      expect(missingMandatoryDocs(type, docs)).toEqual([]);
    }
  });

  it("lists education certificates up to the highest qualification", () => {
    const labels = onboardingDocuments("INTERN", "TWELFTH").required.map((d) => d.label);
    expect(labels).toContain("10th certificate");
    expect(labels).toContain("12th certificate");
    expect(labels).not.toContain("Graduation certificate");
  });
});

describe("company policies", () => {
  it("publishes, assigns, acknowledges and retires with the right permissions", async () => {
    const input = companyPolicySchema.parse({ title: "TEST-NE Code of Conduct", summary: "Values and behaviour", body: "Treat everyone with respect at all times." });
    await expect(publishPolicy(await sessionFor(outsiderEmail), input)).rejects.toMatchObject({ status: 403 });
    const coc = await publishPolicy(editor, input);
    const leave = await publishPolicy(editor, { ...input, title: "TEST-NE Leave Policy", mandatory: false });
    createdPolicyIds.push(coc.id, leave.id);

    const joiner = await db.user.findUniqueOrThrow({ where: { email: joinerEmail } });
    const emp = await createEmployee(editor, base());
    createdEmployeeIds.push(emp.id);
    await db.employee.update({ where: { id: emp.id }, data: { userId: joiner.id } });

    await expect(assignPolicies(await sessionFor(outsiderEmail), emp.id, [coc.id])).rejects.toMatchObject({ status: 403 });
    expect(await assignPolicies(editor, emp.id, [coc.id, leave.id])).toEqual({ added: 2, removed: 0 });

    const [a, b] = await db.policyAssignment.findMany({ where: { employeeId: emp.id }, orderBy: { createdAt: "asc" } });
    // Someone else can't acknowledge for the person without HR rights…
    await expect(acknowledgePolicy(await sessionFor(outsiderEmail), a.id)).rejects.toMatchObject({ status: 403 });
    // …the person can, once…
    await acknowledgePolicy(await sessionFor(joinerEmail), a.id);
    await expect(acknowledgePolicy(await sessionFor(joinerEmail), a.id)).rejects.toMatchObject({ status: 409 });
    // …and HR can record a signed paper copy.
    await acknowledgePolicy(editor, b.id);
    const actions = (await db.auditEvent.findMany({ where: { targetId: { in: [a.id, b.id] } }, select: { action: true } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["HR_POLICY_ACKNOWLEDGED", "HR_POLICY_ACK_RECORDED"]));

    // Unticking an acknowledged policy keeps the record; retired policies can't be assigned.
    expect(await assignPolicies(editor, emp.id, [])).toEqual({ added: 0, removed: 0 });
    await retirePolicy(editor, leave.id);
    await expect(assignPolicies(editor, emp.id, [leave.id])).rejects.toMatchObject({ status: 422 });
    await expect(retirePolicy(editor, leave.id)).rejects.toMatchObject({ status: 409 });
  });
});
