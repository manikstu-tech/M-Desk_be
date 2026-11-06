import { Action, RoleName } from "@prisma/client";
import { db } from "./db";
import type { AuthSession } from "./authorize";
import { writeAudit } from "./audit";
import { activeGrant } from "./documents";
import { ApiError } from "./validation";
import { financeRepo } from "./finance-repo";
import * as R from "./finance-rules";
import { financeActionSchema, parseStatementCsv, type FinanceAction } from "./finance-validation";
import { periodByKey } from "./finance-calc";
import { FIN_SLUG, type Actor, type FinRole } from "./finance-types";

// Finance access and the single write path. Roles come from the existing M-DESK role +
// department membership (no new roles), the same way Technology & MIS does it:
//   Finance & Accounts member  ADMIN → Finance Head · MANAGER/OFFICER → Accountant ·
//                              FIELD_STAFF → Field (records receipts) · others → Viewer
//   Grant on Finance (no membership)  APPROVE → Finance Head · EDIT/UPLOAD → Accountant ·
//                              VIEW/EXPORT/AUDIT → Viewer
//   Executive Leadership & Strategy ADMIN/MANAGER → Management (budget/sanction, reopen)
//   Super Admin → Management + every Finance action (still bound by separation of duties)
// Everyone else gets no Finance access. Every API call re-checks this; hiding a button is
// only a convenience.

export const EXEC_SLUG = "executive-leadership-strategy";

export type FinanceAccess = {
  dept: { id: string; name: string };
  actor: Actor;
  exporter: boolean;
};

export async function financeDept() {
  const dept = await db.department.findUnique({ where: { slug: FIN_SLUG }, select: { id: true, name: true, active: true } });
  if (!dept || !dept.active) throw new ApiError(404, "NOT_FOUND", "Finance & Accounts department is not configured");
  return { id: dept.id, name: dept.name };
}

const MEMBER_ROLE: Partial<Record<RoleName, FinRole>> = {
  [RoleName.ADMIN]: "FINANCE_HEAD",
  [RoleName.MANAGER]: "ACCOUNTANT",
  [RoleName.OFFICER]: "ACCOUNTANT",
  [RoleName.FIELD_STAFF]: "FIELD",
};

export async function financeAccess(session: AuthSession): Promise<FinanceAccess | null> {
  const dept = await financeDept();
  const role = session.user.role.name;
  const base = { id: session.user.id, name: session.user.name };
  if (role === RoleName.SUPER_ADMIN) return { dept, actor: { ...base, role: "MANAGEMENT", isSuper: true }, exporter: true };

  const [membership, grants, exec] = await Promise.all([
    db.departmentMembership.findUnique({ where: { userId_departmentId: { userId: session.user.id, departmentId: dept.id } } }),
    db.delegationGrant.findMany({ where: { userId: session.user.id, departmentId: dept.id, ...activeGrant() }, select: { action: true } }),
    db.departmentMembership.findFirst({ where: { userId: session.user.id, department: { slug: EXEC_SLUG } } }),
  ]);
  const has = (a: Action) => grants.some((g) => g.action === a);
  let finRole: FinRole | null = null;
  if (membership) finRole = MEMBER_ROLE[role] ?? "VIEWER";
  else if (has(Action.APPROVE)) finRole = "FINANCE_HEAD";
  else if (has(Action.EDIT) || has(Action.UPLOAD)) finRole = "ACCOUNTANT";
  else if (exec && (role === RoleName.ADMIN || role === RoleName.MANAGER)) finRole = "MANAGEMENT";
  else if (grants.length) finRole = "VIEWER";
  if (!finRole) return null;
  const exporter = finRole !== "VIEWER" && finRole !== "FIELD" ? true : has(Action.EXPORT);
  return { dept, actor: { ...base, role: finRole, isSuper: false }, exporter };
}

