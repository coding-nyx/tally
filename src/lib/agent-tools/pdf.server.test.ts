import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractServerPdf } from "./pdf.server.ts";
test("server selectable-text PDF extraction preserves reviewable rows and currency", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [text, x, y] of [
    ["Date", 40, 700],
    ["Description", 160, 700],
    ["Amount INR", 340, 700],
    ["2026-10-01", 40, 676],
    ["Synthetic groceries", 160, 676],
    ["-12.50", 340, 676],
  ] as const)
    page.drawText(text, { x, y, font, size: 10 });
  const result = await extractServerPdf(await document.save());
  assert.equal(
    typeof (globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler?: unknown } })
      .pdfjsWorker?.WorkerMessageHandler,
    "function",
    "The bundled worker must register its handler before Node text extraction",
  );
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.table.headers, ["Date", "Description", "Amount INR", "Currency"]);
  assert.equal(result.table.rows[0].values[3], "INR");
});
test("server PDF reader rejects scanned, malformed and oversized-page fixtures", async () => {
  const scanned = await PDFDocument.create();
  scanned.addPage();
  await assert.rejects(extractServerPdf(await scanned.save()), /Scanned/);
  await assert.rejects(extractServerPdf(Buffer.from("not PDF")), /valid PDF/);
  const large = await PDFDocument.create();
  for (let i = 0; i < 101; i++) large.addPage();
  await assert.rejects(extractServerPdf(await large.save()), /100 pages/);
});
