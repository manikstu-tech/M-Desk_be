import { requireSession } from "@/lib/authorize";
import { downloadVersion } from "@/lib/documents";
import { errorResponse, versionQuerySchema } from "@/lib/validation";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { version } = versionQuerySchema.parse({
      version: new URL(req.url).searchParams.get("version") ?? undefined,
    });
    return await downloadVersion(session, id, version);
  } catch (e) {
    return errorResponse(e);
  }
}
