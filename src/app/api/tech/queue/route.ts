import { requireSession } from "@/lib/authorize";
import { canAssign, techAgents } from "@/lib/tech";
import { requireTechMember } from "@/lib/tech-api";
import { myQueue, workloadOf } from "@/lib/tech-items";
import { errorResponse, ok } from "@/lib/validation";

/** GET /api/tech/queue: my work queue; assigners (head / Super Admin) also get the team and its workload. */
export async function GET() {
  try {
    const session = await requireSession();
    const access = await requireTechMember(session);
    const assigner = canAssign(access);
    const [queue, agents] = await Promise.all([myQueue(access), assigner ? techAgents(access.dept.id) : Promise.resolve([])]);
    return ok({ queue, assigner, agents, workload: assigner ? workloadOf(agents, queue.assigned, new Date()) : [] });
  } catch (e) {
    return errorResponse(e);
  }
}
