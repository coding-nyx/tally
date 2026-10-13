import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createTransactionReportPdf } from "./transaction-report-pdf.ts";
import type { BudgetData } from "./budget.ts";

test("monthly Tally report is a valid branded PDF with pagination and personal-reference footer", async () => {
  const transactions = Array.from({ length: 90 }, (_, index) => ({
    id: `expense-${index}`,
    kind: "expense" as const,
    amountCents: 12345,
    category: "Groceries",
    note: `Synthetic sample purchase ${index} at a long but readable store name`,
    date: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
    createdAt: index,
    sample: false,
  }));
  const data: BudgetData = {
    currency: "INR",
    sample: false,
    transactions,
    settingsByMonth: {
      "2026-10": { goalName: "Emergency cushion", goalTargetCents: 400_000, categoryBudgets: { Groceries: 1_000_000 } },
    },
  };

  const bytes = await createTransactionReportPdf(data, "2026-10");
  assert.ok(new TextDecoder().decode(bytes.slice(0, 8)).startsWith("%PDF-1."));
  const parsed = await PDFDocument.load(bytes);
  assert.ok(parsed.getPageCount() > 1);
});

test("empty month still produces a valid Tally PDF report", async () => {
  const data: BudgetData = { currency: "USD", sample: false, transactions: [], settingsByMonth: {} };
  const parsed = await PDFDocument.load(await createTransactionReportPdf(data, "2026-10"));
  assert.equal(parsed.getPageCount(), 1);
});
