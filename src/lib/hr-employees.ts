import { Action, type EmployeeStage, type EmploymentType, type Prisma } from "@prisma/client";
import type { z } from "zod";
import { db } from "./db";
import type { Tx } from "./audit";
import type { AuthSession } from "./authorize";
import { notifyUsers } from "./notify";
import { ApiError } from "./validation";
import { hrAdminIds, hrAudit, hrDept, requireHr } from "./hr";
import { canMoveEmployee, CHECKLISTS, employeeCode, hrHref, STAGE_LABEL, stageMove, type MoveKind } from "./hr-catalogue";
import type { employeeMoveSchema, employeeSchema, employeeUpdateSchema } from "./hr-validation";

const DAY = 24 * 60 * 60 * 1000;

async function loadEmployee(id: string) {
  const emp = await db.employee.findUnique({ where: { id } });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  return emp;
}

async function activePosition(positionId: string) {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position || !position.active) throw new ApiError(422, "VALIDATION", "Choose an active position");
  return position;
}

async function checkManager(managerId: string | null | undefined) {
  if (!managerId) return;
  const m = await db.user.findUnique({ where: { id: managerId }, select: { status: true } });
  if (!m || m.status !== "ACTIVE") throw new ApiError(422, "VALIDATION", "Manager must be an active M-DESK user");
}

async function assertCodeFree(code: string) {
  const taken = await db.employee.findUnique({ where: { code }, select: { id: true } });
  if (taken) throw new ApiError(409, "CONFLICT", `Employee ID ${code} is already in use`);
}

/** The generated code for this record's seq, moving past any number already taken by a hand-entered ID. */
async function nextFreeCode(tx: Tx, type: EmploymentType, seq: number) {
  let n = seq;
  while (await tx.employee.findUnique({ where: { code: employeeCode(type, n) }, select: { id: true } })) n++;
  return employeeCode(type, n);
}

/** §4 steps 1–3: create the record, apply the employment type's checklist. */
export async function createEmployee(session: AuthSession, input: z.infer<typeof employeeSchema>) {
  const dept = await requireHr(session, Action.EDIT);
  const position = await activePosition(input.positionId);
  await checkManager(input.managerId);
  if (input.code) await assertCodeFree(input.code);

  return db.$transaction(async (tx) => {
    const created = await tx.employee.create({
      data: {
        code: input.code,
        name: input.name,
        email: input.email.toLowerCase(),
        phone: input.phone,
        emergencyContact: input.emergencyContact,
        positionId: position.id,
        departmentId: position.departmentId,
        managerId: input.managerId,
        location: input.location,
        employmentType: input.employmentType,
        joiningDate: input.joiningDate,
        endDate: input.endDate,
        probationMonths: input.probationMonths,
        compensation: input.compensation,
        workMode: input.workMode,
        mentor: input.mentor,
        qualification: input.qualification,
        aadhaarNumber: input.aadhaarNumber,
        panNumber: input.panNumber,
        bankAccountName: input.bankAccountName,
        bankName: input.bankName,
        bankAccountNumber: input.bankAccountNumber,
        bankIfsc: input.bankIfsc,
        ...pick(input, [...PERSONAL_FIELDS, ...PAYROLL_SETUP_FIELDS]),
        createdById: session.user.id,
      },
    });
    const emp = created.code
      ? created
      : await tx.employee.update({
          where: { id: created.id },
          data: { code: await nextFreeCode(tx, input.employmentType, created.seq) },
        });
    await tx.onboardingTask.createMany({
      data: CHECKLISTS[input.employmentType].map((t) => ({
        employeeId: emp.id,
        title: t.title,
        owner: t.owner,
        mandatory: t.mandatory,
        dueAt: new Date(input.joiningDate.getTime() + t.dueOffsetDays * DAY),
      })),
    });
    await hrAudit(tx, session, dept.id, {
      action: "HR_EMPLOYEE_CREATED",
      targetType: "Employee",
      targetId: emp.id,
      detail: { code: emp.code, employmentType: emp.employmentType, position: position.title },
    });
    return emp;
  });
}

