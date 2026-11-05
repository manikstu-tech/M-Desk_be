import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont } from "pdf-lib";

// Letter PDFs (§5, §12): letterhead, reference, wrapped body, signature block and
// a footer with the template version and generation time on every page.
// Drafts carry a watermark so they are visibly distinct from issued letters.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const BRAND = rgb(0.055, 0.302, 0.2);

// Standard fonts are WinAnsi-only; map common Unicode punctuation and drop the rest.
export function pdfSafe(text: string): string {
  return text
    .replace(/₹/g, "INR ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export type LetterPdfInput = {
  companyName: string;
  companyAddress: string;
  title: string;
  reference: string;
  issueDate: string;
  body: string;
  signatory: string;
  templateVersion: number;
  draft: boolean;
};

export async function renderLetterPdf(input: LetterPdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${input.title} - ${input.reference}`));
  pdf.setProducer("M-DESK HR");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = A4.w - MARGIN * 2;
  const generated = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  let page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
  };
  const write = (text: string, font: PDFFont, size: number, color = INK, gap = 4) => {
    for (const line of wrap(pdfSafe(text), font, size, width)) {
      if (y < MARGIN + 40) newPage();
      if (line) page.drawText(line, { x: MARGIN, y, size, font, color });
      y -= size + gap;
    }
  };

  // Letterhead
  write(input.companyName, bold, 16, BRAND, 6);
  write(input.companyAddress, regular, 9, MUTED, 3);
  y -= 4;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 1, color: BRAND });
  y -= 22;
  write(`Ref: ${input.reference}`, regular, 9, MUTED, 3);
  write(`Date: ${input.issueDate}`, regular, 9, MUTED, 14);
  write(input.title, bold, 13, INK, 12);
  write(input.body, regular, 10.5, INK, 5);
  y -= 18;
  write(`For ${input.companyName}`, regular, 10.5);
  y -= 26;
  write(input.signatory, bold, 10.5);
  write("Authorised Signatory", regular, 9, MUTED);

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const footer = pdfSafe(
      `Ref ${input.reference} · Template v${input.templateVersion} · Generated ${generated} · Page ${i + 1} of ${pages.length}`,
    );
    p.drawText(footer, { x: MARGIN, y: MARGIN / 2, size: 7.5, font: regular, color: MUTED });
    if (input.draft) {
      p.drawText("DRAFT - NOT FOR ISSUE", {
        x: 110,
        y: 300,
        size: 48,
        font: bold,
        color: rgb(0.85, 0.2, 0.2),
        opacity: 0.15,
        rotate: degrees(35),
      });
    }
  });

  return Buffer.from(await pdf.save());
}
