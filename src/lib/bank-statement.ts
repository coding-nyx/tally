import type { Currency, Transaction, TxKind } from "./budget";

export type CsvTable = {
  headers: string[];
  rows: Array<{ rowNumber: number; values: string[]; parseError?: string }>;
};

export type StatementDateFormat = "auto" | "mdy" | "dmy";
export type AmountDirection = "income" | "expense";
export type StatementAmountMapping =
  | { mode: "signed"; amountColumn: number; positiveAmounts: AmountDirection }
  | { mode: "debit-credit"; debitColumn: number; creditColumn: number };

export type StatementMapping = {
  dateColumn: number;
  descriptionColumn: number | null;
  currencyColumn: number | null;
  dateFormat: StatementDateFormat;
  amount: StatementAmountMapping;
};

export type StagedTransaction = Pick<Transaction, "kind" | "amountCents" | "category" | "note" | "date">;

export type StatementPreviewRow = {
  rowNumber: number;
  values: string[];
  transaction: StagedTransaction | null;
  duplicate: boolean;
  error: string | null;
};

export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;

export function parseStatementCsv(text: string): CsvTable {
  if (new TextEncoder().encode(text).byteLength > MAX_STATEMENT_BYTES) {
    throw new Error("This CSV is over the 10 MB import limit.");
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        justClosedQuote = true;
      } else {
        field += char;
      }
      continue;
    }

    if (justClosedQuote && char !== "," && char !== "\n" && char !== "\r" && char.trim() !== "") {
      throw new Error(`Unexpected text after a quoted CSV field near character ${i + 1}.`);
    }
    if (char === '"') {
      if (field.length > 0) throw new Error(`Unexpected quote in an unquoted CSV field near character ${i + 1}.`);
      quoted = true;
      justClosedQuote = false;
    } else if (char === ",") {
      record.push(field);
      field = "";
      justClosedQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") i += 1;
      record.push(field);
      if (record.some((cell) => cell.trim() !== "")) records.push(record);
      record = [];
      field = "";
      justClosedQuote = false;
    } else {
      field += char;
      if (char.trim() !== "") justClosedQuote = false;
    }
  }

  if (quoted) throw new Error("This CSV ends inside a quoted field.");
  record.push(field);
  if (record.some((cell) => cell.trim() !== "")) records.push(record);
  if (records.length < 2) throw new Error("Choose a CSV with a header row and at least one transaction row.");
  if (records.length - 1 > MAX_STATEMENT_ROWS) throw new Error("This CSV has more than 20,000 transaction rows.");

  const headers = (records[0] ?? []).map((header) => header.trim());
  if (headers.some((header) => header.length === 0)) throw new Error("Every CSV column needs a header.");
  const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase("en-US"));
  if (new Set(normalizedHeaders).size !== headers.length) throw new Error("CSV column headers must be unique.");
  if (headers.length > 100) throw new Error("This CSV has more than 100 columns.");

  const rows = records.slice(1).map((values, index) => {
    if (values.length > headers.length) {
      return { rowNumber: index + 2, values, parseError: "This row has more values than the header." };
    }
    return { rowNumber: index + 2, values: [...values, ...Array(Math.max(0, headers.length - values.length)).fill("")] };
  });
  return { headers, rows };
}

