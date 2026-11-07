import type { EmploymentType, LetterType, PrismaClient } from "@prisma/client";

// HR module starter data (functional requirements v2.0). Everything here is a
// SAMPLE for development: the spec (§16) leaves positions, entitlements,
// holidays and letter wording for HR and Legal to confirm before production.
// Re-run safe: rows are only created when missing; nothing HR edits is overwritten.

const POSITIONS: { title: string; dept: string; grade?: string }[] = [
  { title: "HR Executive", dept: "hr-administration", grade: "E2" },
  { title: "HR Intern", dept: "hr-administration" },
  { title: "Software Engineer", dept: "technology-mis", grade: "E2" },
  { title: "Technology Intern", dept: "technology-mis" },
  { title: "Accounts Executive", dept: "finance-accounts", grade: "E1" },
  { title: "Field Officer", dept: "field-operations-beneficiary-management", grade: "E1" },
  { title: "Veterinary Officer", dept: "animal-health-veterinary-services", grade: "E3" },
];

const CLOSE = "\n\nWe look forward to working with you.\n\nThis letter is issued under reference {{reference}} on {{issue_date}}.";

const TEMPLATES: { type: LetterType; employmentType: EmploymentType | null; name: string; body: string }[] = [
  {
    type: "OFFER",
    employmentType: null,
    name: "Offer letter (sample)",
    body:
      "Dear {{employee_name}},\n\nWe are pleased to offer you the position of {{position}} in {{department}} at {{company_name}}, based at {{location}} ({{work_mode}}). " +
      "Your proposed joining date is {{start_date}} and you will report to {{manager}}.\n\n" +
      "Your compensation will be {{compensation}}." +
      "{{#PERMANENT}}\n\nYou will be on probation for {{probation_months}} months from your date of joining.{{/PERMANENT}}" +
      "{{#CONTRACT}}\n\nThis is a fixed-term engagement ending on {{end_date}}.{{/CONTRACT}}" +
      "\n\nPlease confirm your acceptance by {{acceptance_deadline}}. This offer is subject to verification of your documents." +
      CLOSE,
  },
  {
    type: "INTERNSHIP_OFFER",
    employmentType: "INTERN",
    name: "Internship offer & agreement (sample)",
    body:
      "Dear {{employee_name}},\n\nWe are pleased to offer you an internship as {{position}} in {{department}} at {{company_name}}, " +
      "from {{start_date}} to {{end_date}}, based at {{location}} ({{work_mode}}).\n\n" +
      "Your mentor will be {{mentor}} and you will report to {{manager}}. You will receive a stipend of {{compensation}}.\n\n" +
      "Completion of the internship is subject to satisfactory attendance, completion of the agreed learning plan and a final review by your mentor. " +
      "An internship completion letter is issued on successful completion.\n\nPlease confirm your acceptance by {{acceptance_deadline}}." +
      CLOSE,
  },
  {
    type: "APPOINTMENT",
    employmentType: null,
    name: "Appointment letter (sample)",
    body:
      "Dear {{employee_name}},\n\nFurther to your acceptance of our offer, we confirm your appointment as {{position}} in {{department}}, " +
      "effective {{start_date}}, employee ID {{employee_id}}. Your place of work is {{location}} and you will report to {{manager}}.\n\n" +
      "Your terms of employment, including compensation of {{compensation}}, are as set out in your employment agreement and company policies." +
      CLOSE,
  },
  {
    type: "EMPLOYMENT_AGREEMENT",
    employmentType: "PERMANENT",
    name: "Permanent employment agreement (sample)",
    body:
      "This agreement is between {{company_name}} and {{employee_name}} (employee ID {{employee_id}}).\n\n" +
      "1. Position: {{position}}, {{department}}, reporting to {{manager}}.\n2. Commencement: {{start_date}}.\n" +
      "3. Probation: {{probation_months}} months.\n4. Compensation: {{compensation}}.\n5. Place of work: {{location}} ({{work_mode}}).\n\n" +
      "The employee agrees to abide by the company's policies as amended from time to time." +
      CLOSE,
  },
  {
    type: "NDA",
    employmentType: null,
    name: "Confidentiality agreement (sample)",
    body:
      "I, {{employee_name}} ({{employee_id}}), joining {{company_name}} as {{position}}, agree to keep confidential all non-public information " +
      "I receive in the course of my work, to use it only for company purposes, and to return or destroy it when my engagement ends.\n\n" +
      "This obligation continues after my engagement ends." +
      CLOSE,
  },
  {
    type: "JOINING",
    employmentType: null,
    name: "Joining confirmation (sample)",
    body:
      "Dear {{employee_name}},\n\nThis confirms that you joined {{company_name}} as {{position}} in {{department}} on {{start_date}}. " +
      "Your employee ID is {{employee_id}}." +
      CLOSE,
  },
  {
    type: "POLICY_ACK",
    employmentType: null,
    name: "Policy acknowledgement (sample)",
    body:
      "I, {{employee_name}} ({{employee_id}}), confirm that I have received, read and understood the code of conduct, information security " +
      "and workplace policies of {{company_name}}, and agree to comply with them." +
      CLOSE,
  },
  {
    type: "EXPERIENCE",
    employmentType: null,
    name: "Experience letter (sample)",
    body:
      "To whom it may concern,\n\nThis is to certify that {{employee_name}} (employee ID {{employee_id}}) worked with {{company_name}} as " +
      "{{position}} in {{department}} from {{start_date}} to {{end_date}}.\n\nWe wish them success in their future endeavours." +
      CLOSE,
  },
  {
    type: "INTERNSHIP_COMPLETION",
    employmentType: "INTERN",
    name: "Internship completion letter (sample)",
    body:
      "To whom it may concern,\n\nThis is to certify that {{employee_name}} completed an internship with {{company_name}} as {{position}} in " +
      "{{department}} from {{start_date}} to {{end_date}}, under the mentorship of {{mentor}}." +
      CLOSE,
  },
  {
    type: "RELIEVING",
    employmentType: null,
    name: "Relieving letter (sample)",
    body:
      "Dear {{employee_name}},\n\nThis is to confirm that you have been relieved of your duties as {{position}} at {{company_name}} " +
      "with effect from {{end_date}}, after completion of the exit clearance process." +
      CLOSE,
  },
];

