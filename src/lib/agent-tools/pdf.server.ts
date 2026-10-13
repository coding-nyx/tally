import { statementTableFromPdfRuns, type PdfTextRun } from "../pdf-statement.ts";
import { ToolError } from "./service.ts";
/** Hub-side text extraction. No OCR, remote calls or password handling. */
export async function extractServerPdf(bytes: Uint8Array) {
  if (bytes.length > 10485760 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new ToolError("invalid_pdf", "Choose a valid PDF under 10 MB.");
  // PDF.js defaults to importing a worker by a relative filename. Nitro
  // relocates the main module, so that filename is absent in the built server.
  // The worker's own side effect registers its handler for Node's in-process
  // text extraction; the explicit import also makes both build targets include it.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100)
      throw new ToolError(
        "unsupported_pdf",
        "PDFs with more than 100 pages are unsupported. Split the statement first.",
      );
    const runs: PdfTextRun[] = [];
    let characters = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const text = await page.getTextContent();
      for (const item of text.items)
        if ("str" in item && item.str.trim()) {
          characters += item.str.length;
          if (characters > 10_000_000 || runs.length > 200_000)
            throw new ToolError(
              "unsupported_pdf",
              "This PDF has too much text. Split the statement first.",
            );
          runs.push({
            page: number,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            text: item.str,
          });
        }
      page.cleanup();
    }
    if (!runs.length)
      throw new ToolError(
        "unsupported_pdf",
        "Scanned/image-only statements are unsupported. Use a selectable-text PDF or CSV.",
      );
    const result = statementTableFromPdfRuns(runs);
    if (!result.table.rows.length || result.table.rows.length > 20000)
      throw new ToolError(
        "unsupported_pdf",
        "The PDF must contain between 1 and 20,000 statement rows.",
      );
    return { ...result, pageCount: pdf.numPages };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/password/i.test(message) || (error instanceof Error && error.name === "PasswordException"))
      throw new ToolError(
        "unsupported_pdf",
        "Password-protected PDFs are unsupported. Export an unlocked statement with your bank's tools.",
      );
    throw new ToolError(
      "unsupported_pdf",
      "The PDF is damaged or has an unsupported layout. Use CSV or enter entries manually.",
    );
  } finally {
    await task.destroy();
  }
}
