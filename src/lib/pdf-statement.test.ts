import assert from "node:assert/strict";
import { test } from "node:test";
import { statementTableFromPdfRuns } from "./pdf-statement.ts";

test("text PDF layout groups aligned runs into a reviewable transaction table", () => {
  const result = statementTableFromPdfRuns([
    { page: 1, x: 40, y: 700, width: 36, text: "Date" },
    { page: 1, x: 160, y: 700, width: 84, text: "Description" },
    { page: 1, x: 330, y: 700, width: 43, text: "Amount USD" },
    { page: 1, x: 40, y: 676, width: 60, text: "2026-10-01" },
    { page: 1, x: 160, y: 676, width: 62, text: "Coffee shop" },
    { page: 1, x: 330, y: 676, width: 42, text: "-4.50" },
    { page: 1, x: 40, y: 652, width: 60, text: "2026-10-02" },
    { page: 1, x: 160, y: 652, width: 54, text: "Pay" },
    { page: 1, x: 330, y: 652, width: 36, text: "25.00" },
  ]);

  assert.deepEqual(result.table.headers, ["Date", "Description", "Amount USD", "Currency"]);
  assert.deepEqual(result.table.rows.map((row) => row.values), [
    ["2026-10-01", "Coffee shop", "-4.50", "USD"],
    ["2026-10-02", "Pay", "25.00", "USD"],
  ]);
  assert.match(result.warnings.join(" "), /Review every row/);
});

test("text PDF import rejects currency headers that mix ledgers", () => {
  assert.throws(() => statementTableFromPdfRuns([
    { page: 1, x: 10, y: 100, width: 30, text: "Date" },
    { page: 1, x: 90, y: 100, width: 40, text: "Amount USD INR" },
    { page: 1, x: 10, y: 80, width: 60, text: "2026-10-01" },
    { page: 1, x: 90, y: 80, width: 30, text: "10" },
  ]), /more than one currency/);
});
