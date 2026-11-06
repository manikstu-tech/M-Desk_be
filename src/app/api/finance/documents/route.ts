import { requireSession } from "@/lib/authorize";
import { financeView } from "@/lib/finance";
import { billAmount, vendorName } from "@/lib/finance-calc";
import { formatINR } from "@/lib/finance-format";
import { renderLetterPdf } from "@/lib/hr-pdf";
import { ApiError, errorResponse } from "@/lib/validation";

// Sample documents have no real file behind them, so this renders a clearly watermarked
// summary PDF from the bill's own record instead of linking to something that does not exist.
// Production: stream the file from the Documents module (lib/documents.ts) with its L1–L4 checks.
export async function GET(req: Request) {
  try {
    const session = await requireSession();
    const { state } = await financeView(session);
    const sp = new URL(req.url).searchParams;
    const bill = state.bills.find((b) => b.id === sp.get("bill"));
    const doc = bill?.docs.find((d) => d.id === sp.get("doc"));
    if (!bill || !doc) throw new ApiError(404, "NOT_FOUND", "Document not found");
    const body = [
      `This is a sample document generated from M-DESK demo data. No real file is stored for "${doc.title}".`,
      "",
      `Bill: ${bill.id}`,
      `Payee: ${vendorName(state, bill.vendorId)}`,
      `Work order: ${bill.workOrderId ?? "none"}${bill.shed ? ` (shed ${bill.shed})` : ""}`,
      `Amount as submitted: ${formatINR(bill.submittedAmount)}`,
      `Final amount: ${formatINR(billAmount(bill))}`,
      `Document: ${doc.title} (${doc.kind.toLowerCase().replace("_", " ")}), from ${doc.source}`,
      `Added by ${doc.addedBy} on ${doc.addedAt.slice(0, 10)}`,
    ].join("\n");
    const pdf = await renderLetterPdf({
      companyName: "Manikstu Agro Private Limited",
      companyAddress: "Finance & Accounts — SAMPLE DATA",
      title: doc.title,
      reference: `${bill.id}/${doc.id}`,
      issueDate: doc.addedAt.slice(0, 10),
      body,
      signatory: "Not signed — sample",
      templateVersion: 0,
      draft: true,
    });
    const inline = sp.get("download") !== "1";
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${bill.id}-${doc.id}.pdf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
