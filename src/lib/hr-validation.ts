import {
  AttendanceStatus,
  EmployeeStage,
  EmploymentType,
  HolidayCategory,
  HrDocCategory,
  LetterType,
  Qualification,
} from "@prisma/client";
import { z } from "zod";
import { GENDERS, MARITAL_STATUSES, MOVE_KINDS, PAY_FREQUENCIES } from "./hr-catalogue";

const day = z.coerce.date();
const optText = (max: number) => z.string().trim().max(max).optional();

// Indian identity and bank formats; spaces are ignored, letters upper-cased.
const compact = z.string().transform((v) => v.replace(/\s+/g, "").toUpperCase());
const aadhaar = compact.pipe(z.string().regex(/^\d{12}$/, "Aadhaar number must be 12 digits"));
const pan = compact.pipe(z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, "PAN must look like ABCDE1234F"));
const accountNo = compact.pipe(z.string().regex(/^\d{9,18}$/, "Bank account number must be 9–18 digits"));
const ifsc = compact.pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must look like SBIN0001234"));
// IDs issued before M-DESK keep their own format; upper-cased so two records can't differ only by case.
const employeeId = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, "Employee ID can't be empty")
      .max(30, "Employee ID can be at most 30 characters")
      .regex(/^[A-Z0-9][A-Z0-9/_.-]*$/, "Employee ID can only use letters, numbers and / - _ ."),
  );

const uan = compact.pipe(z.string().regex(/^\d{12}$/, "UAN must be 12 digits"));
const esiNo = compact.pipe(z.string().regex(/^\d{10,17}$/, "ESI number must be 10–17 digits"));
const pfNo = compact.pipe(z.string().regex(/^[A-Z0-9/]{5,30}$/, "PF number can only use letters, numbers and /"));

// New-employee step 1: personal details. An empty string clears an optional value on edit.
const personalDetails = {
  fatherName: optText(120),
  dateOfBirth: day.optional(),
  gender: z.enum(GENDERS).optional(),
  maritalStatus: z.enum(MARITAL_STATUSES).optional(),
  personalEmail: z.string().trim().email("Enter a valid personal email").optional(),
  remarks: optText(1000),
};

// Step 3: payroll set-up.
const payrollDetails = {
  bankBranch: optText(120),
  salaryStructure: optText(80),
  payGrade: optText(20),
  paymentFrequency: z.enum(PAY_FREQUENCIES).optional(),
  payrollStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Payroll start month must look like 2026-11").optional(),
  costCentre: optText(80),
  pfApplicable: z.boolean().optional(),
  esiApplicable: z.boolean().optional(),
  ptApplicable: z.boolean().optional(),
  uanNumber: uan.optional(),
  pfNumber: pfNo.optional(),
  esiNumber: esiNo.optional(),
};

const joiningDetails = {
  ...personalDetails,
  ...payrollDetails,
  qualification: z.nativeEnum(Qualification).optional(),
  aadhaarNumber: aadhaar.optional(),
  panNumber: pan.optional(),
  bankAccountName: optText(120),
  bankName: optText(120),
  bankAccountNumber: accountNo.optional(),
  bankIfsc: ifsc.optional(),
};

export const employeeSchema = z
  .object({
    code: employeeId.optional(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    phone: optText(30),
    emergencyContact: optText(120),
    positionId: z.string().min(1),
    managerId: z.string().min(1).optional(),
    location: z.string().trim().min(1).max(120),
    employmentType: z.nativeEnum(EmploymentType),
    joiningDate: day,
    endDate: day.optional(),
    probationMonths: z.coerce.number().int().min(0).max(24).optional(),
    compensation: z.coerce.number().positive().max(100_000_000).optional(),
    workMode: optText(40),
    mentor: optText(120),
    ...joiningDetails,
  })
  .refine((e) => !e.endDate || e.endDate > e.joiningDate, {
    message: "End date must be after the joining date",
  })
  .refine((e) => e.employmentType === "PERMANENT" || e.endDate, {
    message: "Interns and contract staff need an end date",
  });

export const employeeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  code: employeeId.optional(),
  email: z.string().trim().email().optional(),
  phone: optText(30),
  emergencyContact: optText(120),
  positionId: z.string().min(1).optional(),
  managerId: z.string().min(1).nullable().optional(),
  location: z.string().trim().min(1).max(120).optional(),
  employmentType: z.nativeEnum(EmploymentType).optional(),
  joiningDate: day.optional(),
  endDate: day.nullable().optional(),
  probationMonths: z.coerce.number().int().min(0).max(24).nullable().optional(),
  compensation: z.coerce.number().positive().max(100_000_000).nullable().optional(),
  workMode: optText(40),
  mentor: optText(120),
  ...joiningDetails,
  reason: z.string().trim().min(3, "A reason is required for profile changes").max(500),
});

