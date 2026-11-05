import { requireSession } from "@/lib/authorize";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { financeView } from "@/lib/finance";
import { periodByKey } from "@/lib/finance-calc";
import { monthForPeriod, reportByKey, reportCsvRows, summaryReport } from "@/lib/finance-reports";
import { toCsv } from "@/lib/hr-reports";
import { ApiError, errorResponse } from "@/lib/validation";

// CSV download of any Finance report (or the overview figures as "summary").
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const { access, state, mode } = await financeView(session);
    if (!access.exporter) throw new ApiError(403, "FORBIDDEN", "You can view Finance but not export it");
    const sp = new URL(req.url).searchParams;
    const key = sp.get("report") ?? "summary";
    const projectId = sp.get("project") ?? "all";
    if (projectId !== "all" && !state.projects.some((p) => p.id === projectId)) throw new ApiError(404, "NOT_FOUND", "Project not found");
    const scope = { projectId, period: periodByKey(sp.get("period")) };
    const month = /^\d{4}-\d{2}$/.test(sp.get("month") ?? "") ? (sp.get("month") as string) : monthForPeriod(state, scope);
    const accountId = state.accounts.some((a) => a.id === sp.get("account")) ? (sp.get("account") as string) : state.accounts[0].id;
    const def = key === "summary" ? null : reportByKey(key);
    if (key !== "summary" && !def) throw new ApiError(404, "NOT_FOUND", "Report not found");
    const billFilters = { q: sp.get("q") ?? undefined, type: sp.get("type") ?? undefined, wo: sp.get("wo") ?? undefined, due: sp.get("due") ?? undefined, status: sp.get("status") ?? undefined };
    const report = def ? def.build(state, { scope, accountId, month, billFilters, now: new Date().toISOString() }) : summaryReport(state, scope);
    const table = reportCsvRows(report);
    // Sample data says so in the file itself, so an export can't pass for live figures.
    const lines = mode === "demo" ? [["SAMPLE DATA — not live figures"], [""], ...table] : table;
    await db.$transaction((tx) =>
      writeAudit(tx, {
        actorId: session.user.id,
        actorEmail: session.user.email,
        action: "FINANCE_EXPORTED",
        targetType: "FinanceReport",
        targetId: key,
        departmentId: access.dept.id,
        detail: { projectId, period: scope.period.key, rows: report.rows.length, demo: mode === "demo" },
      }),
    );
    const csv = toCsv({ columns: lines[0], rows: lines.slice(1) });
    const name = `finance-${key}-${projectId}-${scope.period.key}.csv`;
    return new Response("﻿" + csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
