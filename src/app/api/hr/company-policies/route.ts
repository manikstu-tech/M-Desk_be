import { requireSession } from "@/lib/authorize";
import { checkContentLength } from "@/lib/documents";
import { publishPolicy } from "@/lib/hr-policies";
import { companyPolicySchema } from "@/lib/hr-validation";
import { errorResponse, ok } from "@/lib/validation";

// Multipart: the policy fields plus an optional PDF.
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    checkContentLength(req);
    const fd = await req.formData();
    const input = companyPolicySchema.parse({
      title: String(fd.get("title") ?? ""),
      summary: String(fd.get("summary") ?? ""),
      version: String(fd.get("version") ?? "") || undefined,
      body: String(fd.get("body") ?? ""),
      mandatory: fd.get("mandatory") !== "false",
    });
    const file = fd.get("file");
    const policy = await publishPolicy(session, input, file instanceof File && file.size > 0 ? file : undefined);
    return ok({ id: policy.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