const PERSONAL_FIELDS = ["fatherName", "dateOfBirth", "gender", "maritalStatus", "personalEmail", "remarks"] as const; // emergencyContact is set explicitly above
const PAYROLL_SETUP_FIELDS = [
  "bankBranch",
  "salaryStructure",
  "payGrade",
  "paymentFrequency",
  "payrollStartMonth",
  "costCentre",
  "pfApplicable",
  "esiApplicable",
  "ptApplicable",
  "uanNumber",
  "pfNumber",
  "esiNumber",
] as const;

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])) as Partial<Pick<T, K>>;
}

// Values never written to the audit log; payroll ones also need APPROVE to change.
const SENSITIVE = new Set<string>([
  "compensation",
  "aadhaarNumber",
  "panNumber",
  "bankAccountName",
  "bankName",
  "bankAccountNumber",
  "bankIfsc",
  "dateOfBirth",
  "personalEmail",
  "emergencyContact",
  ...PAYROLL_SETUP_FIELDS,
]);
const PAYROLL = ["compensation", "bankAccountName", "bankName", "bankAccountNumber", "bankIfsc", ...PAYROLL_SETUP_FIELDS] as const;

/** Profile edits; compensation and bank changes additionally need an APPROVE grant (§16). */
export async function updateEmployee(
  session: AuthSession,
  id: string,
  input: z.infer<typeof employeeUpdateSchema>,
) {
  const dept = await requireHr(session, Action.EDIT);
  const emp = await loadEmployee(id);
  const { reason, ...changes } = input;
  // A draft is still being set up by HR (same rights as creating it); after that, payroll edits need an approver.
  if (emp.stage !== "DRAFT" && PAYROLL.some((k) => changes[k] !== undefined)) await requireHr(session, Action.APPROVE);
  if (changes.employmentType && changes.employmentType !== emp.employmentType && emp.stage === "ACTIVE") {
    throw new ApiError(409, "CONFLICT", "Employment type changes for active staff need a new onboarding record");
  }
  if (changes.positionId) await activePosition(changes.positionId);
  if (changes.managerId) await checkManager(changes.managerId);
  if (changes.code && changes.code !== emp.code) await assertCodeFree(changes.code);

  const data: Prisma.EmployeeUncheckedUpdateInput = {};
  const summary: Record<string, { from: string | null; to: string | null } | "changed"> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const before: unknown = Reflect.get(emp, key);
    const fmt = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v));
    if (fmt(before) === fmt(value)) continue;
    Object.assign(data, { [key]: key === "email" && typeof value === "string" ? value.toLowerCase() : value });
    summary[key] = SENSITIVE.has(key) ? "changed" : { from: fmt(before), to: fmt(value) };
  }
  if (Object.keys(summary).length === 0) return emp;
  if (changes.positionId) {
    const position = await activePosition(changes.positionId);
    data.departmentId = position.departmentId;
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.employee.update({ where: { id }, data });
    await hrAudit(tx, session, dept.id, {
      action: summary.employmentType ? "HR_EMPLOYEE_TYPE_CHANGED" : "HR_EMPLOYEE_UPDATED",
      targetType: "Employee",
      targetId: id,
      detail: { changes: summary, reason },
    });
    return updated;
  });
}

const MOVE_ACTION: Record<MoveKind, string> = {
  PROMOTION: "HR_EMPLOYEE_PROMOTED",
  TRANSFER: "HR_EMPLOYEE_TRANSFERRED",
  ROLE_CHANGE: "HR_EMPLOYEE_ROLE_CHANGED",
};