export const employeeMoveSchema = z
  .object({
    kind: z.enum(MOVE_KINDS),
    departmentId: z.string().min(1, "Choose a department"),
    positionId: z.string().min(1).optional(),
    newPositionTitle: z.string().trim().min(1).max(120).optional(),
    grade: optText(40),
    managerId: z.string().min(1).optional(),
    reason: z.string().trim().min(3, "A reason is required").max(500),
  })
  .refine((m) => !!m.positionId !== !!m.newPositionTitle, {
    message: "Choose a position or add a new one",
  });

export const stageSchema = z.object({
  to: z.nativeEnum(EmployeeStage),
  reason: optText(500),
});

export const taskToggleSchema = z.object({ done: z.boolean() });

export const positionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  departmentId: z.string().min(1),
  grade: optText(40),
});

export const positionUpdateSchema = z.object({ active: z.boolean() });

export const templateSchema = z.object({
  type: z.nativeEnum(LetterType),
  employmentType: z.nativeEnum(EmploymentType).nullable().optional(),
  name: z.string().trim().min(1).max(160),
  body: z.string().min(20).max(20_000),
});

export const templateActSchema = z.object({ action: z.enum(["APPROVE", "RETIRE"]) });

export const generateLetterSchema = z.object({
  employeeId: z.string().min(1),
  type: z.nativeEnum(LetterType),
  acceptanceDays: z.coerce.number().int().min(1).max(60).optional(),
  mode: z.enum(["NOW", "LATER"]).optional(),
});

export const letterActSchema = z.object({
  action: z.enum(["SUBMIT", "APPROVE", "REJECT", "SEND", "ACCEPT", "DECLINE", "WITHDRAW"]),
  comment: optText(1000),
});

export const docMetaSchema = z.object({
  employeeId: z.string().min(1),
  category: z.nativeEnum(HrDocCategory),
  label: z.string().trim().min(1).max(120),
  expiresAt: day.optional(),
});

export const docVerifySchema = z.object({
  verification: z.enum(["VERIFIED", "REJECTED"]),
  comment: optText(500),
});

export const holidaySchema = z.object({
  name: z.string().trim().min(1).max(120),
  date: day,
  endDate: day.optional(),
  category: z.nativeEnum(HolidayCategory),
});

export const policySchema = z.object({
  name: z.string().trim().min(1).max(120),
  employmentType: z.nativeEnum(EmploymentType),
  location: optText(120),
  effectiveFrom: day,
  approval: z.string().trim().min(1).max(200),
  allowances: z
    .array(z.object({ type: z.string().trim().min(1).max(40), days: z.coerce.number().min(0).max(366) }))
    .min(1, "Add at least one leave type"),
});

export const leaveSchema = z
  .object({
    employeeId: z.string().min(1),
    leaveType: z.string().trim().min(1).max(40),
    startDate: day,
    endDate: day,
    halfDay: z.boolean().optional(),
    reason: optText(500),
  })
  .refine((l) => l.endDate >= l.startDate, { message: "End date must not be before the start date" });

export const leaveDecideSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "CANCEL"]),
  comment: optText(500),
});

export const attendanceSchema = z.object({
  date: day,
  entries: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        status: z.nativeEnum(AttendanceStatus),
        note: optText(200),
      }),
    )
    .min(1)
    .max(1000),
});

export const correctionRequestSchema = z.object({
  date: day,
  status: z.nativeEnum(AttendanceStatus),
  reason: z.string().trim().min(3, "Give a reason").max(300),
});

export const correctionDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT", "CANCEL"]),
  note: optText(300),
});

// Company policies (new-employee step 4); not leave rules.
export const companyPolicySchema = z.object({
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(3).max(240),
  version: z.string().trim().min(1).max(20).default("v1.0"),
  body: z.string().trim().min(20, "Write the policy text (at least 20 characters)").max(50_000),
  mandatory: z.boolean().default(true),
});

export const policyAssignSchema = z.object({
  policyIds: z.array(z.string().min(1)).max(100),
});
