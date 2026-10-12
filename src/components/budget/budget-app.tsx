import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { EntryDialog } from "@/components/budget/entry-dialog";
import {
  centsToInput,
  defaultDateForMonth,
  formatDay,
  formatMoney,
  formatSigned,
  inMonth,
  loadBudget,
  monthKey,
  monthTitle,
  parseDollarsToCents,
  saveBudget,
  shiftMonth,
  spendingByCategory,
  type BudgetData,
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

  useEffect(() => {
    const now = new Date();
    setData(loadBudget(now));
    setMonth(monthKey(now));
  }, []);

  useEffect(() => {
    if (data) saveBudget(data);
  }, [data]);

  useEffect(() => {
    setPendingDelete(null);
    setConfirmClear(false);
    setGoalEdit(false);
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

  if (!data || !month || !view) {
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
  const target = data.goalTargetCents;
  const progress =
    target > 0 ? Math.min(100, Math.max(0, (Math.max(view.remaining, 0) / target) * 100)) : 0;
  const percent = Math.round(progress);
  const gap = target - view.remaining;

  let goalLabel = "Still to save";
  let goalValue = formatMoney(Math.max(gap, 0));
  let goalDetail = `${formatMoney(Math.max(gap, 0))} still to set aside.`;
  if (view.remaining < 0) {
    goalLabel = "Overspent";
    goalValue = formatMoney(Math.abs(view.remaining));
    goalDetail = `Overspent by ${formatMoney(Math.abs(view.remaining))}. The goal waits until spending comes back down.`;
  } else if (view.remaining >= target) {
    const extra = view.remaining - target;
    goalLabel = extra === 0 ? "Goal met" : "Ahead";
    goalValue = formatMoney(extra);
    goalDetail =
      extra === 0
        ? "The savings goal is met for this month."
        : `Goal met, with ${formatMoney(extra)} still unspent.`;
  }

  const rowIsSample = (tx: Transaction) => tx.sample !== false && Boolean(tx.sample || data.sample);
  const hasSample = view.monthTx.some(rowIsSample);
  const hasUser = view.monthTx.some((tx) => !rowIsSample(tx));

  const top = view.rows[0];

  function saveGoal() {
    const name = goalName.trim();
    const cents = parseDollarsToCents(goalTarget);
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
      goalName: name.slice(0, 40),
      goalTargetCents: cents,
    }));
    setGoalEdit(false);
    setGoalError("");
  }

  return (
    <main className="overflow-x-clip">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-center sm:justify-between">
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
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center">
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                aria-label="Previous month"
                onClick={() => setMonth((value) => (value ? shiftMonth(value, -1) : value))}
              >
                <ChevronLeft className="size-5" aria-hidden="true" />
              </button>
              <p className="min-w-40 text-center font-medium">{title}</p>
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
              <button type="button" className="btn btn-quiet" onClick={() => setMonth(current)}>
                This month
              </button>
            ) : null}
            <button type="button" id="add-entry" className="btn btn-primary" onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Add entry
            </button>
          </div>
        </header>

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
                {formatMoney(view.remaining)}
              </p>
              <p className="mt-2 text-sm text-muted">Income minus spending for {title}</p>
            </div>
            <dl className="grid flex-1 grid-cols-3 divide-x divide-line sm:max-w-md">
              <div className="pr-3">
                <dt className="text-xs font-medium text-muted">Income</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums whitespace-nowrap sm:text-base">
                  {formatMoney(view.income)}
                </dd>
              </div>
              <div className="px-3">
                <dt className="text-xs font-medium text-muted">Spent</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums whitespace-nowrap sm:text-base">
                  {formatMoney(view.spending)}
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
                                    {formatSigned(tx.kind, tx.amountCents)}
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
                      setGoalName(data.goalName);
                      setGoalTarget(centsToInput(data.goalTargetCents));
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
                        $
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
                  <p className="font-medium">{data.goalName}</p>
                  <div
                    id="goal-progress"
                    className="track mt-3"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`${data.goalName} progress`}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <p className="mt-3 text-sm tabular-nums">
                    {view.remaining >= target ? (
                      <>
                        <span className="font-medium">{formatMoney(target)}</span>
                        <span className="text-muted"> target reached · {percent}%</span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">{formatMoney(Math.max(view.remaining, 0))}</span>
                        <span className="text-muted"> of {formatMoney(target)}</span>
                        <span className="text-muted"> · {percent}%</span>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-muted">{goalDetail}</p>
                </div>
              )}
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
                      <SpendChart rows={view.rows} />
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
                            {formatMoney(row.cents)}
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
    </main>
  );
}
