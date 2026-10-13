import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { EntryDialog } from "@/components/budget/entry-dialog";
import { StatementImportDialog } from "@/components/budget/statement-import-dialog";
import { SpendingChatPanel } from "@/components/budget/spending-chat-panel";
import { transactionsToCsv, type StagedTransaction } from "@/lib/bank-statement";
import { createTransactionReportPdf } from "@/lib/transaction-report-pdf";
import {
  centsToInput,
  defaultDateForMonth,
  formatDay,
  formatMoney,
  formatSigned,
  budgetStatus,
  EXPENSE_CATEGORIES,
  inMonth,
  loadBudget,
  makeBackup,
  monthKey,
  monthTitle,
  parseBackup,
  parseMoneyToCents,
  saveBudget,
  settingsForMonth,
  shiftMonth,
  spendingByCategory,
  type BudgetData,
  type Currency,
  type Transaction,
  type TxKind,
} from "@/lib/budget";

const SpendChart = lazy(() =>
  import("@/components/budget/spend-chart").then((mod) => ({ default: mod.SpendChart })),
);

type Filter = "all" | TxKind;

type Editor =
  | { mode: "create" }
  | { mode: "edit"; tx: Transaction };

function groupByDate(transactions: Transaction[]): Array<{ date: string; items: Transaction[] }> {
  const groups: Array<{ date: string; items: Transaction[] }> = [];
  for (const tx of transactions) {
    const last = groups[groups.length - 1];
    if (!last || last.date !== tx.date) groups.push({ date: tx.date, items: [tx] });
    else last.items.push(tx);
  }
  return groups;
}