/** Promotion, transfer or role change: position and department move together, kept in the employee's history. */
export async function moveEmployee(session: AuthSession, id: string, input: z.infer<typeof employeeMoveSchema>) {
  const dept = await requireHr(session, Action.EDIT);
  const emp = await db.employee.findUnique({
    where: { id },
    include: {
      position: { select: { title: true } },
      department: { select: { name: true } },
      manager: { select: { name: true } },
    },
  });
  if (!emp) throw new ApiError(404, "NOT_FOUND", "Employee not found");
  if (!canMoveEmployee(emp.stage)) {
    throw new ApiError(409, "CONFLICT", `A record that is ${STAGE_LABEL[emp.stage]} can't be promoted or transferred`);
  }

  const target = await db.department.findUnique({ where: { id: input.departmentId } });
  if (!target || !target.active) throw new ApiError(422, "VALIDATION", "Choose an active department");
  if (input.kind === "TRANSFER" && target.id === emp.departmentId) {
    throw new ApiError(422, "VALIDATION", "A transfer needs a different department");
  }

  let position = input.positionId ? await activePosition(input.positionId) : null;
  if (position && position.departmentId !== target.id) {
    throw new ApiError(422, "VALIDATION", `${position.title} isn't a position in ${target.name}`);
  }
  if (input.newPositionTitle) {
    position = await db.position.findUnique({
      where: { title_departmentId: { title: input.newPositionTitle, departmentId: target.id } },
    });
    if (position && !position.active) {
      throw new ApiError(409, "CONFLICT", `${position.title} is inactive in ${target.name}; reactivate it in HR settings first`);
    }
  }
  if (position?.id === emp.positionId) {
    throw new ApiError(409, "CONFLICT", `${emp.name} already holds this position`);
  }
  await checkManager(input.managerId);
  if (input.managerId && input.managerId === emp.userId) {
    throw new ApiError(422, "VALIDATION", "An employee can't report to themselves");
  }
  const newManager = input.managerId
    ? await db.user.findUniqueOrThrow({ where: { id: input.managerId }, select: { name: true } })
    : null;

  return db.$transaction(async (tx) => {
    let moved = position;
    if (!moved) {
      moved = await tx.position.create({
        data: { title: input.newPositionTitle!, departmentId: target.id, grade: input.grade },
      });
      await hrAudit(tx, session, dept.id, {
        action: "HR_POSITION_CREATED",
        targetType: "Position",
        targetId: moved.id,
        detail: { title: moved.title },
      });
    }
    const updated = await tx.employee.update({
      where: { id },
      data: { positionId: moved.id, departmentId: target.id, ...(input.managerId ? { managerId: input.managerId } : {}) },
    });
    const managerChanged = !!input.managerId && input.managerId !== emp.managerId;
    await hrAudit(tx, session, dept.id, {
      action: MOVE_ACTION[input.kind],
      targetType: "Employee",
      targetId: id,
      detail: {
        from: { position: emp.position.title, department: emp.department.name, manager: emp.manager?.name ?? null },
        to: {
          position: moved.title,
          department: target.name,
          manager: managerChanged ? (newManager?.name ?? null) : (emp.manager?.name ?? null),
        },
        reason: input.reason,
        summary: `${emp.position.title}, ${emp.department.name} → ${moved.title}, ${target.name}. ${input.reason}`,
      },
    });
    const title = `${emp.name}: now ${moved.title}, ${target.name}`;
    await notifyUsers(
      tx,
      [...new Set([emp.managerId, input.managerId])].filter((w): w is string => !!w && w !== session.user.id && w !== emp.userId),
      { title, link: hrHref(`employees/${id}`) },
    );
    if (emp.userId && emp.userId !== session.user.id) {
      await notifyUsers(tx, [emp.userId], { title: `Your role is now ${moved.title}, ${target.name}`, link: "/my-hr" });
    }
    return updated;
  });
}

/** Moves the stage and records who acted (§4); used by letters and the scan too. */
export async function setStage(
  tx: Tx,
  session: AuthSession | null,
  deptId: string,
  emp: { id: string; stage: EmployeeStage; code: string | null },
  to: EmployeeStage,
  detail: Record<string, string> = {},
) {
  await tx.employee.update({ where: { id: emp.id }, data: { stage: to } });
  await hrAudit(tx, session, deptId, {
    action: "HR_STAGE_CHANGED",
    targetType: "Employee",
    targetId: emp.id,
    detail: { from: emp.stage, to, ...detail },
  });
}

