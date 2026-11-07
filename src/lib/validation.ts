import { NextResponse } from "next/server";
import { Action, Confidentiality, DocStatus, RoleName, TaskStatus } from "@prisma/client";
import { z, ZodError } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const setPasswordFromInviteSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const setPasswordFromSupabaseInviteSchema = z.object({
  accessToken: z.string().min(20).max(4096),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email("Enter a valid email address"),
});

export const resetTokenSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, "This password reset link is invalid"),
});

// Same rule the password screens show. bcrypt ignores anything past 72 bytes.
export const resetPasswordSchema = resetTokenSchema
  .extend({
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Za-z]/, "Password must include a letter")
      .regex(/[0-9]/, "Password must include a digit")
      .refine((p) => Buffer.byteLength(p) <= 72, "Password must be at most 72 bytes"),
    confirmPassword: z.string().optional(),
  })
  .refine((v) => v.confirmPassword === undefined || v.confirmPassword === v.newPassword, {
    message: "Passwords do not match",
  });

export const resendInviteSchema = z.object({
  userId: z.string().min(1),
});

export const createUserSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  roleName: z.nativeEnum(RoleName),
});

export const membershipSchema = z.object({
  userId: z.string().min(1),
  departmentId: z.string().min(1),
});

export const grantSchema = z
  .object({
    userId: z.string().min(1),
    departmentId: z.string().min(1),
    action: z.nativeEnum(Action),
    reason: z.string().min(3, "Reason is required"),
    expiresAt: z.coerce.date().optional(),
    namedL4: z.boolean().optional(),
  })
  .refine((g) => !g.namedL4 || g.action === Action.VIEW, {
    message: "L4 named access must be a VIEW grant",
  });

export const revokeSchema = z.object({
  grantId: z.string().min(1),
});

export const documentMetaSchema = z.object({
  title: z.string().min(1).max(200),
  departmentId: z.string().min(1),
  confidentiality: z.nativeEnum(Confidentiality),
});

export const changeNoteSchema = z.object({
  changeNote: z.string().min(3, "Change note is required"),
});

export const documentStatusSchema = z.object({
  status: z.nativeEnum(DocStatus),
});

export const documentFiltersSchema = z.object({
  q: z.string().max(200).optional(),
  status: z.nativeEnum(DocStatus).optional(),
  departmentId: z.string().min(1).optional(),
});

export const versionQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  departmentId: z.string().min(1),
  note: z.string().max(2000).optional(),
  assigneeId: z.string().min(1).optional(),
  reviewerId: z.string().min(1).optional(),
  dueAt: z.coerce.date().optional(),
});

export const taskTransitionSchema = z.object({
  to: z.nativeEnum(TaskStatus),
  note: z.string().max(2000).optional(),
  blockedReason: z.string().max(500).optional(),
});

export const startWorkflowSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1).max(200),
  amount: z.coerce.number().positive().optional(),
  relatedType: z.string().max(40).optional(),
  relatedId: z.string().min(1).optional(),
});

export const wfActSchema = z.object({
  action: z.enum(["APPROVED", "REJECTED", "RETURNED", "CANCELLED", "RESUBMITTED"]),
  comment: z.string().max(2000).optional(),
  amount: z.coerce.number().positive().optional(),
  title: z.string().max(200).optional(),
});

export const notificationReadSchema = z.object({
  id: z.string().min(1).optional(),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function errorResponse(e: unknown) {
  if (e instanceof ApiError) {
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: e.issues.map((i) => i.message).join("; ") } },
      { status: 422 },
    );
  }
  if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === "P2002") {
    return NextResponse.json(
      { error: { code: "CONFLICT", message: "Record already exists" } },
      { status: 409 },
    );
  }
  console.error(e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Internal error" } }, { status: 500 });
}