function downloadText(filename: string, text: string, mimeType = "application/json;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function BudgetApp() {
  const [data, setData] = useState<BudgetData | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [goalEdit, setGoalEdit] = useState(false);
  const [goalName, setGoalName] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalError, setGoalError] = useState("");
  const [loadError, setLoadError] = useState<{ message: string; raw: string | null } | null>(null);
  const [persistenceError, setPersistenceError] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [budgetErrors, setBudgetErrors] = useState<Record<string, string>>({});
  const [statementImportOpen, setStatementImportOpen] = useState(false);
  const [reportExporting, setReportExporting] = useState(false);
  const [reportExportError, setReportExportError] = useState("");

  useEffect(() => {
    const now = new Date();
    const result = loadBudget(now);
    if (result.status === "error") setLoadError({ message: result.message, raw: result.raw });
    else setData(result.data);
    setMonth(monthKey(now));
  }, []);

  useEffect(() => {
    if (data) {
      try {
        saveBudget(data);
        setPersistenceError("");
      } catch {
        setPersistenceError("Tally could not save to this browser. Export a backup before leaving this page.");
      }
    }
  }, [data]);

  useEffect(() => {
    setPendingDelete(null);
    setConfirmClear(false);
    setGoalEdit(false);
    setBudgetDrafts({});
    setBudgetErrors({});
  }, [month]);

  const view = useMemo(() => {
    if (!data || !month) return null;
    const monthTx = data.transactions
      .filter((tx) => inMonth(tx.date, month))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    const income = monthTx
      .filter((tx) => tx.kind === "income")
      .reduce((sum, tx) => sum + tx.amountCents, 0);
    const spending = monthTx
      .filter((tx) => tx.kind === "expense")
      .reduce((sum, tx) => sum + tx.amountCents, 0);
    const visible =
      filter === "all" ? monthTx : monthTx.filter((tx) => tx.kind === filter);
    return {
      monthTx,
      visible,
      groups: groupByDate(visible),
      income,
      spending,
      remaining: income - spending,
      rows: spendingByCategory(monthTx),
    };
  }, [data, month, filter]);

  function update(fn: (current: BudgetData) => BudgetData) {
    setData((current) => (current ? fn(current) : current));
  }

  function openCreate() {
    setEditor({ mode: "create" });
  }

  function changeCurrency(currency: Currency) {
    const result = loadBudget(new Date(), currency);
    if (result.status === "error") {
      setLoadError({ message: result.message, raw: result.raw });
      setData(null);
      return;
    }
    setLoadError(null);
    setPersistenceError("");
    setData(result.data);
    setMonth(monthKey(new Date()));
  }

  async function exportReport() {
    if (!data || !month || reportExporting) return;
    setReportExporting(true);
    setReportExportError("");
    try {
      const bytes = await createTransactionReportPdf(data, month);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `tally-${data.currency.toLowerCase()}-${month}-report.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setReportExportError("Tally could not create this PDF report. Try exporting again.");
    } finally {
      setReportExporting(false);
    }
  }

  function saveCategoryBudget(category: string) {
    const selectedMonth = month;
    if (!selectedMonth) return;
    const input = budgetDrafts[category] ?? "";
    if (input.trim() === "") {
      update((currentData) => {
        const currentSettings = settingsForMonth(currentData, selectedMonth);
        const categoryBudgets = { ...currentSettings.categoryBudgets };
        delete categoryBudgets[category];
        return {
          ...currentData,
          settingsByMonth: {
            ...currentData.settingsByMonth,
            [selectedMonth]: { ...currentSettings, categoryBudgets },
          },
        };
      });
      setBudgetErrors((current) => ({ ...current, [category]: "" }));
      return;
    }
    const cents = parseMoneyToCents(input);
    if (cents === null) {
      setBudgetErrors((current) => ({ ...current, [category]: "Enter a limit above zero, or leave blank for no limit." }));
      return;
    }
    update((currentData) => {
      const currentSettings = settingsForMonth(currentData, selectedMonth);
      return {
        ...currentData,
        settingsByMonth: {
          ...currentData.settingsByMonth,
          [selectedMonth]: {
            ...currentSettings,
            categoryBudgets: { ...currentSettings.categoryBudgets, [category]: cents },
          },
        },
      };
    });
    setBudgetErrors((current) => ({ ...current, [category]: "" }));
  }

  function importStatement(currency: Currency, rows: StagedTransaction[]) {
    if (!data || rows.length === 0) return;
    let destination = data;
    if (data.currency !== currency) {
      const result = loadBudget(new Date(), currency);
      if (result.status === "error") {
        setLoadError({ message: result.message, raw: result.raw });
        setData(null);
        setStatementImportOpen(false);
        return;
      }
      destination = result.data;
    }
    const imported: Transaction[] = rows.map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      sample: false,
    }));
    const next: BudgetData = {
      ...destination,
      transactions: [...destination.transactions, ...imported],
      sample: destination.transactions.some((transaction) => transaction.sample),
    };
    setData(next);
    setLoadError(null);
    setPersistenceError("");
    setStatementImportOpen(false);
    setMonth(imported.map((transaction) => transaction.date.slice(0, 7)).sort().at(-1) ?? monthKey(new Date()));
  }

  async function restoreBackup(file: File | undefined) {
    if (!file) return;
    const restored = parseBackup(await file.text());
    if (!restored) {
      setRecoveryError("That file is not a valid Tally backup.");
      return;
    }
    const confirmed = window.confirm(
      `Replace the saved ${restored.currency} ledger with this backup? This replaces that currency's ledger on this device.`,
    );
    if (!confirmed) return;
    try {
      saveBudget(restored);
      setData(restored);
      setLoadError(null);
      setRecoveryError("");
      setPersistenceError("");
      setMonth(monthKey(new Date()));
    } catch {
      setRecoveryError("This browser could not save the restored backup. Try freeing browser storage and import again.");
    }
  }

  if (!data || !month || !view) {
    if (loadError) {
      return (
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10 sm:px-6">
          <h1 className="font-display text-3xl tracking-tight">Recover your Tally ledger</h1>
          <section className="panel" role="alert">
            <p className="font-medium">Your saved data was not changed.</p>
            <p className="mt-2 text-sm text-muted">{loadError.message} Import a valid Tally JSON backup to restore it.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <label className="btn btn-primary">
                Import backup
                <input
                  className="sr-only"
                  type="file"
                  accept="application/json,.json"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    const restored = parseBackup(await file.text());
                    if (!restored) {
                      setRecoveryError("That file is not a valid Tally backup. The saved value is still untouched.");
                      return;
                    }
                    try {
                      saveBudget(restored);
                      setData(restored);
                      setLoadError(null);
                      setRecoveryError("");
                    } catch {
                      setRecoveryError("This browser could not save the restored backup. Try freeing browser storage and import again.");
                    }
                  }}
                />
              </label>
              {loadError.raw !== null ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => downloadText("tally-recovery.json", loadError.raw ?? "")}
                >
                  Download saved value
                </button>
              ) : null}
            </div>
            {recoveryError ? <p className="mt-3 text-sm text-expense" role="alert">{recoveryError}</p> : null}
          </section>
        </main>
      );
    }
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-10">
        <div className="h-10 w-36 rounded-sm bg-track" />
        <div className="panel h-40" />
        <div className="panel h-64" />
      </main>
    );
  }

  const current = monthKey(new Date());
  const title = monthTitle(month);
  const settings = settingsForMonth(data, month);
  const target = settings.goalTargetCents;
  const progress =
    target > 0 ? Math.min(100, Math.max(0, (Math.max(view.remaining, 0) / target) * 100)) : 0;
  const percent = Math.round(progress);
  const gap = target - view.remaining;

  let goalLabel = "Still to save";
  let goalValue = formatMoney(Math.max(gap, 0), data.currency);
  let goalDetail = `${formatMoney(Math.max(gap, 0), data.currency)} still to set aside.`;
  if (view.remaining < 0) {
    goalLabel = "Overspent";
    goalValue = formatMoney(Math.abs(view.remaining), data.currency);
    goalDetail = `Overspent by ${formatMoney(Math.abs(view.remaining), data.currency)}. The goal waits until spending comes back down.`;
  } else if (view.remaining >= target) {
    const extra = view.remaining - target;
    goalLabel = extra === 0 ? "Goal met" : "Ahead";
    goalValue = formatMoney(extra, data.currency);
    goalDetail =
      extra === 0
        ? "The savings goal is met for this month."
        : `Goal met, with ${formatMoney(extra, data.currency)} still unspent.`;
  }

  const rowIsSample = (tx: Transaction) => tx.sample !== false && Boolean(tx.sample || data.sample);
  const hasSample = view.monthTx.some(rowIsSample);
  const hasUser = view.monthTx.some((tx) => !rowIsSample(tx));

  const top = view.rows[0];

  function saveGoal() {
    const selectedMonth = month;
    if (!selectedMonth) return;
    const name = goalName.trim();
    const cents = parseMoneyToCents(goalTarget);
    if (name.length === 0) {
      setGoalError("Name the goal.");
      return;
    }
    if (cents === null) {
      setGoalError("Enter a target above zero.");
      return;
    }
    update((currentData) => ({
      ...currentData,
      settingsByMonth: {
        ...currentData.settingsByMonth,
        [selectedMonth]: {
          ...settingsForMonth(currentData, selectedMonth),
          goalName: name.slice(0, 40),
          goalTargetCents: cents,
        },
      },
    }));
    setGoalEdit(false);
    setGoalError("");
  }

  return (
    <main className="overflow-x-clip">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 32 32" className="size-9 shrink-0" aria-hidden="true">
              <rect width="32" height="32" rx="8" className="fill-accent" />
              <path
                d="M8 11.5h16M8 16h11M8 20.5h16"
                className="stroke-accent-fg"
                strokeWidth="2.25"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            <div>
              <h1 className="font-display text-2xl leading-none tracking-tight">Tally</h1>
              <p className="mt-1 text-sm text-muted">Budget planner</p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 sm:w-auto">
            <label className="sr-only" htmlFor="currency-select">Ledger currency</label>
            <select
              id="currency-select"
              className="field select min-w-0 w-full sm:min-w-36 sm:w-auto"
              aria-label="Ledger currency"
              value={data.currency}
              onChange={(event) => changeCurrency(event.target.value as Currency)}
            >
              <option value="INR">INR · Indian rupee</option>
              <option value="USD">USD · US dollar</option>
            </select>
            <details className="relative min-w-0">
              <summary className="btn btn-quiet list-none whitespace-nowrap [&::-webkit-details-marker]:hidden" aria-label="More data actions">More</summary>
              <div className="absolute right-0 top-full z-30 mt-2 flex min-w-52 flex-col rounded-md border border-line bg-surface p-1 shadow-lg" aria-label="More data actions">
                <button
                  type="button"
                  className="btn h-auto min-h-11 justify-start px-3 text-left"
                  onClick={(event) => {
                    downloadText(`tally-${data.currency.toLowerCase()}-${month}.json`, makeBackup(data));
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Export backup
                </button>
                <button
                  type="button"
                  className="btn h-auto min-h-11 justify-start px-3 text-left"
                  onClick={(event) => {
                    downloadText(
                      `tally-${data.currency.toLowerCase()}-transactions.csv`,
                      transactionsToCsv(data.transactions, data.currency),
                      "text/csv;charset=utf-8",
                    );
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="btn h-auto min-h-11 justify-start px-3 text-left"
                  disabled={reportExporting}
                  onClick={(event) => {
                    void exportReport();
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  {reportExporting ? "Preparing PDF…" : "Export monthly PDF"}
                </button>
                <button
                  type="button"
                  className="btn h-auto min-h-11 justify-start px-3 text-left"
                  onClick={(event) => {
                    setStatementImportOpen(true);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  Import statement
                </button>
                <label className="btn h-auto min-h-11 justify-start px-3 text-left">
                  Restore backup
                  <input
                    className="sr-only"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      void restoreBackup(event.target.files?.[0]);
                      event.currentTarget.value = "";
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  />
                </label>
              </div>
            </details>
            <button type="button" id="add-entry" className="btn btn-primary whitespace-nowrap" onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Add entry
            </button>
            </div>
            <nav className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-center" aria-label="Month navigation">
              <div className="flex min-w-0 items-center">
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                aria-label="Previous month"
                onClick={() => setMonth((value) => (value ? shiftMonth(value, -1) : value))}
              >
                <ChevronLeft className="size-5" aria-hidden="true" />
              </button>
              <p className="min-w-0 flex-1 px-1 text-center font-medium sm:min-w-40">{title}</p>
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                aria-label="Next month"
                onClick={() => setMonth((value) => (value ? shiftMonth(value, 1) : value))}
              >
                <ChevronRight className="size-5" aria-hidden="true" />
              </button>
              </div>
            {month !== current ? (
              <button type="button" className="btn btn-quiet shrink-0" onClick={() => setMonth(current)}>
                This month
              </button>
            ) : null}
            </nav>
          </div>
        </header>

        {persistenceError ? (
          <p className="rounded-md border border-expense/30 bg-expense/5 px-4 py-3 text-sm" role="alert">
            {persistenceError} Use Export backup to keep a copy.
          </p>
        ) : null}
        {reportExportError ? <p className="rounded-md border border-expense/30 bg-expense/5 px-4 py-3 text-sm" role="alert">{reportExportError}</p> : null}

        <section className="panel" aria-labelledby="remaining-label">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p id="remaining-label" className="text-sm font-medium text-muted">
                Remaining
              </p>
              <p
                id="remaining-balance"
                key={view.remaining}
                className={`num-swap mt-1 text-4xl font-medium tracking-tight tabular-nums sm:text-5xl ${
                  view.remaining < 0 ? "amount-out" : ""
                }`}
                aria-live="polite"
                aria-atomic="true"
              >
                {formatMoney(view.remaining, data.currency)}
              </p>
              <p className="mt-2 text-sm text-muted">Income minus spending for {title}</p>
            </div>
            <dl className="grid flex-1 grid-cols-3 divide-x divide-line sm:max-w-md">
              <div className="pr-3">
                <dt className="text-xs font-medium text-muted">Income</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums whitespace-nowrap sm:text-base">
                  {formatMoney(view.income, data.currency)}
                </dd>
              </div>
              <div className="px-3">
                <dt className="text-xs font-medium text-muted">Spent</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums whitespace-nowrap sm:text-base">
                  {formatMoney(view.spending, data.currency)}
                </dd>
              </div>
              <div className="pl-3">
                <dt className="text-xs font-medium text-muted">{goalLabel}</dt>
                <dd
                  className={`mt-1 text-sm font-medium tabular-nums whitespace-nowrap sm:text-base ${
                    view.remaining < 0 ? "amount-out" : ""
                  }`}
                >
                  {goalValue}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <section className="panel order-2 lg:order-1" aria-labelledby="entries-heading">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 id="entries-heading" className="text-lg font-medium">
                Entries
              </h2>
              <div className="seg grid-cols-3 sm:min-w-64" role="group" aria-label="Filter entries">
                {(
                  [
                    ["all", "All"],
                    ["income", "Income"],
                    ["expense", "Expense"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => {
                      setFilter(key);
                      setPendingDelete(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {hasSample ? (
              <div className="mb-4 rounded-md bg-track px-4 py-3">
                <p className="text-sm">
                  Sample entries are filled in so this month is not empty. Remove them when you want
                  your own numbers.
                </p>
                {confirmClear ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        update((currentData) => {
                          const transactions = currentData.transactions.filter(
                            (tx) => !(tx.sample && inMonth(tx.date, month)),
                          );
                          return {
                            ...currentData,
                            transactions,
                            sample: transactions.some((tx) => tx.sample),
                          };
                        });
                        setConfirmClear(false);
                      }}
                    >
                      Remove sample entries
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-quiet mt-2" onClick={() => setConfirmClear(true)}>
                    Remove sample entries
                  </button>
                )}
              </div>
            ) : null}

            {view.groups.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-sm text-muted">
                  {view.monthTx.length === 0
                    ? `No entries in ${title} yet.`
                    : "Nothing matches this filter."}
                </p>
                {view.monthTx.length === 0 ? (
                  <button type="button" className="btn btn-primary mt-4" onClick={openCreate}>
                    Add an entry
                  </button>
                ) : null}
              </div>
            ) : (
              <div id="tx-list" className="flex flex-col gap-5">
                {view.groups.map((group) => (
                  <div key={group.date}>
                    <p className="mb-2 text-xs font-medium text-muted">{formatDay(group.date)}</p>
                    <ul className="flex flex-col">
                      {group.items.map((tx) => {
                        const meta = tx.note || (tx.kind === "income" ? "Income" : "Expense");
                        const confirming = pendingDelete === tx.id;
                        return (
                          <li key={tx.id} className="border-t border-line py-3 first:border-t-0 first:pt-0">
                            <div className="flex items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-3">
                                  <p className="truncate font-medium">{tx.category}</p>
                                  <p
                                    className={`shrink-0 font-medium tabular-nums ${
                                      tx.kind === "income" ? "amount-in" : "amount-out"
                                    }`}
                                  >
                                    {formatSigned(tx.kind, tx.amountCents, data.currency)}
                                  </p>
                                </div>
                                <p className="truncate text-sm text-muted">{meta}</p>
                              </div>
                              <div className="flex shrink-0 gap-1">
                                {confirming ? (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn-quiet"
                                      onClick={() => setPendingDelete(null)}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-danger"
                                      onClick={() => {
                                        update((currentData) => {
                                          const transactions = currentData.transactions.filter(
                                            (item) => item.id !== tx.id,
                                          );
                                          return {
                                            ...currentData,
                                            transactions,
                                            sample: transactions.some((item) => item.sample),
                                          };
                                        });
                                        setPendingDelete(null);
                                      }}
                                    >
                                      Delete
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn-quiet btn-icon"
                                      aria-label={`Edit ${tx.category}${tx.note ? `, ${tx.note}` : ""}`}
                                      onClick={() => setEditor({ mode: "edit", tx })}
                                    >
                                      <Pencil className="size-4" aria-hidden="true" />
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-quiet btn-icon"
                                      aria-label={`Delete ${tx.category}${tx.note ? `, ${tx.note}` : ""}`}
                                      onClick={() => setPendingDelete(tx.id)}
                                    >
                                      <Trash2 className="size-4" aria-hidden="true" />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {hasUser && !hasSample ? (
              <div className="mt-4 border-t border-line pt-4">
                {confirmClear ? (
                  <div>
                    <p className="text-sm">
                      Remove every entry in {title}? The savings goal stays.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => {
                          update((currentData) => {
                            const transactions = currentData.transactions.filter(
                              (tx) => !inMonth(tx.date, month),
                            );
                            return {
                              ...currentData,
                              transactions,
                              sample: transactions.some((tx) => tx.sample),
                            };
                          });
                          setConfirmClear(false);
                        }}
                      >
                        Clear this month
                      </button>
                      <button type="button" className="btn btn-quiet" onClick={() => setConfirmClear(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn btn-quiet" onClick={() => setConfirmClear(true)}>
                    Clear this month
                  </button>
                )}
              </div>
            ) : null}
          </section>

          <div className="order-1 flex flex-col gap-5 lg:order-2">
            <section className="panel" aria-labelledby="goal-heading">
              <div className="flex items-start justify-between gap-3">
                <h2 id="goal-heading" className="text-lg font-medium">
                  Savings goal
                </h2>
                {goalEdit ? null : (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setGoalName(settings.goalName);
                      setGoalTarget(centsToInput(settings.goalTargetCents));
                      setGoalError("");
                      setGoalEdit(true);
                    }}
                  >
                    Edit
                  </button>
                )}
              </div>

              {goalEdit ? (
                <form
                  className="mt-4 flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveGoal();
                  }}
                >
                  <div>
                    <label className="mb-2 block text-sm font-medium" htmlFor="goal-name">
                      Name
                    </label>
                    <input
                      id="goal-name"
                      className="field"
                      maxLength={40}
                      value={goalName}
                      onChange={(event) => {
                        setGoalName(event.target.value);
                        setGoalError("");
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium" htmlFor="goal-target">
                      Monthly target
                    </label>
                    <div className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                        {data.currency === "INR" ? "₹" : "$"}
                      </span>
                      <input
                        id="goal-target"
                        className="field pl-7 tabular-nums"
                        inputMode="decimal"
                        value={goalTarget}
                        onChange={(event) => {
                          setGoalTarget(event.target.value);
                          setGoalError("");
                        }}
                      />
                    </div>
                  </div>
                  {goalError ? (
                    <p className="text-sm text-expense" role="alert">
                      {goalError}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <button type="button" className="btn btn-quiet" onClick={() => setGoalEdit(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary">
                      Save goal
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-4">
                  <p className="font-medium">{settings.goalName}</p>
                  <div
                    id="goal-progress"
                    className="track mt-3"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`${settings.goalName} progress`}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <p className="mt-3 text-sm tabular-nums">
                    {view.remaining >= target ? (
                      <>
                        <span className="font-medium">{formatMoney(target, data.currency)}</span>
                        <span className="text-muted"> target reached · {percent}%</span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">{formatMoney(Math.max(view.remaining, 0), data.currency)}</span>
                        <span className="text-muted"> of {formatMoney(target, data.currency)}</span>
                        <span className="text-muted"> · {percent}%</span>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-muted">{goalDetail}</p>
                </div>
              )}
            </section>

            <SpendingChatPanel data={data} month={month} />

            <section className="panel" aria-labelledby="budgets-heading">
              <h2 id="budgets-heading" className="text-lg font-medium">Monthly category budgets</h2>
              <p className="mt-1 text-sm text-muted">Each month has its own limits. Leave an amount blank for no limit; a zero limit is not allowed.</p>
              <ul className="mt-4 flex flex-col">
                {EXPENSE_CATEGORIES.map((category) => {
                  const spent = view.rows.find((row) => row.category === category)?.cents ?? 0;
                  const limit = settings.categoryBudgets[category];
                  const status = budgetStatus(spent, limit);
                  const amount = budgetDrafts[category] ?? (limit ? centsToInput(limit) : "");
                  const statusLabel = {
                    "no-limit": "No limit",
                    under: limit ? `${formatMoney(Math.max(limit - spent, 0), data.currency)} left` : "Under limit",
                    near: "Near limit · 80%+",
                    at: "At limit",
                    over: `Over by ${formatMoney(spent - (limit ?? 0), data.currency)}`,
                  }[status];
                  return (
                    <li key={category} className="border-t border-line py-3 first:border-t-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{category}</p>
                          <p className={`mt-0.5 text-sm ${status === "over" || status === "at" ? "amount-out" : "text-muted"}`}>
                            {formatMoney(spent, data.currency)} spent · {statusLabel}
                          </p>
                        </div>
                        <form
                          className="flex max-w-full items-center gap-2"
                          aria-label={`${category} monthly budget`}
                          onSubmit={(event) => {
                            event.preventDefault();
                            saveCategoryBudget(category);
                          }}
                        >
                          <label className="sr-only" htmlFor={`budget-${category}`}>Monthly limit for {category}</label>
                          <div className="relative w-36">
                            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                              {data.currency === "INR" ? "₹" : "$"}
                            </span>
                            <input
                              id={`budget-${category}`}
                              className="field pl-7 tabular-nums"
                              inputMode="decimal"
                              placeholder="No limit"
                              value={amount}
                              onChange={(event) => {
                                setBudgetDrafts((drafts) => ({ ...drafts, [category]: event.target.value }));
                                setBudgetErrors((errors) => ({ ...errors, [category]: "" }));
                              }}
                            />
                          </div>
                          <button type="submit" className="btn btn-quiet">Save</button>
                        </form>
                      </div>
                      {budgetErrors[category] ? <p className="mt-1 text-sm text-expense" role="alert">{budgetErrors[category]}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="panel" aria-labelledby="chart-heading">
              <h2 id="chart-heading" className="text-lg font-medium">
                Spending by category
              </h2>
              <p className="mt-1 text-sm text-muted">
                {top ? `${top.category} is ${top.share}% of spending in ${title}.` : `No spending in ${title}.`}
              </p>
              {view.rows.length === 0 ? null : (
                <>
                  <div className="mt-4">
                    <Suspense fallback={<p className="text-sm text-muted">Loading chart…</p>}>
                      <SpendChart rows={view.rows} currency={data.currency} />
                    </Suspense>
                  </div>
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="text-xs font-medium text-muted">
                        <th className="pb-2 text-left font-medium">Category</th>
                        <th className="pb-2 text-right font-medium">Share</th>
                        <th className="pb-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.rows.map((row) => (
                        <tr key={row.category} className="border-t border-line">
                          <td className="py-2">{row.category}</td>
                          <td className="py-2 text-right text-muted tabular-nums">{row.share}%</td>
                          <td className="py-2 text-right font-medium tabular-nums">
                            {formatMoney(row.cents, data.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>
          </div>
        </div>

        <p className="text-center text-xs text-faint">Saved on this device.</p>
      </div>

      {editor ? (
        <EntryDialog
          key={editor.mode === "edit" ? editor.tx.id : "create"}
          mode={editor.mode}
          initial={editor.mode === "edit" ? editor.tx : null}
          defaultDate={defaultDateForMonth(month)}
          currency={data.currency}
          onClose={() => setEditor(null)}
          onSave={(draft) => {
            if (editor.mode === "create") {
              const next: Transaction = {
                ...draft,
                id: crypto.randomUUID(),
                createdAt: Date.now(),
                sample: false,
              };
              update((currentData) => ({
                ...currentData,
                transactions: [next, ...currentData.transactions],
              }));
            } else {
              const id = editor.tx.id;
              update((currentData) => {
                const transactions = currentData.transactions.map((tx) =>
                  tx.id === id ? { ...tx, ...draft, sample: false } : tx,
                );
                return {
                  ...currentData,
                  transactions,
                  sample: transactions.some((tx) => tx.sample),
                };
              });
            }
            setMonth(draft.date.slice(0, 7));
            setEditor(null);
          }}
        />
      ) : null}
      {data ? (
        <StatementImportDialog
          open={statementImportOpen}
          currency={data.currency}
          existing={data.transactions}
          onOpenChange={setStatementImportOpen}
          onConfirm={importStatement}
        />
      ) : null}
    </main>
  );
}