export function suggestStatementMapping(headers: string[]): {
  dateColumn: number | null;
  descriptionColumn: number | null;
  currencyColumn: number | null;
  amountColumn: number | null;
  debitColumn: number | null;
  creditColumn: number | null;
} {
  const find = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header.trim().toLocaleLowerCase("en-US")));
  const first = (...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const value = find(pattern);
      if (value >= 0) return value;
    }
    return null;
  };
  return {
    dateColumn: first(/^date$/, /transaction\s*date/, /posting\s*date/, /value\s*date/),
    descriptionColumn: first(/^description$/, /^merchant$/, /^details$/, /^narration$/, /transaction\s*description/),
    currencyColumn: first(/^currency$/, /^ccy$/),
    amountColumn: first(/^amount$/, /transaction\s*amount/, /^value$/),
    debitColumn: first(/^debit(?:\s|\(|$)/, /^withdrawal(?:\s|\(|$)/, /^money\s*out(?:\s|\(|$)/),
    creditColumn: first(/^credit(?:\s|\(|$)/, /^deposit(?:\s|\(|$)/, /^money\s*in(?:\s|\(|$)/),
  };
}

export function buildStatementPreview(args: {
  table: CsvTable;
  mapping: StatementMapping;
  currency: Currency;
  existing: Transaction[];
}): StatementPreviewRow[] {
  const { table, mapping, currency } = args;
  validateColumn(mapping.dateColumn, table.headers.length, "Date");
  if (mapping.descriptionColumn !== null) validateColumn(mapping.descriptionColumn, table.headers.length, "Description");
  if (mapping.currencyColumn !== null) validateColumn(mapping.currencyColumn, table.headers.length, "Currency");
  if (mapping.amount.mode === "signed") {
    validateColumn(mapping.amount.amountColumn, table.headers.length, "Amount");
  } else {
    validateColumn(mapping.amount.debitColumn, table.headers.length, "Debit");
    validateColumn(mapping.amount.creditColumn, table.headers.length, "Credit");
    if (mapping.amount.debitColumn === mapping.amount.creditColumn) throw new Error("Choose separate debit and credit columns.");
  }

  const seen = new Set<string>();
  for (const tx of args.existing) {
    const key = transactionDuplicateKey(tx.date, tx.kind, tx.amountCents, tx.note);
    if (key) seen.add(key);
  }

  return table.rows.map(({ rowNumber, values, parseError = null }) => {
    if (parseError) return { rowNumber, values, transaction: null, duplicate: false, error: parseError };
    if (values.every((value) => value.trim() === "")) return { rowNumber, values, transaction: null, duplicate: false, error: "Empty row." };

    const dateValue = values[mapping.dateColumn] ?? "";
    const parsedDate = parseStatementDate(dateValue, mapping.dateFormat);
    if (!parsedDate.ok) return { rowNumber, values, transaction: null, duplicate: false, error: parsedDate.error };

    if (mapping.currencyColumn !== null) {
      const rowCurrency = parseStatementCurrency(values[mapping.currencyColumn] ?? "");
      if (!rowCurrency) return { rowNumber, values, transaction: null, duplicate: false, error: "This row has a blank or unsupported currency." };
      if (rowCurrency !== currency) return { rowNumber, values, transaction: null, duplicate: false, error: `This row is ${rowCurrency}, but ${currency} is selected.` };
    }

    const description = mapping.descriptionColumn === null ? "" : (values[mapping.descriptionColumn] ?? "").trim().slice(0, 80);
    const parsedAmount = parseMappedAmount(values, mapping.amount, currency);
    if (!parsedAmount.ok) return { rowNumber, values, transaction: null, duplicate: false, error: parsedAmount.error };

    const transaction: StagedTransaction = {
      date: parsedDate.date,
      kind: parsedAmount.kind,
      amountCents: parsedAmount.amountCents,
      category: parsedAmount.kind === "income" ? "Other" : "Personal",
      note: description || "Bank statement import",
    };
    const key = transactionDuplicateKey(transaction.date, transaction.kind, transaction.amountCents, description);
    const duplicate = key !== null && seen.has(key);
    if (key) seen.add(key);
    return { rowNumber, values, transaction, duplicate, error: null };
  });
}

export function transactionsToCsv(transactions: Transaction[], currency: Currency): string {
  const rows = ["Date,Type,Amount,Currency,Category,Description"];
  for (const transaction of [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)) {
    const absolute = Math.abs(transaction.amountCents);
    const amount = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
    rows.push([
      transaction.date,
      transaction.kind,
      amount,
      currency,
      transaction.category,
      transaction.note,
    ].map(csvCell).join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function validateColumn(column: number, width: number, label: string) {
  if (!Number.isInteger(column) || column < 0 || column >= width) throw new Error(`Choose a valid ${label.toLocaleLowerCase("en-US")} column.`);
}

function parseMappedAmount(values: string[], mapping: StatementAmountMapping, currency: Currency):
  | { ok: true; kind: TxKind; amountCents: number }
  | { ok: false; error: string } {
  if (mapping.mode === "signed") {
    const raw = values[mapping.amountColumn] ?? "";
    const mismatch = currencySymbolMismatch(raw, currency);
    if (mismatch) return { ok: false, error: mismatch };
    const parsed = parseAmount(raw);
    if (!parsed.ok) return parsed;
    if (parsed.amountCents === 0) return { ok: false, error: "Amount must be greater than zero." };
    const positiveKind = mapping.positiveAmounts;
    return {
      ok: true,
      kind: parsed.negative ? (positiveKind === "income" ? "expense" : "income") : positiveKind,
      amountCents: parsed.amountCents,
    };
  }

  const debit = (values[mapping.debitColumn] ?? "").trim();
  const credit = (values[mapping.creditColumn] ?? "").trim();
  const debitMismatch = currencySymbolMismatch(debit, currency);
  if (debitMismatch) return { ok: false, error: debitMismatch };
  const creditMismatch = currencySymbolMismatch(credit, currency);
  if (creditMismatch) return { ok: false, error: creditMismatch };
  const parsedDebit = debit === "" ? { ok: true as const, negative: false, amountCents: 0 } : parseAmount(debit);
  const parsedCredit = credit === "" ? { ok: true as const, negative: false, amountCents: 0 } : parseAmount(credit);
  if (!parsedDebit.ok) return parsedDebit;
  if (!parsedCredit.ok) return parsedCredit;
  if (parsedDebit.negative || parsedCredit.negative) return { ok: false, error: "Debit and credit values must be zero or positive." };
  if (parsedDebit.amountCents > 0 && parsedCredit.amountCents > 0) return { ok: false, error: "This row has both debit and credit amounts." };
  if (parsedDebit.amountCents === 0 && parsedCredit.amountCents === 0) return { ok: false, error: "This row has no debit or credit amount." };
  return parsedDebit.amountCents > 0
    ? { ok: true, kind: "expense", amountCents: parsedDebit.amountCents }
    : { ok: true, kind: "income", amountCents: parsedCredit.amountCents };
}

function parseAmount(input: string):
  | { ok: true; negative: boolean; amountCents: number }
  | { ok: false; error: string } {
  const cleaned = input.trim().replace(/[\s,$₹]/g, "");
  if (!cleaned) return { ok: false, error: "Amount is blank." };
  const accountingNegative = cleaned.startsWith("(") && cleaned.endsWith(")");
  const unsigned = accountingNegative ? cleaned.slice(1, -1) : cleaned;
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(unsigned)) return { ok: false, error: "Use an amount with at most two decimal places." };
  const negative = accountingNegative || unsigned.startsWith("-");
  const numberText = unsigned.replace(/^[+-]/, "");
  const [whole, fractional = ""] = numberText.split(".");
  const amountCents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountCents) || amountCents > 10_000_000_000) return { ok: false, error: "Amount is outside the supported range." };
  return { ok: true, negative, amountCents };
}

function currencySymbolMismatch(value: string, currency: Currency): string | null {
  const hasRupee = value.includes("₹");
  const hasDollar = value.includes("$");
  if (hasRupee && hasDollar) return "This amount has conflicting currency symbols.";
  if (currency === "INR" && hasDollar) return "This row shows USD, but the import currency is INR.";
  if (currency === "USD" && hasRupee) return "This row shows INR, but the import currency is USD.";
  return null;
}

function parseStatementCurrency(value: string): Currency | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (["inr", "₹", "rupee", "rupees", "indian rupee"].includes(normalized)) return "INR";
  if (["usd", "$", "us dollar", "us dollars", "dollar", "dollars"].includes(normalized)) return "USD";
  return null;
}

function parseStatementDate(value: string, format: StatementDateFormat): { ok: true; date: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso) return makeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (!parts) return { ok: false, error: "Use YYYY-MM-DD or a date matching the selected date format." };
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  let month: number;
  let day: number;
  if (format === "mdy") {
    month = first;
    day = second;
  } else if (format === "dmy") {
    day = first;
    month = second;
  } else if (first > 12 && second <= 12) {
    day = first;
    month = second;
  } else if (second > 12 && first <= 12) {
    month = first;
    day = second;
  } else {
    return { ok: false, error: "Ambiguous date; choose MM/DD/YYYY or DD/MM/YYYY." };
  }
  return makeDate(Number(parts[3]), month, day);
}

function makeDate(year: number, month: number, day: number): { ok: true; date: string } | { ok: false; error: string } {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, error: "This row has an invalid calendar date." };
  }
  return { ok: true, date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

function transactionDuplicateKey(date: string, kind: TxKind, amount: number, description: string): string | null {
  const normalized = description.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  return normalized ? `${date}|${kind}|${amount}|${normalized}` : null;
}