export async function transitionEmployee(session: AuthSession, id: string, to: EmployeeStage, reason?: string) {
  const emp = await loadEmployee(id);
  const move = stageMove(emp.stage, to);
  if (!move || move.system) {
    throw new ApiError(409, "CONFLICT", `Cannot move from ${STAGE_LABEL[emp.stage]} to ${STAGE_LABEL[to]} by hand`);
  }
  const dept = await requireHr(session, move.approval ? Action.APPROVE : Action.EDIT);
  if (move.approval && emp.createdById === session.user.id && session.user.role.name !== "SUPER_ADMIN") {
    throw new ApiError(409, "CONFLICT", "The person who created the record cannot approve its terms");
  }

  let userId = emp.userId;
  if (to === "ACTIVE") {
    const open = await db.onboardingTask.count({ where: { employeeId: id, mandatory: true, done: false } });
    if (open > 0) throw new ApiError(409, "CONFLICT", `${open} mandatory onboarding task(s) are still open`);
    // §4 step 9: enable self-service by linking the M-DESK account with the same email.
    if (!userId) {
      const account = await db.user.findUnique({ where: { email: emp.email }, select: { id: true, hrProfile: true } });
      if (account && !account.hrProfile) userId = account.id;
    }
  }

  await db.$transaction(async (tx) => {
    if (userId !== emp.userId) await tx.employee.update({ where: { id }, data: { userId } });
    await setStage(tx, session, dept.id, emp, to, reason ? { reason } : {});
    const watchers = [emp.managerId, ...(to === "ACTIVE" || to === "EXITED" ? await hrAdminIds() : [])];
    await notifyUsers(
      tx,
      watchers.filter((w): w is string => !!w && w !== session.user.id),
      { title: `${emp.name}: ${STAGE_LABEL[to]}`, link: hrHref(`employees/${id}`) },
    );
  });
}

/** Checklist tasks: HR completes any; the line manager completes Manager-owned ones. */
export async function setTaskDone(session: AuthSession, employeeId: string, taskId: string, done: boolean) {
  const task = await db.onboardingTask.findUnique({ where: { id: taskId }, include: { employee: true } });
  if (!task || task.employeeId !== employeeId) throw new ApiError(404, "NOT_FOUND", "Task not found");
  const managerOwned = task.owner === "Manager" && task.employee.managerId === session.user.id;
  const dept = managerOwned ? await hrDept() : await requireHr(session, Action.EDIT);

  return db.$transaction(async (tx) => {
    const updated = await tx.onboardingTask.update({
      where: { id: taskId },
      data: { done, completedAt: done ? new Date() : null, completedById: done ? session.user.id : null },
    });
    await hrAudit(tx, session, dept.id, {
      action: done ? "HR_TASK_COMPLETED" : "HR_TASK_REOPENED",
      targetType: "Employee",
      targetId: employeeId,
      detail: { task: task.title },
    });
    return updated;
  });
}

// ───────────── positions (§11 "Position") ─────────────

export async function createPosition(
  session: AuthSession,
  input: { title: string; departmentId: string; grade?: string },
) {
  const dept = await requireHr(session, Action.EDIT);
  return db.$transaction(async (tx) => {
    const p = await tx.position.create({ data: { title: input.title, departmentId: input.departmentId, grade: input.grade } });
    await hrAudit(tx, session, dept.id, {
      action: "HR_POSITION_CREATED",
      targetType: "Position",
      targetId: p.id,
      detail: { title: p.title },
    });
    return p;
  });
}

export async function setPositionActive(session: AuthSession, id: string, active: boolean) {
  const dept = await requireHr(session, Action.EDIT);
  const p = await db.position.findUnique({ where: { id } });
  if (!p) throw new ApiError(404, "NOT_FOUND", "Position not found");
  await db.$transaction(async (tx) => {
    await tx.position.update({ where: { id }, data: { active } });
    await hrAudit(tx, session, dept.id, {
      action: active ? "HR_POSITION_ACTIVATED" : "HR_POSITION_DEACTIVATED",
      targetType: "Position",
      targetId: id,
      detail: { title: p.title },
    });
  });
}
