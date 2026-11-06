import { createGrant, requireSession, revokeGrant } from "@/lib/authorize";
import { grantSchema, revokeSchema, ok, errorResponse } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const input = grantSchema.parse(await req.json());
    const grant = await createGrant(session, input);
    return ok({ id: grant.id });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireSession();
    const { grantId } = revokeSchema.parse(await req.json());
    await revokeGrant(session, grantId);
    return ok({ revoked: true });
  } catch (e) {
    return errorResponse(e);
  }
}
