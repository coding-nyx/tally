import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatementPreview,
  parseStatementCsv,
  suggestStatementMapping,
  transactionsToCsv,
  type StatementMapping,
} from "./bank-statement.ts";
import type { Transaction } from "./budget.ts";

const signedMapping: StatementMapping = {
  dateColumn: 0,
  descriptionColumn: 1,
  currencyColumn: null,
  dateFormat: "auto",
  amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
};

function existingTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "existing",
    kind: "expense",
    amountCents: 10025,
    category: "Housing",
    note: "River Rent",
    date: "2026-10-01",
    createdAt: 1,
    sample: false,
    ...overrides,
  };
}

test("CSV parser handles BOM, quoted commas, escaped quotes, newlines, and CRLF", () => {
  const table = parseStatementCsv('\uFEFFDate,Description,Amount\r\n2026-10-01,"Cafe, east","-12.30"\r\n2026-10-02,"A ""quoted"" note",5.50\r\n');
  assert.deepEqual(table.headers, ["Date", "Description", "Amount"]);
  assert.deepEqual(table.rows.map((row) => row.values), [
    ["2026-10-01", "Cafe, east", "-12.30"],
    ["2026-10-02", 'A "quoted" note', "5.50"],
  ]);
});

test("CSV parser rejects malformed quotes, duplicate/blank headers, and oversized rows", () => {
  assert.throws(() => parseStatementCsv('Date,Description\n2026-10-01,"unfinished'), /inside a quoted field/);
  assert.throws(() => parseStatementCsv("Date,date\n2026-10-01,2026-10-01"), /headers must be unique/);
  assert.throws(() => parseStatementCsv("Date,,Amount\n2026-10-01,x,2"), /needs a header/);
  const extra = parseStatementCsv("Date,Amount\n2026-10-01,2,unexpected");
  assert.match(extra.rows[0]?.parseError ?? "", /more values than the header/);
});

test("mapping suggestions recognize common date, description, debit, and credit columns", () => {
  assert.deepEqual(suggestStatementMapping(["Transaction Date", "Narration", "Debit", "Credit"]), {
    dateColumn: 0,
    descriptionColumn: 1,
    currencyColumn: null,
    amountColumn: null,
    debitColumn: 2,
    creditColumn: 3,
  });
});

test("signed amounts use an explicit positive direction and preserve integer minor units", () => {
  const table = parseStatementCsv('Date,Description,Amount\n2026-10-01,River Rent,"-1,000.25"\n2026-10-02,Salary,25.5');
  const rows = buildStatementPreview({ table, mapping: signedMapping, currency: "INR", existing: [] });
  assert.equal(rows[0]?.transaction?.kind, "expense");
  assert.equal(rows[0]?.transaction?.amountCents, 100025);
  assert.equal(rows[1]?.transaction?.kind, "income");
  assert.equal(rows[1]?.transaction?.amountCents, 2550);

  const quoted = parseStatementCsv('Date,Description,Amount\n2026-10-01,"River Rent","(1,000.25)"');
  const parsed = buildStatementPreview({ table: quoted, mapping: signedMapping, currency: "INR", existing: [] });
  assert.equal(parsed[0]?.transaction?.kind, "expense");
  assert.equal(parsed[0]?.transaction?.amountCents, 100025);
  assert.equal(parsed[0]?.transaction?.category, "Personal");
});

test("debit and credit columns produce expense/income rows and reject conflicting values", () => {
  const table = parseStatementCsv("Date,Description,Debit,Credit\n2026-10-01,Market,125.40,\n2026-10-02,Refund,,25.00\n2026-10-03,Invalid,1,2");
  const mapping: StatementMapping = {
    dateColumn: 0,
    descriptionColumn: 1,
    currencyColumn: null,
    dateFormat: "auto",
    amount: { mode: "debit-credit", debitColumn: 2, creditColumn: 3 },
  };
  const rows = buildStatementPreview({ table, mapping, currency: "USD", existing: [] });
  assert.equal(rows[0]?.transaction?.kind, "expense");
  assert.equal(rows[0]?.transaction?.amountCents, 12540);
  assert.equal(rows[1]?.transaction?.kind, "income");
  assert.equal(rows[2]?.error, "This row has both debit and credit amounts.");
});

test("dates reject ambiguous slashes until the user chooses month/day or day/month", () => {
  const table = parseStatementCsv("Date,Description,Amount\n03/04/2026,Coffee,-4.50\n13/04/2026,Market,-8.00");
  const automatic = buildStatementPreview({ table, mapping: signedMapping, currency: "USD", existing: [] });
  assert.match(automatic[0]?.error ?? "", /Ambiguous date/);
  assert.equal(automatic[1]?.transaction?.date, "2026-04-13");
  const mdy = buildStatementPreview({
    table,
    mapping: { ...signedMapping, dateFormat: "mdy" },
    currency: "USD",
    existing: [],
  });
  assert.equal(mdy[0]?.transaction?.date, "2026-03-04");
});

test("currency symbols must match the explicitly selected import ledger", () => {
  const table = parseStatementCsv("Date,Description,Amount\n2026-10-01,Market,₹100.00");
  const rows = buildStatementPreview({ table, mapping: signedMapping, currency: "USD", existing: [] });
  assert.match(rows[0]?.error ?? "", /shows INR, but the import currency is USD/);
});

test("mapped currency columns reject rows that would be relabelled into another ledger", () => {
  const table = parseStatementCsv("Date,Description,Amount,Currency\n2026-10-01,Market,-10.00,USD\n2026-10-02,Other,-5.00,INR");
  const rows = buildStatementPreview({
    table,
    mapping: { ...signedMapping, currencyColumn: 3 },
    currency: "USD",
    existing: [],
  });
  assert.equal(rows[0]?.transaction?.kind, "expense");
  assert.equal(rows[1]?.error, "This row is INR, but USD is selected.");
});

test("duplicate review compares date, direction, minor amount, and normalized description", () => {
  const table = parseStatementCsv("Date,Description,Amount\n2026-10-01,  RIVER   RENT ,-100.25\n2026-10-01,River Rent,-100.25");
  const rows = buildStatementPreview({ table, mapping: signedMapping, currency: "INR", existing: [existingTransaction()] });
  assert.equal(rows[0]?.duplicate, true);
  assert.equal(rows[1]?.duplicate, true);
});

test("transaction CSV export preserves dates, currency, kind, minor amounts, and quoted text", () => {
  const csv = transactionsToCsv([
    existingTransaction({ note: 'Cafe, "east"\nbranch', amountCents: 12345 }),
  ], "INR");
  assert.match(csv, /^\uFEFFDate,Type,Amount,Currency,Category,Description/);
  assert.match(csv, /2026-10-01,expense,123\.45,INR,Housing,"Cafe, ""east""\nbranch"/);
});
