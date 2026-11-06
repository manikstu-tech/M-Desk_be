import { RoleName } from "@prisma/client";
import { requireSession } from "@/lib/authorize";
import { scanTasks } from "@/lib/tasks";
import { scanWorkflows } from "@/lib/workflows";
import { scanHr } from "@/lib/hr-scan";
import { scanTech } from "@/lib/tech-items";
import { ApiError, errorResponse, ok } from "@/lib/validation";

// The cron scheduler is phase-B6; for now a Super Admin triggers the scan here.
export async function POST() {
  try {
    const session = await requireSession();
    if (session.user.role.name !== RoleName.SUPER_ADMIN) {
      throw new ApiError(403, "FORBIDDEN", "Only the Super Admin can run the objective scan");
    }
    const result = await scanTasks();
    const wf = await scanWorkflows();
    const hr = await scanHr();
    const tech = await scanTech();
    return ok({ ...result, workflows: wf, hr, tech });
  } catch (e) {
    return errorResponse(e);
  }
}
