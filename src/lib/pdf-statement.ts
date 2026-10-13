import type { CsvTable } from "./bank-statement.ts";
import { MAX_STATEMENT_BYTES, MAX_STATEMENT_ROWS } from "./bank-statement.ts";

export type PdfTextRun = { page: number; x: number; y: number; width: number; text: string };
export type PdfStatementTable = { table: CsvTable; pageCount: number; warnings: string[] };

const MAX_PDF_PAGES = 100;
const LINE_TOLERANCE = 2.25;
const COLUMN_GAP = 14;

/** Reads selectable PDF text locally in the browser; no PDF bytes leave this device. */
export async function extractPdfStatement(file: File): Promise<PdfStatementTable> {
  if (file.size > MAX_STATEMENT_BYTES) throw new Error("This PDF is over the 10 MB import limit.");
  if (file.size === 0) throw new Error("This PDF file is empty.");
  if (!file.name.toLocaleLowerCase("en-US").endsWith(".pdf") && file.type !== "application/pdf") {
    throw new Error("Choose a PDF bank statement.");
  }

  try {
    const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    GlobalWorkerOptions.workerSrc = worker.default;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
      throw new Error("This file does not have a valid PDF header.");
    }
    const loadingTask = getDocument({ data: bytes });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new Error(`This PDF has more than ${MAX_PDF_PAGES} pages. Split it into smaller files first.`);
      }
      const runs: PdfTextRun[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent({ includeMarkedContent: false });
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          const transform = item.transform;
          runs.push({
            page: pageNumber,
            x: Number(transform[4] ?? 0),
            y: Number(transform[5] ?? 0),
            width: Number(item.width ?? 0),
            text: item.str,
          });
        }
        page.cleanup();
      }
      if (runs.length === 0) {
        throw new Error("No selectable text was found. Scanned/image-only statements are not supported yet.");
      }
      const extracted = statementTableFromPdfRuns(runs);
      if (!extracted.table.rows.length) throw new Error("No transaction rows were found beneath the statement header.");
      if (extracted.table.rows.length > MAX_STATEMENT_ROWS) {
        throw new Error(`This PDF has more than ${MAX_STATEMENT_ROWS.toLocaleString()} possible transaction rows.`);
      }
      return { ...extracted, pageCount: pdf.numPages };
    } catch (error) {
      await loadingTask.destroy();
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("This ")) throw error;
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    if (name === "PasswordException" || /password/i.test(message)) {
      throw new Error("Password-protected PDFs are not supported. Save an unlocked copy with your bank's tools and try again.");
    }
    if (/no selectable text|text content/i.test(message)) {
      throw new Error("No selectable text was found. Scanned/image-only statements are not supported yet.");
    }
    if (error instanceof Error && /header|layout|columns|transaction table/i.test(error.message)) throw error;
    throw new Error("This PDF could not be read. It may be damaged, scanned, password-protected, or use an unsupported layout.");
  }
}

