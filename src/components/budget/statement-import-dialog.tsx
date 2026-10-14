import { useRef, useState, type ChangeEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  buildStatementPreview,
  parseStatementCsv,
  suggestStatementMapping,
  type CsvTable,
  type StatementAmountMapping,
  type StatementDateFormat,
  type StatementMapping,
  type StatementPreviewRow,
  type StagedTransaction,
} from "@/lib/bank-statement";
import { extractPdfStatement } from "@/lib/pdf-statement";
import { formatSigned, type Currency, type Transaction } from "@/lib/budget";

type ImportDialogProps = {
  open: boolean;
  currency: Currency;
  getExisting: (currency: Currency) => Transaction[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (currency: Currency, transactions: StagedTransaction[]) => void;
};

type AmountMode = "signed" | "debit-credit";

function columnValue(column: string): number | null {
  return column === "" ? null : Number(column);
}

export function StatementImportDialog({
  open,
  currency: initialCurrency,
  getExisting,
  onOpenChange,
  onConfirm,
}: ImportDialogProps) {
  const [table, setTable] = useState<CsvTable | null>(null);
  const [fileName, setFileName] = useState("");
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  const [dateColumn, setDateColumn] = useState("");
  const [descriptionColumn, setDescriptionColumn] = useState("");
  const [currencyColumn, setCurrencyColumn] = useState("");
  const [dateFormat, setDateFormat] = useState<StatementDateFormat>("auto");
  const [amountMode, setAmountMode] = useState<AmountMode>("signed");
  const [amountColumn, setAmountColumn] = useState("");
  const [debitColumn, setDebitColumn] = useState("");
  const [creditColumn, setCreditColumn] = useState("");
  const [positiveAmounts, setPositiveAmounts] = useState<"" | "income" | "expense">("");
  const [preview, setPreview] = useState<StatementPreviewRow[] | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState<Record<number, boolean>>({});
  const [error, setError] = useState("");
  const [pdfWarnings, setPdfWarnings] = useState<string[]>([]);
  const [isPdf, setIsPdf] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const readToken = useRef(0);

  function reset() {
    readToken.current += 1;
    setIsReading(false);
    setTable(null);
    setFileName("");
    setCurrency(initialCurrency);
    setDateColumn("");
    setDescriptionColumn("");
    setCurrencyColumn("");
    setDateFormat("auto");
    setAmountMode("signed");
    setAmountColumn("");
    setDebitColumn("");
    setCreditColumn("");
    setPositiveAmounts("");
    setPreview(null);
    setIncludeDuplicates({});
    setError("");
    setPdfWarnings([]);
    setIsPdf(false);
  }

  function onDialogChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const token = ++readToken.current;
    setIsReading(true);
    setError("");
    setTable(null);
    setFileName("");
    setPreview(null);
    try {
      const isPdfFile =
        file.name.toLocaleLowerCase("en-US").endsWith(".pdf") || file.type === "application/pdf";
      const extracted = isPdfFile ? await extractPdfStatement(file) : null;
      const parsed = extracted?.table ?? parseStatementCsv(await file.text());
      if (token !== readToken.current) return;
      const suggested = suggestStatementMapping(parsed.headers);
      setTable(parsed);
      setIsPdf(isPdfFile);
      setPdfWarnings(extracted?.warnings ?? []);
      setFileName(file.name);
      setDateColumn(suggested.dateColumn === null ? "" : String(suggested.dateColumn));
      setDescriptionColumn(
        suggested.descriptionColumn === null ? "" : String(suggested.descriptionColumn),
      );
      setCurrencyColumn(suggested.currencyColumn === null ? "" : String(suggested.currencyColumn));
      setDateFormat("auto");
      setAmountColumn(suggested.amountColumn === null ? "" : String(suggested.amountColumn));
      setDebitColumn(suggested.debitColumn === null ? "" : String(suggested.debitColumn));
      setCreditColumn(suggested.creditColumn === null ? "" : String(suggested.creditColumn));
      setAmountMode(
        suggested.debitColumn !== null && suggested.creditColumn !== null
          ? "debit-credit"
          : "signed",
      );
      setPositiveAmounts("");
      setIncludeDuplicates({});
    } catch (failure) {
      if (token !== readToken.current) return;
      setTable(null);
      setFileName("");
      setError(failure instanceof Error ? failure.message : "This statement could not be read.");
    } finally {
      if (token === readToken.current) setIsReading(false);
    }
  }

  function createMapping(): StatementMapping {
    const dateIndex = columnValue(dateColumn);
    if (dateIndex === null) throw new Error("Choose the statement's date column.");
    const descriptionIndex = columnValue(descriptionColumn);
    const currencyIndex = columnValue(currencyColumn);
    let amount: StatementAmountMapping;
    if (amountMode === "signed") {
      const amountIndex = columnValue(amountColumn);
      if (amountIndex === null) throw new Error("Choose the signed amount column.");
      if (!positiveAmounts)
        throw new Error("Choose whether positive signed amounts mean income or expenses.");
      amount = { mode: "signed", amountColumn: amountIndex, positiveAmounts };
    } else {
      const debitIndex = columnValue(debitColumn);
      const creditIndex = columnValue(creditColumn);
      if (debitIndex === null || creditIndex === null)
        throw new Error("Choose both debit and credit columns.");
      amount = { mode: "debit-credit", debitColumn: debitIndex, creditColumn: creditIndex };
    }
    return {
      dateColumn: dateIndex,
      descriptionColumn: descriptionIndex,
      currencyColumn: currencyIndex,
      dateFormat,
      amount,
    };
  }

  function makePreview() {
    if (!table) return;
    try {
      const rows = buildStatementPreview({
        table,
        mapping: createMapping(),
        currency,
        existing: getExisting(currency),
      });
      setPreview(rows);
      setIncludeDuplicates({});
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Check the selected columns and try again.",
      );
    }
  }

  const validRows = (preview ?? []).filter((row) => row.transaction && !row.error);
  const duplicateRows = validRows.filter((row) => row.duplicate);
  const selectedRows = validRows.filter(
    (row) => !row.duplicate || includeDuplicates[row.rowNumber] === true,
  );
  const invalidCount = (preview ?? []).filter(
    (row) => row.error && row.error !== "Empty row.",
  ).length;
  const duplicateCount = duplicateRows.length;

  return (
    <Dialog.Root open={open} onOpenChange={onDialogChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/45 backdrop-blur-[2px]" />
        <div className="fixed inset-0 z-50 flex items-end justify-center p-2 sm:items-center sm:p-4">
          <Dialog.Content className="panel w-full max-w-3xl overflow-hidden border border-line shadow-xl sm:max-h-[90vh]">
            <Dialog.Title className="font-display text-2xl tracking-tight">
              Import bank statement
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              The file is read in this browser only. Map its columns, review dates and duplicates,
              then confirm the import.
            </Dialog.Description>

            <div className="mt-5 flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1">
              <div className="flex flex-wrap items-center gap-3">
                <label className="btn btn-quiet cursor-pointer">
                  {isReading ? "Reading statement…" : "Choose CSV or PDF file"}
                  <input
                    className="sr-only"
                    type="file"
                    accept=".csv,text/csv,.pdf,application/pdf"
                    disabled={isReading}
                    onChange={(event) => void readFile(event)}
                  />
                </label>
                {fileName ? (
                  <span className="max-w-full truncate text-sm text-muted">
                    {fileName} · {table?.rows.length ?? 0} data rows
                  </span>
                ) : null}
                <label className="ml-auto flex items-center gap-2 text-sm font-medium">
                  Import currency
                  <select
                    className="field select w-32"
                    value={currency}
                    onChange={(event) => {
                      setCurrency(event.target.value as Currency);
                      setPreview(null);
                    }}
                  >
                    <option value="INR">INR · ₹</option>
                    <option value="USD">USD · $</option>
                  </select>
                </label>
              </div>

              {table ? (
                <>
                  <section
                    className="rounded-md border border-line p-3"
                    aria-labelledby="mapping-heading"
                  >
                    <h3 id="mapping-heading" className="font-medium">
                      Map statement columns
                    </h3>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="grid gap-1 text-sm">
                        Date column
                        <select
                          className="field select"
                          value={dateColumn}
                          onChange={(event) => {
                            setDateColumn(event.target.value);
                            setPreview(null);
                          }}
                        >
                          <option value="">Choose date column</option>
                          {table.headers.map((header, index) => (
                            <option key={index} value={index}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-sm">
                        Description / merchant column (optional)
                        <select
                          className="field select"
                          value={descriptionColumn}
                          onChange={(event) => {
                            setDescriptionColumn(event.target.value);
                            setPreview(null);
                          }}
                        >
                          <option value="">No description column</option>
                          {table.headers.map((header, index) => (
                            <option key={index} value={index}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-sm">
                        Currency column (optional)
                        <select
                          className="field select"
                          value={currencyColumn}
                          onChange={(event) => {
                            setCurrencyColumn(event.target.value);
                            setPreview(null);
                          }}
                        >
                          <option value="">Use selected currency for every row</option>
                          {table.headers.map((header, index) => (
                            <option key={index} value={index}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1 text-sm">
                        Date format
                        <select
                          className="field select"
                          value={dateFormat}
                          onChange={(event) => {
                            setDateFormat(event.target.value as StatementDateFormat);
                            setPreview(null);
                          }}
                        >
                          <option value="auto">ISO / infer only unambiguous dates</option>
                          <option value="mdy">MM/DD/YYYY</option>
                          <option value="dmy">DD/MM/YYYY</option>
                        </select>
                      </label>
                      <label className="grid gap-1 text-sm">
                        Amount columns
                        <select
                          className="field select"
                          value={amountMode}
                          onChange={(event) => {
                            setAmountMode(event.target.value as AmountMode);
                            setPreview(null);
                          }}
                        >
                          <option value="signed">One signed amount</option>
                          <option value="debit-credit">Separate debit and credit</option>
                        </select>
                      </label>
                      {amountMode === "signed" ? (
                        <>
                          <label className="grid gap-1 text-sm">
                            Amount column
                            <select
                              className="field select"
                              value={amountColumn}
                              onChange={(event) => {
                                setAmountColumn(event.target.value);
                                setPreview(null);
                              }}
                            >
                              <option value="">Choose amount column</option>
                              {table.headers.map((header, index) => (
                                <option key={index} value={index}>
                                  {header}
                                </option>
                              ))}
                            </select>
                          </label>
                          <fieldset className="grid gap-1 text-sm">
                            <legend>Positive amounts mean</legend>
                            <div className="flex flex-wrap gap-2">
                              {(["income", "expense"] as const).map((kind) => (
                                <button
                                  key={kind}
                                  type="button"
                                  aria-pressed={positiveAmounts === kind}
                                  className={`btn ${positiveAmounts === kind ? "btn-primary" : "btn-quiet"}`}
                                  onClick={() => {
                                    setPositiveAmounts(kind);
                                    setPreview(null);
                                  }}
                                >
                                  {kind === "income" ? "Income" : "Expense"}
                                </button>
                              ))}
                            </div>
                          </fieldset>
                        </>
                      ) : (
                        <>
                          <label className="grid gap-1 text-sm">
                            Debit column
                            <select
                              className="field select"
                              value={debitColumn}
                              onChange={(event) => {
                                setDebitColumn(event.target.value);
                                setPreview(null);
                              }}
                            >
                              <option value="">Choose debit column</option>
                              {table.headers.map((header, index) => (
                                <option key={index} value={index}>
                                  {header}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-1 text-sm">
                            Credit column
                            <select
                              className="field select"
                              value={creditColumn}
                              onChange={(event) => {
                                setCreditColumn(event.target.value);
                                setPreview(null);
                              }}
                            >
                              <option value="">Choose credit column</option>
                              {table.headers.map((header, index) => (
                                <option key={index} value={index}>
                                  {header}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                    </div>
                    <p className="mt-3 text-xs text-muted">
                      Rows without a category will use Personal for expenses and Other for income.
                      You can edit categories later. Currency is never converted.
                    </p>
                    <button type="button" className="btn btn-quiet mt-3" onClick={makePreview}>
                      Preview import
                    </button>
                  </section>

                  {preview ? (
                    <section aria-labelledby="preview-heading">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 id="preview-heading" className="font-medium">
                          Preview · {selectedRows.length} selected
                        </h3>
                        <p className="text-xs text-muted">
                          {duplicateCount} possible duplicates · {invalidCount} rows need attention
                        </p>
                      </div>
                      {duplicateCount ? (
                        <p className="mt-1 text-xs text-muted">
                          Possible duplicates are excluded unless you check “Import anyway”.
                        </p>
                      ) : null}
                      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
                        <table className="w-full text-left text-xs sm:text-sm">
                          <thead className="sticky top-0 bg-page text-muted">
                            <tr>
                              <th className="p-2">Row / date</th>
                              <th className="p-2">Description</th>
                              <th className="p-2">Amount</th>
                              <th className="p-2">Review</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.map((row) => (
                              <tr key={row.rowNumber} className="border-t border-line align-top">
                                <td className="p-2 tabular-nums">
                                  {row.transaction?.date ??
                                    row.values[columnValue(dateColumn) ?? 0]}{" "}
                                  <span className="text-muted">#{row.rowNumber}</span>
                                </td>
                                <td className="max-w-40 p-2 break-words">
                                  {row.transaction?.note ?? "—"}
                                </td>
                                <td className="p-2 tabular-nums whitespace-nowrap">
                                  {row.transaction
                                    ? formatSigned(
                                        row.transaction.kind,
                                        row.transaction.amountCents,
                                        currency,
                                      )
                                    : "—"}
                                </td>
                                <td className="min-w-36 p-2">
                                  {row.error === "Empty row." ? (
                                    <span className="text-muted">Blank row</span>
                                  ) : row.error ? (
                                    <span className="text-expense">{row.error}</span>
                                  ) : row.duplicate ? (
                                    <label className="flex items-start gap-1">
                                      <input
                                        type="checkbox"
                                        checked={includeDuplicates[row.rowNumber] === true}
                                        onChange={(event) =>
                                          setIncludeDuplicates((current) => ({
                                            ...current,
                                            [row.rowNumber]: event.target.checked,
                                          }))
                                        }
                                      />
                                      <span>Possible duplicate · Import anyway</span>
                                    </label>
                                  ) : (
                                    <span className="text-muted">Ready</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        Dates stay with their source rows. After import, the view moves to the
                        latest imported month. Nothing is saved until you confirm.
                      </p>
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="rounded-md bg-track p-4 text-sm text-muted">
                  Files stay on this device. CSV files need unique column headers. Text-based PDFs
                  use a best-effort column layout guess and must be reviewed. Scanned/image-only
                  PDFs, password-protected files, and unsupported layouts cannot be imported.
                </div>
              )}
              {isPdf && table ? (
                <div className="grid gap-2 rounded-md border border-line bg-page p-3 text-sm text-muted">
                  <p className="font-medium text-ink">
                    PDF text extraction - {table.rows.length} candidate rows
                  </p>
                  {pdfWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  <details className="mt-1">
                    <summary className="cursor-pointer font-medium text-ink">
                      Correct extracted values before preview
                    </summary>
                    <p className="mt-2 text-xs">
                      PDF coordinates can shift columns. Fix any cell that landed under the wrong
                      header, then preview the rows again.
                    </p>
                    <div className="mt-2 grid gap-3">
                      {table.rows.map((row, rowIndex) => (
                        <fieldset
                          key={row.rowNumber}
                          className="grid gap-2 rounded border border-line p-2"
                        >
                          <legend className="px-1 text-xs font-medium">
                            Extracted row {row.rowNumber}
                          </legend>
                          {table.headers.map((header, columnIndex) => (
                            <label
                              key={`${row.rowNumber}-${columnIndex}`}
                              className="grid gap-1 text-xs"
                            >
                              {header}
                              <input
                                className="field"
                                value={row.values[columnIndex] ?? ""}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setTable((current) =>
                                    current
                                      ? {
                                          ...current,
                                          rows: current.rows.map((candidate, index) =>
                                            index === rowIndex
                                              ? {
                                                  ...candidate,
                                                  parseError: undefined,
                                                  values: candidate.values.map((cell, cellIndex) =>
                                                    cellIndex === columnIndex ? value : cell,
                                                  ),
                                                }
                                              : candidate,
                                          ),
                                        }
                                      : current,
                                  );
                                  setPreview(null);
                                }}
                              />
                            </label>
                          ))}
                        </fieldset>
                      ))}
                    </div>
                  </details>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-expense">
                  {error}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-quiet">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn-primary"
                disabled={isReading || selectedRows.length === 0}
                onClick={() =>
                  onConfirm(
                    currency,
                    selectedRows.flatMap((row) => (row.transaction ? [row.transaction] : [])),
                  )
                }
              >
                Import {selectedRows.length} {selectedRows.length === 1 ? "entry" : "entries"}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