// Company decision (HR Data doc): same entitlement for interns and permanent staff, no carry-forward,
// half-day leave allowed. Approval is manager first, then HR.
const COMPANY_LEAVE = [
  { type: "Earned", days: 12 },
  { type: "Sick", days: 10 },
  { type: "Casual", days: 8 },
  { type: "Optional Holiday", days: 2 },
];
const POLICIES: { employmentType: EmploymentType; name: string; approval: string; allowances: { type: string; days: number }[] }[] = (
  ["PERMANENT", "INTERN", "CONTRACT"] as EmploymentType[]
).map((employmentType) => ({
  employmentType,
  name: "Company leave policy",
  approval: "Line manager, then HR",
  allowances: COMPANY_LEAVE,
}));

// National holidays are fixed dates; the company days and the year-end break are samples.
function holidays(year: number) {
  const d = (m: number, day: number) => new Date(Date.UTC(year, m - 1, day));
  const list: { name: string; date: Date; endDate?: Date; category: "PUBLIC" | "COMPANY" | "OPTIONAL" | "SHUTDOWN" }[] = [
    { name: "Republic Day", date: d(1, 26), category: "PUBLIC" },
    { name: "Company foundation day (sample)", date: d(4, 1), category: "COMPANY" },
    { name: "Independence Day", date: d(8, 15), category: "PUBLIC" },
    { name: "Gandhi Jayanti", date: d(10, 2), category: "PUBLIC" },
    { name: "Christmas Day", date: d(12, 25), category: "COMPANY" },
    { name: "Year-end break (sample)", date: d(12, 28), endDate: d(12, 31), category: "SHUTDOWN" },
  ];
  return list;
}

