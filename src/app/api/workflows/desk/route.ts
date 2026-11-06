import { requireSession } from "@/lib/authorize";
import { listWorkflows, nextWfActions } from "@/lib/workflows";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/workflows/desk: my workflow instances and those awaiting me, each with the actions I may take. */
export async function GET() {
  try {
    const session = await requireSession();
    const { startedByMe, awaitingMine, definitions } = await listWorkflows(session);
    const [startedByMeRows, awaitingMineRows] = await Promise.all([
      Promise.all(startedByMe.map(async (i) => ({ instance: i, actions: await nextWfActions(session, i) }))),
      Promise.all(awaitingMine.map(async (i) => ({ instance: i, actions: await nextWfActions(session, i) }))),
    ]);
    return ok({ startedByMe: startedByMeRows, awaitingMine: awaitingMineRows, definitions });
  } catch (e) {
    return errorResponse(e);
  }
}
