import { PrismaClient, RoleName, Action } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedHr } from "./hr-seed";

const prisma = new PrismaClient();

const DEPARTMENTS = [
  ["Executive Leadership & Strategy", "#16A34A"],
  ["Compliance and Secretarial", "#2563EB"],
  ["Field Operations & Beneficiary Management", "#D97706"],
  ["Livestock Procurement & Supply Chain", "#DC2626"],
  ["Infrastructure & Engineering", "#7C3AED"],
  ["Animal Health & Veterinary Services", "#0D9488"],
  ["Finance & Accounts", "#6D28D9"],
  ["Procurement & Vendor Management", "#EA580C"],
  ["HR & Administration", "#15803D"],
  ["Technology & MIS", "#1D4ED8"],
  ["Communications & Stakeholder Relations", "#DB2777"],
  ["Business Development & Partnerships", "#9333EA"],
] as const;

const DELEGABLE: Partial<Record<Action, boolean>> = {
  VIEW: true,
  UPLOAD: true,
  EDIT: true,
  APPROVE: true,
  EXPORT: true,
  MANAGE_USERS: true,
  AUDIT: false,
};

// B4: step approver roles are seed data (blueprint writes them as roles because
// the DoA Matrix does not exist yet — open decision P-06). tier.dept of null ⇒
// requester's own department. Tiers amount-routing the final DoA step are
// PLACEHOLDERS until MD + Finance Head supply real limits.
type WfStep = {
  name: string;
  role: RoleName;
  dept?: string | null;
  tiers?: { upTo: number; role: RoleName; dept?: string | null }[];
};

const FINANCE = "finance-accounts";
const DOA_TIERS: NonNullable<WfStep["tiers"]> = [
  { upTo: 50_000, role: RoleName.MANAGER, dept: FINANCE }, // P-06 placeholder
  { upTo: 500_000, role: RoleName.ADMIN, dept: FINANCE }, // P-06 placeholder
  { upTo: Number.MAX_SAFE_INTEGER, role: RoleName.SUPER_ADMIN, dept: null }, // MD — super admin in this app
];

// Blueprint wave-1 #2 (task assignment → managerial approval) is NOT seeded:
// the B3 task engine already implements it (SUBMITTED → reviewer approve/
// request-revision, 2-working-day SLA via scan) — doubles would mean two
// sources of truth.
const WF_DEFS: { key: string; name: string; wave: number; slaDays: number; steps: WfStep[] }[] = [
  {
    key: "leave_request",
    name: "Leave request",
    wave: 1,
    slaDays: 1,
    steps: [{ name: "Line manager approval", role: RoleName.MANAGER, dept: null }],
  },
  {
    key: "purchase_requisition",
    name: "Purchase requisition → payment",
    wave: 1,
    slaDays: 5,
    steps: [
      { name: "Department head approval", role: RoleName.MANAGER, dept: null },
      { name: "Finance review", role: RoleName.ADMIN, dept: FINANCE },
      { name: "DoA approval", role: RoleName.ADMIN, dept: FINANCE, tiers: DOA_TIERS },
    ],
  },
  {
    key: "vendor_invoice",
    name: "Vendor invoice → payment approval",
    wave: 1,
    slaDays: 3,
    steps: [
      // requisition confirms receipt implicitly by filing the invoice
      { name: "Finance verification", role: RoleName.ADMIN, dept: FINANCE },
      { name: "DoA approval", role: RoleName.ADMIN, dept: FINANCE, tiers: DOA_TIERS },
    ],
  },
  {
    key: "document_approval",
    name: "Document creation → approval → archival",
    wave: 1,
    slaDays: 3,
    steps: [{ name: "Department head approval", role: RoleName.MANAGER, dept: null }],
  },
  {
    key: "it_access",
    name: "IT access request / revocation",
    wave: 1,
    slaDays: 1,
    steps: [
      { name: "Line manager approval", role: RoleName.MANAGER, dept: null },
      { name: "Data owner approval", role: RoleName.ADMIN, dept: "technology-mis" },
    ],
  },
];

async function main() {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  for (const action of Object.values(Action)) {
    await prisma.permission.upsert({
      where: { action },
      update: { delegable: DELEGABLE[action] ?? false },
      create: { action, delegable: DELEGABLE[action] ?? false },
    });
  }

  for (let i = 0; i < DEPARTMENTS.length; i++) {
    const [name, accentColor] = DEPARTMENTS[i];
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await prisma.department.upsert({
      where: { slug },
      update: {},
      create: { number: i + 1, name, slug, accentColor },
    });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: RoleName.SUPER_ADMIN } });
  const admin = await prisma.user.upsert({
    where: { email: "admin@manikstu.local" },
    // reset to known dev credentials on every seed run
    update: {
      name: "Biren Sahoo",
      passwordHash: await bcrypt.hash("ChangeMe!123", 10),
      mustChangePassword: true,
      status: "ACTIVE",
    },
    create: {
      email: "admin@manikstu.local",
      name: "Biren Sahoo",
      passwordHash: await bcrypt.hash("ChangeMe!123", 10),
      mustChangePassword: true,
      roleId: adminRole.id,
    },
  });

  // Demo tasks: Technology & MIS + HR, owned by the seeded super admin.
  // Re-run-safe: refresh the known set instead of upserting (no natural unique key).
  const tech = await prisma.department.findUniqueOrThrow({ where: { slug: "technology-mis" } });
  const hr = await prisma.department.findUniqueOrThrow({ where: { slug: "hr-administration" } });
  const due = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const SEED_TASKS = [
    // overdue: the engine scan escalates it on first run
    {
      title: "Renew M365 licence register",
      departmentId: tech.id,
      status: "IN_PROGRESS" as const,
      dueAt: due(-2),
      createdById: admin.id,
    },
    // near-due: reminder fires once 50% of time-to-due elapses
    {
      title: "Draft password-reset SOP",
      departmentId: tech.id,
      status: "OPEN" as const,
      dueAt: due(1),
      createdById: admin.id,
    },
    // awaiting review: reviewer queue demo
    {
      title: "Collect signed leave-policy acknowledgements",
      departmentId: hr.id,
      status: "SUBMITTED" as const,
      dueAt: due(4),
      createdById: admin.id,
      reviewerId: admin.id,
    },
    // HR workspace "Upcoming" panel (HR draft v1.0 §1)
    { title: "New joiner induction", departmentId: hr.id, status: "OPEN" as const, dueAt: due(2), createdById: admin.id },
    { title: "Monthly HR review", departmentId: hr.id, status: "OPEN" as const, dueAt: due(3), createdById: admin.id },
    { title: "POSH committee review", departmentId: hr.id, status: "OPEN" as const, dueAt: due(7), createdById: admin.id },
  ];
  await prisma.task.deleteMany({
    where: { createdById: admin.id, title: { in: SEED_TASKS.map((t) => t.title) } },
  });
  await prisma.task.createMany({ data: SEED_TASKS });

  // B4: wave-1 workflow definitions — upsert so re-seeding refreshes steps/SLAs
  for (const def of WF_DEFS) {
    await prisma.workflowDefinition.upsert({
      where: { key: def.key },
      update: { name: def.name, wave: def.wave, slaDays: def.slaDays, steps: def.steps },
      create: { key: def.key, name: def.name, wave: def.wave, slaDays: def.slaDays, steps: def.steps },
    });
  }

  // HR module starter data (samples — see prisma/hr-seed.ts)
  await seedHr(prisma, admin.id);

  console.log(
    "Seed complete: 12 departments, 9 roles, 7 permissions, super admin, 6 demo tasks, 5 wave-1 workflow definitions, HR module samples.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