export async function seedHr(prisma: PrismaClient, adminId: string) {
  const dept = (slug: string) => prisma.department.findUniqueOrThrow({ where: { slug }, select: { id: true } });

  for (const p of POSITIONS) {
    const { id } = await dept(p.dept);
    await prisma.position.upsert({
      where: { title_departmentId: { title: p.title, departmentId: id } },
      update: {},
      create: { title: p.title, departmentId: id, grade: p.grade },
    });
  }

  for (const t of TEMPLATES) {
    const exists = await prisma.letterTemplate.findFirst({ where: { type: t.type, employmentType: t.employmentType } });
    if (!exists) {
      await prisma.letterTemplate.create({
        data: { ...t, version: 1, status: "APPROVED", createdById: adminId, approvedById: adminId, approvedAt: new Date() },
      });
    }
  }

  const year = new Date().getUTCFullYear();
  for (const p of POLICIES) {
    const exists = await prisma.leavePolicy.findFirst({ where: { employmentType: p.employmentType } });
    if (!exists) {
      await prisma.leavePolicy.create({ data: { ...p, effectiveFrom: new Date(Date.UTC(year, 0, 1)) } });
    }
  }

  // One company calendar per year applies to every employee.
  for (const y of [year, year + 1]) {
    const exists = await prisma.holidayCalendar.findFirst({ where: { employmentType: null, year: y, location: null } });
    if (exists) continue;
    await prisma.holidayCalendar.create({
      data: {
        name: `Company holidays ${y}`,
        year: y,
        status: "PUBLISHED",
        effectiveFrom: new Date(Date.UTC(y, 0, 1)),
        holidays: { create: holidays(y) },
      },
    });
  }

  // Demo records (fictional people, demo domain) so every screen has data.
  if ((await prisma.employee.count()) === 0) {
    const pos = (title: string) => prisma.position.findFirstOrThrow({ where: { title } });
    const day = (offset: number) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    const demo = [
      { name: "Demo Permanent One", email: "perm.one@demo.manikstu.local", position: "Software Engineer", employmentType: "PERMANENT" as const, stage: "ACTIVE" as const, joiningDate: day(-120), probationMonths: 6, code: "EMP" },
      { name: "Demo Intern One", email: "intern.one@demo.manikstu.local", position: "Technology Intern", employmentType: "INTERN" as const, stage: "ACTIVE" as const, joiningDate: day(-40), endDate: day(10), mentor: "Super Admin", code: "INT" },
      { name: "Demo Candidate Two", email: "candidate.two@demo.manikstu.local", position: "HR Executive", employmentType: "PERMANENT" as const, stage: "PENDING_REVIEW" as const, joiningDate: day(21), probationMonths: 6, code: "EMP" },
      { name: "Demo Intern Two", email: "intern.two@demo.manikstu.local", position: "HR Intern", employmentType: "INTERN" as const, stage: "ONBOARDING_IN_PROGRESS" as const, joiningDate: day(3), endDate: day(93), mentor: "Super Admin", code: "INT" },
    ];
    for (const e of demo) {
      const p = await pos(e.position);
      const created = await prisma.employee.create({
        data: {
          name: e.name,
          email: e.email,
          positionId: p.id,
          departmentId: p.departmentId,
          managerId: adminId,
          location: "Head office",
          workMode: "On-site",
          employmentType: e.employmentType,
          stage: e.stage,
          joiningDate: e.joiningDate,
          endDate: "endDate" in e ? e.endDate : null,
          probationMonths: "probationMonths" in e ? e.probationMonths : null,
          mentor: "mentor" in e ? e.mentor : null,
          compensation: e.employmentType === "INTERN" ? 15000 : 600000,
          createdById: adminId,
        },
      });
      await prisma.employee.update({
        where: { id: created.id },
        data: { code: `${e.code}-${String(created.seq).padStart(4, "0")}` },
      });
      const done = e.stage === "ACTIVE";
      await prisma.onboardingTask.createMany({
        data: [
          { employeeId: created.id, title: "Verify identity and address proof", owner: "HR", dueAt: day(-5), done },
          { employeeId: created.id, title: "Collect signed NDA / confidentiality agreement", owner: "HR", dueAt: day(-1), done },
          { employeeId: created.id, title: "Request M-DESK and email account (IT access workflow)", owner: "IT", dueAt: day(1), done },
          { employeeId: created.id, title: "Induction session attended", owner: "HR", dueAt: day(7), done },
        ],
      });
    }
  }
}
