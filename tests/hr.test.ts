import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Action, RoleName } from "@prisma/client";
import { db } from "@/lib/db";
import type { AuthSession } from "@/lib/authorize";
import { activityLabel, hrWorkspace, initials, isFeedSafe, requireHr, timeAgo } from "@/lib/hr";
import {
  certificatesFor,
  CHECKLISTS,
  countLeaveDays,
  employeeCode,
  HR_NAV,
  HR_SLUG,
  LETTERS_FOR_TYPE,
  maskId,
  missingMandatoryDocs,
  renderTemplate,
  STAGE_MOVES,
} from "@/lib/hr-catalogue";
import { createEmployee, moveEmployee, transitionEmployee, updateEmployee } from "@/lib/hr-employees";
import { generateLetter, issueLetter, letterAction, letterSuggestions } from "@/lib/hr-letters";
import { deliverEmail, queueEmail } from "@/lib/hr-email";
import { pdfSafe, renderLetterPdf } from "@/lib/hr-pdf";
import { decideLeave, leaveBalance, submitLeave } from "@/lib/hr-time";
import { exportReport } from "@/lib/hr-reports";
import { employeeMoveSchema, employeeSchema } from "@/lib/hr-validation";

const outsiderEmail = "test-hr-outsider@mdesk.test";
const memberEmail = "test-hr-member@mdesk.test";
const createdUserIds: string[] = [];
const createdEmployeeIds: string[] = [];

async function sessionFor(email: string): Promise<AuthSession> {
  const user = await db.user.findUniqueOrThrow({ where: { email }, include: { role: true } });
  return {
    id: "test-session",
    token: "x",
    userId: user.id,
    expiresAt: new Date(Date.now() + 1e12),
    userAgent: null,
    createdAt: new Date(),
    user,
  } as unknown as AuthSession;
}

async function mkUser(email: string) {
  const role = await db.role.findUniqueOrThrow({ where: { name: RoleName.OFFICER } });
  const u = await db.user.create({ data: { email, name: email, passwordHash: "x", roleId: role.id } });
  createdUserIds.push(u.id);
  return u;
}

const DAY = 24 * 60 * 60 * 1000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

beforeAll(async () => {
  process.env.HR_COMPANY_NAME = "Test Co";
  process.env.HR_COMPANY_ADDRESS = "1 Test Street";
  process.env.HR_SIGNATORY = "Test Signatory";
  const hr = await db.department.findUniqueOrThrow({ where: { slug: HR_SLUG } });
  // pre-clean leftovers from a crashed run: fixed emails collide on unique(email)
  await db.departmentMembership.deleteMany({ where: { user: { email: { in: [outsiderEmail, memberEmail] } } } });
  await db.user.deleteMany({ where: { email: { in: [outsiderEmail, memberEmail] } } });
  await mkUser(outsiderEmail);
  const member = await mkUser(memberEmail);
  await db.departmentMembership.create({ data: { userId: member.id, departmentId: hr.id } });
});

