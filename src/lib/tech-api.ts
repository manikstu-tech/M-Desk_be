import type { AuthSession } from "./authorize";
import { techWorkspace, type TechAccess } from "./tech";
import { ApiError } from "./validation";

/** API gate for Technology & MIS workspace reads: department members (and the Super Admin) only. */
export async function requireTechMember(session: AuthSession): Promise<TechAccess> {
  const access = await techWorkspace(session);
  if (!access) throw new ApiError(403, "FORBIDDEN", "Technology & MIS members only");
  return access;
}
