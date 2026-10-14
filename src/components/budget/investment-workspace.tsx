import { useEffect, useRef, useState } from "react";
import type { TallyClient } from "@/lib/agent-tools/client";
import { formatMoney, monthKey, defaultDateForMonth, type Currency } from "@/lib/budget";
import { FinancialPreview } from "./financial-preview";
import { inputMinor } from "./financial-input";
type Row = Record<string, any>;
const types = {
  mutual_fund: "Mutual fund",
  gold: "Gold (grams)",
  stock: "Stock",
  recurring_deposit: "Recurring deposit (RD)",
};
export function InvestmentWorkspace({
  client,
  currency,
  revision,
  busy,
  enabled,
  canWrite,
  run,
}: {
  client: TallyClient;
  currency: Currency;
  revision: number;
  busy: boolean;
  enabled: boolean;
  canWrite: boolean;
  run: (tool: string, args: Row, onResult?: (value: Row) => void) => Promise<void>;
}) {
  const [asOf, setAsOf] = useState(defaultDateForMonth(monthKey(new Date())));
  const [report, setReport] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Row | null>(null);
  const [selected, setSelected] = useState("");
  const [type, setType] = useState("mutual_fund");
  const [history, setHistory] = useState<Row | null>(null);
  const [historyHolding, setHistoryHolding] = useState("");
  const draftRevision = useRef<number | null>(null);
  const forms = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setReport(null);
    setError("");
    setHistory(null);
    void client
      .call("tally_get_investment_portfolio", { currency, asOf })
      .then((r) => {
        if (live) setReport(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [client, currency, revision, asOf, enabled]);
  const locked = busy || !!preview || !report || report.revision !== revision || !canWrite;
  const money = (v: number | null) => (v === null ? "Unknown" : formatMoney(v, currency));
  function reset() {
    draftRevision.current = null;
    forms.current?.querySelectorAll("form").forEach((f) => f.reset());
    setSelected("");
    setType("mutual_fund");
    setPreview(null);
    setError("");
  }
  function prepare(change: Row, expectedRevision = draftRevision.current ?? revision) {
    setError("");
    void run("tally_prepare_investment_change", { currency, expectedRevision, change }, (v) =>
      setPreview({ ...v, commitTool: "tally_commit_investment_change" }),
    );
  }
  if (!enabled)
    return (
      <section className="panel">Investment tools are unavailable for this connection.</section>
    );
  return (
    <div className="space-y-5" ref={forms}>
      <section className="panel space-y-3">
        <h2 className="text-xl font-semibold">Investments</h2>
        <p className="text-sm text-muted">
          Mutual funds, gold, stocks and RDs across your investment accounts. Record units,
          remaining cost basis and total observed value manually. These positions are separate from
          bank/card journals; recording a valuation does not move cash.
        </p>
        <label className="block max-w-xs">
          Valuations as of
          <input
            className="field w-full"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </label>
        {report && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["Recorded value", report.valueMinor],
                ["Cost basis", report.costMinor],
                ["Unrealised change", report.gainMinor],
              ].map(([label, value]) => (
                <div className="rounded border border-line p-3" key={label}>
                  <p className="text-sm text-muted">{label}</p>
                  <p className="text-xl">{money(value)}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">{report.basis}</p>
          </>
        )}
      </section>
      {error && (
        <p className="panel" role="alert">
          {error}
        </p>
      )}
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Investment accounts</h2>
        {report?.accounts.map((a: Row) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-line p-3"
          >
            <span>
              {a.name}
              {a.institution ? ` · ${a.institution}` : ""}
              {a.archived ? " · archived" : ""}
            </span>
            <button
              className="btn btn-quiet"
              disabled={locked}
              onClick={() =>
                prepare(
                  { action: "archive_account", accountId: a.id, archived: !a.archived },
                  revision,
                )
              }
            >
              {a.archived ? "Review restore" : "Review archive"}
            </button>
          </div>
        ))}
        <form
          className="grid gap-3 sm:grid-cols-3"
          onChange={() => {
            draftRevision.current ??= revision;
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            prepare({
              action: "account",
              name: String(f.get("name")),
              institution: String(f.get("institution")),
            });
          }}
        >
          <label>
            Account name
            <input className="field w-full" name="name" maxLength={80} required disabled={locked} />
          </label>
          <label>
            Institution / broker
            <input className="field w-full" name="institution" maxLength={80} disabled={locked} />
          </label>
          <button className="btn btn-primary self-end" disabled={locked}>
            Preview new account
          </button>
        </form>
      </section>
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Holdings</h2>
        {!report?.holdings.length && (
          <p>No holdings recorded. Add an investment account, then a holding.</p>
        )}
        {report?.holdings.map((row: Row) => (
          <div className="rounded border border-line p-3" key={row.holding.id}>
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <h3 className="font-medium">
                  {row.holding.name}
                  {row.holding.archived ? " · archived" : ""}
                </h3>
                <p className="text-sm text-muted">
                  {types[row.holding.type as keyof typeof types]} ·{" "}
                  {report.accounts.find((a: Row) => a.id === row.holding.accountId)?.name}
                  {row.holding.identifier ? ` · ${row.holding.identifier}` : ""}
                </p>
              </div>
              <p>{row.valuation ? money(row.valuation.valueMinor) : "No valuation by this date"}</p>
            </div>
            {row.valuation && (
              <p className="text-sm">
                {row.valuation.quantity} {row.holding.type === "gold" ? "grams" : "units"} · cost{" "}
                {money(row.valuation.costMinor)} · change {money(row.gainMinor)} · observed{" "}
                {row.valuation.date}
              </p>
            )}
            {row.valuation?.rd && (
              <p className="text-sm">
                RD instalment {money(row.valuation.rd.instalmentMinor)} monthly · maturity{" "}
                {row.valuation.rd.maturityDate}
                {row.valuation.rd.expectedMaturityMinor
                  ? ` · expected ${money(row.valuation.rd.expectedMaturityMinor)} (estimate)`
                  : ""}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => {
                  setHistoryHolding(row.holding.id);
                  void client
                    .call("tally_list_investment_valuations", {
                      currency,
                      holdingId: row.holding.id,
                      limit: 50,
                    })
                    .then(setHistory)
                    .catch((e) => setError(e.message));
                }}
              >
                Valuation history
              </button>
              <button
                className="btn btn-quiet"
                disabled={locked}
                onClick={() =>
                  prepare(
                    {
                      action: "archive_holding",
                      holdingId: row.holding.id,
                      archived: !row.holding.archived,
                    },
                    revision,
                  )
                }
              >
                {row.holding.archived ? "Review restore" : "Review archive"}
              </button>
            </div>
          </div>
        ))}
        {history && (
          <div className="space-y-2">
            <h3 className="font-medium">Recorded valuation history</h3>
            {history.items.map((v: Row) => (
              <p key={v.id} className="text-sm">
                {v.date} · {v.quantity} units · cost {money(v.costMinor)} · value{" "}
                {money(v.valueMinor)} · {v.note}
              </p>
            ))}
            {history.nextCursor && (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void client
                    .call("tally_list_investment_valuations", {
                      currency,
                      holdingId: historyHolding,
                      cursor: history.nextCursor,
                      limit: 50,
                    })
                    .then((r) => setHistory({ ...r, items: [...history.items, ...r.items] }))
                    .catch((e) => setError(e.message))
                }
              >
                More observations
              </button>
            )}
          </div>
        )}
      </section>
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Add holding or record a valuation</h2>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onChange={() => {
            draftRevision.current ??= revision;
          }}
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const f = new FormData(e.currentTarget);
              const valuation = {
                date: String(f.get("date")),
                quantity: String(f.get("quantity") || "0"),
                costMinor: inputMinor(f.get("cost")),
                valueMinor: inputMinor(f.get("value")),
                note: String(f.get("note") || ""),
                ...(type === "recurring_deposit"
                  ? {
                      rd: {
                        instalmentMinor: inputMinor(f.get("instalment"), false),
                        maturityDate: String(f.get("maturity")),
                        ...(f.get("expected")
                          ? { expectedMaturityMinor: inputMinor(f.get("expected"), false) }
                          : {}),
                      },
                    }
                  : {}),
              };
              prepare(
                selected
                  ? { action: "valuation", holdingId: selected, valuation }
                  : {
                      action: "holding",
                      accountId: String(f.get("account")),
                      type,
                      name: String(f.get("name")),
                      identifier: String(f.get("identifier") || ""),
                      valuation,
                    },
              );
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        >
          <label>
            Holding
            <select
              className="field w-full"
              aria-label="Holding"
              value={selected}
              disabled={locked}
              onChange={(e) => {
                setSelected(e.target.value);
                setType(
                  report?.holdings.find((r: Row) => r.holding.id === e.target.value)?.holding
                    .type ?? "mutual_fund",
                );
              }}
            >
              <option value="">New holding</option>
              {report?.holdings
                .filter(
                  (r: Row) =>
                    !r.holding.archived &&
                    !report.accounts.find((a: Row) => a.id === r.holding.accountId)?.archived,
                )
                .map((r: Row) => (
                  <option key={r.holding.id} value={r.holding.id}>
                    {r.holding.name}
                  </option>
                ))}
            </select>
          </label>
          {!selected && (
            <>
              <label>
                Account
                <select
                  className="field w-full"
                  aria-label="Account"
                  name="account"
                  required
                  disabled={locked}
                >
                  <option value="">Choose account</option>
                  {report?.accounts
                    .filter((a: Row) => !a.archived)
                    .map((a: Row) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Investment type
                <select
                  className="field w-full"
                  aria-label="Investment type"
                  value={type}
                  disabled={locked}
                  onChange={(e) => setType(e.target.value)}
                >
                  {Object.entries(types).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Holding name
                <input
                  className="field w-full"
                  name="name"
                  maxLength={80}
                  required
                  disabled={locked}
                />
              </label>
              <label>
                Symbol / ISIN / reference (optional)
                <input
                  className="field w-full"
                  name="identifier"
                  maxLength={80}
                  disabled={locked}
                />
              </label>
            </>
          )}
          <label>
            Observation date
            <input
              className="field w-full"
              type="date"
              name="date"
              required
              defaultValue={asOf}
              disabled={locked}
            />
          </label>
          <label>
            {type === "gold" ? "Quantity in grams" : "Units (optional for RD)"}
            <input
              className="field w-full"
              name="quantity"
              defaultValue="0"
              inputMode="decimal"
              required
              disabled={locked}
            />
          </label>
          <label>
            Remaining cost basis ({currency})
            <input
              className="field w-full"
              name="cost"
              inputMode="decimal"
              required
              disabled={locked}
            />
          </label>
          <label>
            Total observed value ({currency})
            <input
              className="field w-full"
              name="value"
              inputMode="decimal"
              required
              disabled={locked}
            />
          </label>
          {type === "recurring_deposit" && (
            <>
              <label>
                Monthly instalment ({currency})
                <input
                  className="field w-full"
                  name="instalment"
                  inputMode="decimal"
                  required
                  disabled={locked}
                />
              </label>
              <label>
                Maturity date
                <input
                  className="field w-full"
                  type="date"
                  name="maturity"
                  required
                  disabled={locked}
                />
              </label>
              <label>
                Expected maturity value (optional)
                <input
                  className="field w-full"
                  name="expected"
                  inputMode="decimal"
                  disabled={locked}
                />
              </label>
            </>
          )}
          <label>
            Source / note
            <input className="field w-full" name="note" maxLength={500} disabled={locked} />
          </label>
          <p className="text-sm text-muted sm:col-span-2">
            Enter total value, not price per unit. A new observation preserves earlier values; on
            the same date the last recorded correction is used. RD maturity values are manual
            estimates.
          </p>
          <button className="btn btn-primary" disabled={locked}>
            Preview holding / valuation
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            disabled={busy || !!preview}
            onClick={reset}
          >
            Reset draft
          </button>
        </form>
      </section>
      {preview && (
        <FinancialPreview
          key={preview.planId}
          {...{ preview, client, currency, revision, busy, run }}
          onDone={reset}
        />
      )}
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          void run("tally_export_accounting_backup", { currency }, (v) => {
            void client.download(currency, v.fileId).catch((e) => setError(e.message));
          })
        }
      >
        Export accounts and investment backup
      </button>
    </div>
  );
}