async function deny(session: AuthSession, departmentId: string | null, action: string, message: string) {
  await db.$transaction((tx) =>
    writeAudit(tx, {
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "DENIED_FINANCE_ACTION",
      targetType: "Finance",
      targetId: action,
      departmentId,
      outcome: "DENIED",
      detail: { action, reason: message, demo: true },
    }),
  );
}

/** Page and API gate: Finance access or 403 (audited). */
export async function requireFinance(session: AuthSession): Promise<FinanceAccess> {
  const access = await financeAccess(session);
  if (!access) {
    await deny(session, null, "OPEN_FINANCE", "No Finance & Accounts access");
    throw new ApiError(403, "FORBIDDEN", "Finance & Accounts is restricted to Finance, Management and Admin");
  }
  return access;
}

/** Read-only view of the records for a page or export. */
export async function financeView(session: AuthSession) {
  const access = await requireFinance(session);
  const repo = financeRepo();
  return { access, state: repo.snapshot(), mode: repo.mode };
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function param(sp: SearchParams, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

/** Page gate + shared filters. Returns null when the person has no Finance access (page shows a notice). */
export async function financePage(session: AuthSession, sp: SearchParams) {
  const access = await financeAccess(session);
  if (!access) return null;
  const repo = financeRepo();
  const state = repo.snapshot();
  const wanted = param(sp, "project");
  const projectId = wanted === "all" || state.projects.some((p) => p.id === wanted) ? wanted : (state.projects[0]?.id ?? "all");
  const period = periodByKey(param(sp, "period"));
  const now = new Date().toISOString();
  return { access, state, mode: repo.mode, scope: { projectId, period }, now };
}

function apply(input: FinanceAction, s: Parameters<typeof R.createBill>[0], ctx: R.Ctx): R.Result {
  switch (input.type) {
    case "bill.create": {
      const b = R.createBill(s, ctx, { ...input, type: input.billType });
      if (input.invoiceTitle.trim()) R.attachDoc(s, ctx, { billId: b.id, kind: "INVOICE", title: input.invoiceTitle });
      return { target: b.id, text: `Bill ${b.id} entered` };
    }
    case "bill.submit":
      return R.submitBill(s, ctx, input);
    case "bill.attach":
      return R.attachDoc(s, ctx, input);
    case "bill.approve":
      return R.approveBill(s, ctx, input);
    case "bill.editAmount":
      return R.editAmount(s, ctx, input);
    case "bill.reject":
      return R.rejectBill(s, ctx, input);
    case "bill.pay":
      return R.markPaid(s, ctx, input);
    case "receipt.record": {
      const r = R.recordReceipt(s, ctx, { ...input, reference: input.reference });
      return { target: r.id, text: `Receipt ${r.id} recorded` };
    }
    case "receipt.link":
      return R.linkReceipt(s, ctx, input);
    case "receipt.verify":
      return R.verifyReceipt(s, ctx, input);
    case "receipt.return":
      return R.returnReceipt(s, ctx, input);
    case "budget.request": {
      const b = R.requestBudget(s, ctx, input);
      return { target: b.id, text: `Budget change ${b.id} requested` };
    }
    case "budget.decide":
      return R.decideBudget(s, ctx, input);
    case "advance.request": {
      const a = R.requestAdvance(s, ctx, input);
      return { target: a.id, text: `Advance ${a.id} requested` };
    }
    case "advance.decide":
      return R.decideAdvance(s, ctx, input);
    case "advance.adjust":
      return R.adjustAdvance(s, ctx, input);
    case "voucher.create": {
      const v = R.createVoucher(s, ctx, { ...input, type: input.voucherType });
      return { target: v.id, text: `Voucher ${v.id} drafted` };
    }
    case "voucher.edit":
      return R.editVoucher(s, ctx, input);
    case "voucher.delete":
      return R.deleteVoucher(s, ctx, input);
    case "voucher.submit":
      return R.submitVoucher(s, ctx, input);
    case "voucher.decide":
      return R.decideVoucher(s, ctx, input);
    case "voucher.post":
      return R.postVoucher(s, ctx, input);
    case "bank.upload": {
      let lines;
      try {
        lines = parseStatementCsv(input.csv);
      } catch (e) {
        throw new ApiError(422, "VALIDATION", e instanceof Error ? e.message : "Could not read the statement");
      }
      const r = R.uploadStatement(s, ctx, { accountId: input.accountId, month: input.month, fileName: input.fileName, lines });
      return { target: `${input.accountId}:${input.month}`, text: `${r.added} lines added, ${r.skipped} duplicates skipped` };
    }
    case "bank.confirm":
      return R.confirmMatch(s, ctx, input);
    case "bank.confirmAll": {
      const open = s.bankLines.filter((l) => l.accountId === input.accountId && l.month === input.month).map((l) => l.id);
      let n = 0;
      for (const lineId of open) {
        try {
          R.confirmMatch(s, ctx, { lineId });
          n++;
        } catch (e) {
          // lines without a suggestion are skipped; permission and lock errors still stop the batch
          if (!(e instanceof ApiError) || e.status === 403 || (e.status === 409 && !/no suggested match/i.test(e.message))) throw e;
        }
      }
      if (n === 0) throw new ApiError(409, "CONFLICT", "There are no suggested matches to confirm");
      return { target: `${input.accountId}:${input.month}`, text: `${n} suggested match${n === 1 ? "" : "es"} confirmed` };
    }
    case "bank.link": {
      const targetType = input.target.startsWith("RECEIPT:") ? "RECEIPT" : "LEDGER";
      return R.linkLine(s, ctx, { lineId: input.lineId, targetType, targetId: input.target.slice(targetType.length + 1) });
    }
    case "bank.classify":
      return R.classifyLine(s, ctx, input);
    case "bank.explain":
      return R.explainLine(s, ctx, input);
    case "bank.unmatch":
      return R.unmatchLine(s, ctx, input);
    case "close.signoff":
      return R.signOff(s, ctx, input);
    case "close.lock":
      return R.lockMonth(s, ctx, input);
    case "close.reopen":
      return R.reopenMonth(s, ctx, input);
    case "demo.reset":
      throw new ApiError(400, "BAD_REQUEST", "handled by runFinanceAction");
  }
}

/**
 * The only way Finance records change: authorise, validate, apply the rule to a copy,
 * write the audit event, then keep the copy. A refused action is audited as DENIED.
 */
export async function runFinanceAction(session: AuthSession, raw: unknown): Promise<R.Result> {
  const access = await requireFinance(session);
  const parsed = financeActionSchema.safeParse(raw);
  // Name the bad field, but never echo the list of action types back to a caller.
  if (!parsed.success) throw new ApiError(422, "VALIDATION", parsed.error.issues.map((i) => (i.path[0] === "type" || i.path.length === 0 ? "Unknown action" : `${i.path.join(".")}: ${i.message}`)).join("; "));
  const input = parsed.data;
  const repo = financeRepo();
  const auditIt = (r: R.Result, action: string) =>
    db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action,
        targetType: "FinanceDemo",
        targetId: r.target,
        departmentId: access.dept.id,
        detail: { text: r.text, demo: repo.mode === "demo" },
      }),
    );

  if (input.type === "demo.reset") {
    if (!R.can.approve(access.actor)) {
      await deny(session, access.dept.id, input.type, "Only the Finance Head or Super Admin can reset the sample data");
      throw new ApiError(403, "FORBIDDEN", "Only the Finance Head or Super Admin can reset the sample data");
    }
    const r = { target: "sample-data", text: "Sample data reset to its starting point" };
    await auditIt(r, "FINANCE_DEMO_RESET");
    repo.reset();
    return r;
  }

  const ctx: R.Ctx = { actor: access.actor, now: new Date().toISOString() };
  try {
    return await repo.mutate(
      (draft) => apply(input, draft, ctx),
      (r) => auditIt(r, `FINANCE_${input.type.replace(".", "_").toUpperCase()}`),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) await deny(session, access.dept.id, input.type, e.message);
    throw e;
  }
}