/** Heuristically maps aligned text runs to columns; callers must present all rows for review. */
export function statementTableFromPdfRuns(runs: PdfTextRun[]): Omit<PdfStatementTable, "pageCount"> {
  const lines = groupLines(runs);
  const headerIndex = lines.findIndex((line) => looksLikeHeader(line.cells.map((cell) => cell.text)));
  if (headerIndex < 0) {
    throw new Error("Could not recognize a transaction-table header with date and amount columns. This PDF layout is unsupported; use CSV or enter transactions manually.");
  }
  const headerLine = lines[headerIndex]!;
  const headerCells = headerLine.cells;
  const headers = headerCells.map((cell, index) => {
    const label = cell.text.trim().replace(/\s+/g, " ");
    return label || `Column ${index + 1}`;
  });
  const currencies = detectHeaderCurrencies(headers.join(" "));
  if (currencies.length > 1) {
    throw new Error("This PDF labels columns with more than one currency. Import a single-currency statement into each ledger separately.");
  }
  if (currencies.length === 1 && !headers.some((header) => /^currency$/i.test(header))) {
    headers.push("Currency");
  }
  const centers = headerCells.map((cell) => cell.x + Math.max(cell.width, 1) / 2);
  const rows: CsvTable["rows"] = [];
  let rowNumber = 0;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.page === headerLine.page && looksLikeHeader(line.cells.map((cell) => cell.text))) continue;
    const values = assignCellsToColumns(line.cells, centers, headers.length - (currencies.length ? 1 : 0));
    if (values.every((value) => value.trim() === "")) continue;
    if (currencies.length === 1 && headers.length > values.length) values.push(currencies[0]!);
    rowNumber += 1;
    const overflow = values.length > headers.length;
    const fitted = overflow
      ? [...values.slice(0, Math.max(0, headers.length - 1)), values.slice(Math.max(0, headers.length - 1)).join(" ")]
      : [...values, ...Array(Math.max(0, headers.length - values.length)).fill("")];
    rows.push({
      rowNumber: rowNumber + 1,
      values: fitted,
      ...(overflow ? { parseError: "This line has more text columns than the detected header. Review and correct the extracted cells." } : {}),
    });
  }
  return {
    table: { headers, rows },
    warnings: [
      "PDF columns are inferred from text positions, not a bank-specific template. Review every row before importing.",
      ...(currencies.length ? [`The PDF header labels amounts as ${currencies[0]}; rows are locked to that currency for mismatch checks.`] : []),
    ],
  };
}

type PdfCell = { x: number; width: number; text: string };
type PdfLine = { page: number; y: number; cells: PdfCell[] };

function groupLines(runs: PdfTextRun[]): PdfLine[] {
  const ordered = runs
    .filter((run) => run.text.trim())
    .slice()
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const run of ordered) {
    let line = lines.find((candidate) => candidate.page === run.page && Math.abs(candidate.y - run.y) <= LINE_TOLERANCE);
    if (!line) {
      line = { page: run.page, y: run.y, cells: [] };
      lines.push(line);
    }
    line.cells.push({ x: run.x, width: run.width, text: run.text });
  }
  return lines.map((line) => ({
    ...line,
    cells: mergeAdjacentRuns(line.cells),
  })).sort((a, b) => a.page - b.page || b.y - a.y);
}

function mergeAdjacentRuns(runs: PdfCell[]): PdfCell[] {
  const ordered = runs.slice().sort((a, b) => a.x - b.x);
  const cells: PdfCell[] = [];
  for (const run of ordered) {
    const previous = cells.at(-1);
    const gap = previous ? run.x - (previous.x + previous.width) : Number.POSITIVE_INFINITY;
    if (previous && gap < COLUMN_GAP) {
      previous.text = `${previous.text}${gap > 2 && !previous.text.endsWith(" ") ? " " : ""}${run.text}`;
      previous.width = Math.max(previous.width, run.x + run.width - previous.x);
    } else {
      cells.push({ ...run, text: run.text.trim() });
    }
  }
  return cells;
}

function looksLikeHeader(cells: string[]): boolean {
  const text = cells.join(" ").toLocaleLowerCase("en-US");
  const hasDate = /\b(date|txn date|transaction date|posting date|value date)\b/.test(text);
  const hasAmount = /\b(amount|debit|withdrawal|credit|deposit|money out|money in)\b/.test(text);
  return hasDate && hasAmount;
}

function assignCellsToColumns(cells: PdfCell[], centers: number[], expectedColumns: number): string[] {
  const result = Array.from({ length: Math.max(expectedColumns, centers.length) }, () => "");
  for (const cell of cells) {
    let column = 0;
    while (column < centers.length - 1) {
      const midpoint = ((centers[column] ?? 0) + (centers[column + 1] ?? 0)) / 2;
      if (cell.x < midpoint) break;
      column += 1;
    }
    result[column] = `${result[column]}${result[column] ? " " : ""}${cell.text.trim()}`.trim();
  }
  return result;
}

function detectHeaderCurrencies(text: string): Array<"INR" | "USD"> {
  const value = text.toLocaleLowerCase("en-US");
  const found = new Set<"INR" | "USD">();
  if (/\b(inr|rupee|rupees)\b|₹|\brs\.?\b/i.test(value)) found.add("INR");
  if (/\b(usd|dollar|dollars)\b|\$/.test(value)) found.add("USD");
  return [...found];
}