afterAll(async () => {
  const ids = createdEmployeeIds;
  const letters = await db.generatedLetter.findMany({ where: { employeeId: { in: ids } }, select: { documentId: true } });
  const docIds = letters.flatMap((l) => (l.documentId ? [l.documentId] : []));
  await db.emailLog.deleteMany({ where: { employeeId: { in: ids } } });
  await db.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } });
  await db.attendanceRecord.deleteMany({ where: { employeeId: { in: ids } } });
  await db.hrDocument.deleteMany({ where: { employeeId: { in: ids } } });
  await db.generatedLetter.deleteMany({ where: { employeeId: { in: ids } } });
  await db.documentVersion.deleteMany({ where: { documentId: { in: docIds } } });
  await db.document.deleteMany({ where: { id: { in: docIds } } });
  await db.onboardingTask.deleteMany({ where: { employeeId: { in: ids } } });
  await db.employee.deleteMany({ where: { id: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.departmentMembership.deleteMany({ where: { userId: { in: createdUserIds } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

describe("HR catalogue rules", () => {
  it("follows the spec's navigation and onboarding status model", () => {
    expect(HR_NAV.flatMap((s) => s.items).map((n) => n.label)).toEqual([
      "HR Dashboard",
      "Employees",
      "Onboarding",
      "Letters & Documents",
      "Attendance & Leave",
      "Holiday Calendar",
      "Reports",
      "Settings & Audit",
    ]);
    // Sent / awaiting / accepted / expired are only reachable through letters and the scan.
    expect(STAGE_MOVES.APPROVED.find((m) => m.to === "SENT")?.system).toBe(true);
    expect(STAGE_MOVES.AWAITING_ACCEPTANCE.filter((m) => !m.system).map((m) => m.to)).toEqual(["WITHDRAWN"]);
    expect(STAGE_MOVES.PENDING_APPROVAL.find((m) => m.to === "APPROVED")?.approval).toBe(true);
    expect(STAGE_MOVES.EXITED).toEqual([]);
  });

  it("separates interns from permanent staff", () => {
    expect(employeeCode("INTERN", 7)).toBe("EA00007");
    expect(employeeCode("PERMANENT", 123)).toBe("EA00123");
    expect(LETTERS_FOR_TYPE.INTERN).toContain("INTERNSHIP_OFFER");
    expect(LETTERS_FOR_TYPE.INTERN).not.toContain("OFFER");
    expect(LETTERS_FOR_TYPE.PERMANENT).toContain("EMPLOYMENT_AGREEMENT");
    expect(CHECKLISTS.INTERN.some((c) => c.title.includes("mentor"))).toBe(true);
    expect(missingMandatoryDocs("INTERN", [{ label: "Identity proof", verification: "VERIFIED" }, { label: "Address proof", verification: "REJECTED" }]))
      .toEqual(["Address proof", "Education proof", "Signed internship agreement"]);
  });

  it("collects certificates up to the highest qualification and masks restricted numbers", () => {
    expect(certificatesFor("TENTH").map((c) => c.label)).toEqual(["10th certificate"]);
    expect(certificatesFor("GRADUATION").map((c) => c.label)).toEqual(["10th certificate", "12th certificate", "Graduation certificate"]);
    expect(certificatesFor("POST_GRADUATION")).toHaveLength(4);
    expect(maskId("123456789012")).toBe("XXXX XXXX 9012");
    expect(maskId(null)).toBe("—");
    // Aadhaar and a certificate stand in for the generic identity, address and education proofs.
    expect(
      missingMandatoryDocs("INTERN", [
        { label: "Aadhaar card", verification: "PENDING" },
        { label: "12th certificate", verification: "VERIFIED" },
      ]),
    ).toEqual(["Signed internship agreement"]);
  });

  it("validates Aadhaar, PAN, account and IFSC formats", () => {
    const base = {
      name: "A",
      email: "a@b.test",
      positionId: "p",
      location: "HQ",
      employmentType: "PERMANENT",
      joiningDate: "2026-11-01",
    };
    const ok = employeeSchema.parse({ ...base, aadhaarNumber: "1234 5678 9012", panNumber: "abcde1234f", bankAccountNumber: "123456789", bankIfsc: "sbin0001234" });
    expect(ok).toMatchObject({ aadhaarNumber: "123456789012", panNumber: "ABCDE1234F", bankIfsc: "SBIN0001234" });
    expect(employeeSchema.safeParse({ ...base, aadhaarNumber: "12345" }).success).toBe(false);
    expect(employeeSchema.safeParse({ ...base, panNumber: "1234567890" }).success).toBe(false);
    expect(employeeSchema.safeParse({ ...base, bankIfsc: "SBIN1001234" }).success).toBe(false);
  });

  it("renders type-specific clauses and reports unresolved placeholders", () => {
    const body = "Hi {{employee_name}}.{{#INTERN}} Stipend {{compensation}}.{{/INTERN}}{{#PERMANENT}} Probation {{probation_months}}.{{/PERMANENT}}";
    const intern = renderTemplate(body, { employee_name: "A", compensation: "INR 1" }, "INTERN");
    expect(intern).toEqual({ text: "Hi A. Stipend INR 1.", missing: [] });
    const perm = renderTemplate(body, { employee_name: "A" }, "PERMANENT");
    expect(perm.missing).toEqual(["probation_months"]);
    expect(perm.text).toContain("{{probation_months}}");
  });

  it("counts working leave days, skipping Sundays and holidays (Saturday is a working day)", () => {
    // Fri 6 Nov 2026 → Tue 10 Nov 2026, Sun 8 Nov off, Mon 9 Nov a holiday: Fri + Sat + Tue = 3
    expect(countLeaveDays(utc(2026, 11, 6), utc(2026, 11, 10), new Set(["2026-11-09"]))).toBe(3);
    expect(countLeaveDays(utc(2026, 11, 6), utc(2026, 11, 6), new Set(), true)).toBe(0.5);
    expect(countLeaveDays(utc(2026, 11, 7), utc(2026, 11, 8), new Set())).toBe(1);
    expect(countLeaveDays(utc(2026, 11, 8), utc(2026, 11, 8), new Set())).toBe(0);
  });

  it("produces PDFs with only encodable characters", async () => {
    expect(pdfSafe("₹ 5 – “ok” …")).toBe('INR  5 - "ok" ...');
    const pdf = await renderLetterPdf({
      companyName: "Test Co",
      companyAddress: "1 Test Street",
      title: "Offer Letter",
      reference: "REF-1",
      issueDate: "01 Jan 2026",
      body: "Line one.\n\nLine two ".repeat(200),
      signatory: "Signer",
      templateVersion: 1,
      draft: true,
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("formats feed helpers", () => {
    expect(isFeedSafe("DENIED_VIEW")).toBe(false);
    expect(activityLabel("HR_LETTER_APPROVED")).toBe("Letter approved");
    expect(activityLabel("WF_STARTED")).toBe("Workflow started");
    expect(initials("Riya Sharma")).toBe("RS");
    expect(timeAgo(new Date("2026-10-27T10:00:00Z"), new Date("2026-10-27T12:00:00Z"))).toBe("2 hours ago");
  });
});

describe("HR access", () => {
  it("lets HR members view but not change, and audits outsiders", async () => {
    const member = await sessionFor(memberEmail);
    expect(await hrWorkspace(member)).not.toBeNull();
    await expect(requireHr(member, Action.EDIT)).rejects.toMatchObject({ status: 403 });

    const outsider = await sessionFor(outsiderEmail);
    expect(await hrWorkspace(outsider)).toBeNull();
    const denied = await db.auditEvent.findFirst({ where: { actorId: outsider.user.id, action: "DENIED_VIEW", outcome: "DENIED" } });
    expect(denied).not.toBeNull();
  });
});

describe("HR end-to-end", () => {
  it("onboards an intern: record → approval → internship offer → acceptance → active → leave", async () => {
    const admin = await sessionFor("admin@manikstu.local");
    const position = await db.position.findFirstOrThrow({ where: { title: "Technology Intern" } });
    const joining = new Date(Date.now() - 2 * DAY);

    const emp = await createEmployee(admin, {
      name: "Test Intern",
      email: "TEST.INTERN@mdesk.test",
      positionId: position.id,
      managerId: admin.user.id,
      location: "Head office",
      employmentType: "INTERN",
      joiningDate: joining,
      endDate: new Date(joining.getTime() + 90 * DAY),
      compensation: 12000,
      workMode: "On-site",
      mentor: "Test Mentor",
    });
    createdEmployeeIds.push(emp.id);
    expect(emp.code).toMatch(/^EA\d{5}$/);
    expect(emp.email).toBe("test.intern@mdesk.test");
    expect(await db.onboardingTask.count({ where: { employeeId: emp.id } })).toBe(CHECKLISTS.INTERN.length);

    // Sending is a system move: it cannot be done by hand.
    await transitionEmployee(admin, emp.id, "PENDING_REVIEW");
    await transitionEmployee(admin, emp.id, "PENDING_APPROVAL");
    await transitionEmployee(admin, emp.id, "APPROVED");
    await expect(transitionEmployee(admin, emp.id, "SENT")).rejects.toMatchObject({ status: 409 });

    // Interns get the internship offer, never the permanent offer.
    await expect(generateLetter(admin, { employeeId: emp.id, type: "OFFER" })).rejects.toMatchObject({ status: 422 });
    const letter = await generateLetter(admin, { employeeId: emp.id, type: "INTERNSHIP_OFFER", acceptanceDays: 5 });
    await expect(letterAction(admin, letter.id, "SEND")).rejects.toMatchObject({ status: 409 }); // not approved yet
    await letterAction(admin, letter.id, "SUBMIT");
    await letterAction(admin, letter.id, "APPROVE");
    await letterAction(admin, letter.id, "SEND");

    const sent = await db.employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(sent.stage).toBe("AWAITING_ACCEPTANCE");
    expect(sent.acceptanceDeadline).not.toBeNull();
    const email = await db.emailLog.findFirstOrThrow({ where: { relatedId: letter.id } });
    expect(email.status).toBe("SENT_TO_PROVIDER"); // never "delivered" without a provider event
    const versions = await db.documentVersion.count({ where: { documentId: letter.documentId ?? "" } });
    expect(versions).toBe(2); // draft + approved render

    await letterAction(admin, letter.id, "ACCEPT", "Signed copy received");
    expect((await db.employee.findUniqueOrThrow({ where: { id: emp.id } })).stage).toBe("ACCEPTED");

    // Activation is blocked until every mandatory task is done.
    await transitionEmployee(admin, emp.id, "ONBOARDING_IN_PROGRESS");
    await expect(transitionEmployee(admin, emp.id, "ACTIVE")).rejects.toMatchObject({ status: 409 });
    await db.onboardingTask.updateMany({ where: { employeeId: emp.id }, data: { done: true } });
    await transitionEmployee(admin, emp.id, "ACTIVE");

    // Joining paperwork is suggested; "Send now" by a Super Admin approves and sends in one step.
    const due = await letterSuggestions({ id: emp.id });
    expect(due.map((d) => d.type)).toContain("NDA");
    expect(due.map((d) => d.type)).not.toContain("INTERNSHIP_OFFER"); // already accepted
    const nda = await issueLetter(admin, { employeeId: emp.id, type: "NDA", mode: "NOW" });
    expect(nda.outcome).toBe("SENT");
    expect((await db.generatedLetter.findUniqueOrThrow({ where: { id: nda.id } })).status).toBe("SENT");
    const later = await issueLetter(admin, { employeeId: emp.id, type: "JOINING", mode: "LATER" });
    expect(later.outcome).toBe("DRAFT");
    expect((await letterSuggestions({ id: emp.id })).map((d) => d.type)).not.toContain("JOINING");

    const events = await db.auditEvent.findMany({ where: { targetId: { in: [emp.id, letter.id] } }, select: { action: true } });
    const actions = events.map((e) => e.action);
    for (const a of ["HR_EMPLOYEE_CREATED", "HR_STAGE_CHANGED", "HR_LETTER_GENERATED", "HR_LETTER_APPROVED", "HR_LETTER_SENT", "HR_LETTER_ACCEPTED"]) {
      expect(actions).toContain(a);
    }

    // Leave follows the intern policy; balances count pending requests too.
    const { rows } = await leaveBalance(emp.id);
    const casual = rows.find((r) => r.type === "Casual");
    expect(casual).toBeDefined();
    const monday = new Date(Date.UTC(new Date().getUTCFullYear(), 11, 1));
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const req = await submitLeave(admin, {
      employeeId: emp.id,
      leaveType: "Casual",
      startDate: monday,
      endDate: new Date(monday.getTime() + 6 * DAY), // Mon–Sun → 5 working days
    });
    expect(Number(req.days)).toBe(5);
    await expect(
      submitLeave(admin, { employeeId: emp.id, leaveType: "Casual", startDate: monday, endDate: monday }),
    ).rejects.toMatchObject({ status: 409 }); // overlap
    await decideLeave(admin, req.id, "APPROVE");
    const after = (await leaveBalance(emp.id)).rows.find((r) => r.type === "Casual");
    expect(after?.used).toBe(5);
  });

  it("records existing employee IDs: entered, edited, unique, audited, and skipped by the generator", async () => {
    const admin = await sessionFor("admin@manikstu.local");
    const position = await db.position.findFirstOrThrow({ where: { title: "Technology Intern" } });
    const joining = new Date();
    const base = {
      positionId: position.id,
      location: "Head office",
      employmentType: "PERMANENT" as const,
      joiningDate: joining,
    };

    const existing = await createEmployee(admin, { ...base, code: "TEST/LEGACY-7", name: "Legacy One", email: "legacy.one@mdesk.test" });
    createdEmployeeIds.push(existing.id);
    expect(existing.code).toBe("TEST/LEGACY-7");

    // Duplicates are refused on create and on edit, even when only the case differs.
    const dup = employeeSchema.parse({ ...base, code: "test/legacy-7", name: "Legacy Dup", email: "legacy.dup@mdesk.test" });
    await expect(createEmployee(admin, dup)).rejects.toMatchObject({ status: 409 });
    const other = await createEmployee(admin, { ...base, name: "Legacy Two", email: "legacy.two@mdesk.test" });
    createdEmployeeIds.push(other.id);
    await expect(updateEmployee(admin, other.id, { code: "TEST/LEGACY-7", reason: "Recording issued ID" })).rejects.toMatchObject({ status: 409 });

    // Editing needs HR edit rights, then updates the ID and audits old and new values.
    const member = await sessionFor(memberEmail);
    await expect(updateEmployee(member, other.id, { code: "TEST-99", reason: "Recording issued ID" })).rejects.toMatchObject({ status: 403 });
    const edited = await updateEmployee(admin, other.id, { code: "TEST-99", reason: "Recording issued ID" });
    expect(edited.code).toBe("TEST-99");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { targetId: other.id, action: "HR_EMPLOYEE_UPDATED" } });
    expect(audit.detail).toMatchObject({ changes: { code: { from: other.code, to: "TEST-99" } }, reason: "Recording issued ID" });

    // A hand-entered ID that matches the next generated number doesn't block new records.
    // The squatter takes the next seq itself, so the record after it would be generated at last + 2.
    const [seq] = await db.$queryRaw<{ last_value: bigint }[]>`SELECT last_value FROM "Employee_seq_seq"`;
    const squatterCode = employeeCode("PERMANENT", Number(seq!.last_value) + 2);
    const squatter = await createEmployee(admin, { ...base, code: squatterCode, name: "Legacy Three", email: "legacy.three@mdesk.test" });
    createdEmployeeIds.push(squatter.id);
    const generated = await createEmployee(admin, { ...base, name: "Legacy Four", email: "legacy.four@mdesk.test" });
    createdEmployeeIds.push(generated.id);
    expect(generated.code).toBe(employeeCode("PERMANENT", Number(seq!.last_value) + 3));

    // Format rules for entered IDs.
    expect(employeeSchema.safeParse({ ...base, code: "bad id!", name: "X", email: "x@mdesk.test" }).success).toBe(false);
    expect(employeeSchema.safeParse({ ...base, code: "   ", name: "X", email: "x@mdesk.test" }).success).toBe(false);
  });

  it("promotes and transfers: position and department move together, kept in history", async () => {
    const admin = await sessionFor("admin@manikstu.local");
    const start = await db.position.findFirstOrThrow({ where: { title: "Technology Intern" } });
    const techRole = await db.position.findFirstOrThrow({ where: { title: "Software Engineer" } });
    const finance = await db.department.findUniqueOrThrow({ where: { slug: "finance-accounts" } });
    const financeRole = await db.position.findFirstOrThrow({ where: { title: "Accounts Executive" } });
    const newTitle = `Test Lead ${Date.now()}`;
    const emp = await createEmployee(admin, {
      name: "Moving Person",
      email: "moving.person@mdesk.test",
      positionId: start.id,
      location: "Head office",
      employmentType: "PERMANENT",
      joiningDate: new Date(),
    });
    createdEmployeeIds.push(emp.id);

    // Promotion inside the department.
    const promoted = await moveEmployee(admin, emp.id, { kind: "PROMOTION", departmentId: start.departmentId, positionId: techRole.id, reason: "Annual review" });
    expect(promoted.positionId).toBe(techRole.id);
    expect(promoted.departmentId).toBe(start.departmentId);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { targetId: emp.id, action: "HR_EMPLOYEE_PROMOTED" } });
    expect(audit.detail).toMatchObject({
      from: { position: "Technology Intern" },
      to: { position: "Software Engineer" },
      reason: "Annual review",
    });

    // Transfer: the department follows the position; a transfer must actually change department.
    await expect(
      moveEmployee(admin, emp.id, { kind: "TRANSFER", departmentId: start.departmentId, positionId: start.id, reason: "No move" }),
    ).rejects.toMatchObject({ status: 422 });
    const moved = await moveEmployee(admin, emp.id, { kind: "TRANSFER", departmentId: finance.id, positionId: financeRole.id, managerId: admin.user.id, reason: "Finance needs cover" });
    expect(moved.departmentId).toBe(finance.id);
    expect(moved.managerId).toBe(admin.user.id);
    expect(await db.auditEvent.count({ where: { targetId: emp.id, action: "HR_EMPLOYEE_TRANSFERRED" } })).toBe(1);

    // Mismatches and no-ops are refused.
    await expect(
      moveEmployee(admin, emp.id, { kind: "ROLE_CHANGE", departmentId: finance.id, positionId: techRole.id, reason: "Wrong department" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      moveEmployee(admin, emp.id, { kind: "ROLE_CHANGE", departmentId: finance.id, positionId: financeRole.id, reason: "Same position" }),
    ).rejects.toMatchObject({ status: 409 });

    // A position the department doesn't have yet is created as part of the move, and reused next time.
    const created = await moveEmployee(admin, emp.id, { kind: "PROMOTION", departmentId: finance.id, newPositionTitle: newTitle, grade: "E4", reason: "New role" });
    const position = await db.position.findUniqueOrThrow({ where: { id: created.positionId } });
    expect(position).toMatchObject({ title: newTitle, departmentId: finance.id, grade: "E4" });
    await expect(
      moveEmployee(admin, emp.id, { kind: "ROLE_CHANGE", departmentId: finance.id, newPositionTitle: newTitle, reason: "Same title again" }),
    ).rejects.toMatchObject({ status: 409 });

    // Rights and closed records.
    const member = await sessionFor(memberEmail);
    await expect(
      moveEmployee(member, emp.id, { kind: "PROMOTION", departmentId: finance.id, positionId: financeRole.id, reason: "No rights" }),
    ).rejects.toMatchObject({ status: 403 });
    await db.employee.update({ where: { id: emp.id }, data: { stage: "EXITED" } });
    await expect(
      moveEmployee(admin, emp.id, { kind: "PROMOTION", departmentId: finance.id, positionId: financeRole.id, reason: "Already left" }),
    ).rejects.toMatchObject({ status: 409 });

    // The form must send exactly one of an existing or a new position.
    expect(employeeMoveSchema.safeParse({ kind: "PROMOTION", departmentId: "d", reason: "Neither" }).success).toBe(false);
    expect(employeeMoveSchema.safeParse({ kind: "PROMOTION", departmentId: "d", positionId: "p", newPositionTitle: "t", reason: "Both" }).success).toBe(false);

    await db.employee.update({ where: { id: emp.id }, data: { positionId: start.id, departmentId: start.departmentId } });
    await db.position.delete({ where: { id: position.id } });
  });

  it("refuses letters with unresolved fields", async () => {
    const admin = await sessionFor("admin@manikstu.local");
    const position = await db.position.findFirstOrThrow({ where: { title: "Software Engineer" } });
    const emp = await createEmployee(admin, {
      name: "Test Permanent",
      email: "test.perm@mdesk.test",
      positionId: position.id,
      location: "Head office",
      employmentType: "PERMANENT",
      joiningDate: new Date(Date.now() + 30 * DAY),
    });
    createdEmployeeIds.push(emp.id);
    // No manager, compensation, probation or work mode yet → the offer cannot be generated.
    await expect(generateLetter(admin, { employeeId: emp.id, type: "OFFER" })).rejects.toMatchObject({ status: 422 });
  });

  it("fails undeliverable email without pretending it was sent", async () => {
    const empId = createdEmployeeIds[0];
    const queued = await db.$transaction((tx) =>
      queueEmail(tx, { employeeId: empId, relatedType: "Test", recipient: "not-an-address", subject: "x", body: "y" }),
    );
    expect(await deliverEmail(queued.id)).toBe("FAILED");
    const row = await db.emailLog.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.lastError).toBe("Invalid recipient address");
    expect(row.sentAt).toBeNull();
  });

  it("audits report exports with filters and row counts", async () => {
    const admin = await sessionFor("admin@manikstu.local");
    const res = await exportReport(admin, "employee-master", { employmentType: "INTERN" });
    expect(res?.csv.split("\r\n")[0]).toContain("Employee ID");
    expect(res?.csv).not.toContain("12000"); // compensation is never exported
    const audit = await db.auditEvent.findFirst({
      where: { action: "HR_REPORT_EXPORTED", targetId: "employee-master", actorId: admin.user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });
});
