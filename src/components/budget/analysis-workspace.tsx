import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { TallyClient } from "@/lib/agent-tools/client";
import { formatMoney, type Currency } from "@/lib/budget";
type Row = Record<string, any>;

export function AnalysisWorkspace({
  client,
  currency,
  month,
  revision,
}: {
  client: TallyClient;
  currency: Currency;
  month: string;
  revision: number;
}) {
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(
    `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`,
  );
  const [reports, setReports] = useState<{ profit: Row; flow: Row; accounts: Row[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setReports(null);
    if (!from || !to || from > to) {
      setError("Choose a valid date range with the start on or before the end.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      client.call(
        "tally_get_income_expense_report",
        { currency, from, to },
        undefined,
        controller.signal,
      ),
      client.call("tally_get_cash_flow", { currency, from, to }, undefined, controller.signal),
      client.call("tally_list_accounts", { currency }, undefined, controller.signal),
    ])
      .then(([profit, flow, accounts]) => {
        if (!active) return;
        if (profit.revision !== flow.revision || profit.revision !== accounts.revision)
          throw new Error("The ledger changed while loading. Refresh the reports.");
        setReports({ profit, flow, accounts: accounts.accounts });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, currency, from, to, revision, refresh]);
  const money = (n: number) => formatMoney(n, currency);
  return (
    <div className="space-y-5">
      <section className="panel space-y-4" aria-busy={loading}>
        <div>
          <h2 className="text-xl font-semibold">Account analysis</h2>
          <p className="mt-1 text-sm text-muted">
            Recorded account journals only. Unassigned budget entries and manually valued
            investments are separate.
          </p>
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label>
            Report from
            <input
              className="field"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Report to
            <input
              className="field"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            className="btn btn-quiet"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            Refresh reports
          </button>
        </div>
        {loading && <p role="status">Loading recorded reports…</p>}
        {error && (
          <p role="alert" className="text-expense">
            {error}
          </p>
        )}
        {reports && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["Journal income", reports.profit.incomeMinor],
                ["Net expense", reports.profit.expenseMinor],
                ["Journal surplus", reports.profit.surplusMinor],
              ].map(([name, amount]) => (
                <div className="rounded border border-line p-3" key={name}>
                  <p className="text-sm text-muted">{name}</p>
                  <p className="mt-1 text-2xl font-medium tabular-nums">{money(amount)}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">
              {currency} · {from} to {to} · revision {reports.profit.revision} ·{" "}
              {reports.profit.sourceEventIds.length} source events · not reconciled
            </p>
          </>
        )}
      </section>
      {reports && (
        <section className="panel space-y-4">
          <h2 className="text-xl font-semibold">Bank and cash movement</h2>
          <p>
            Net movement:{" "}
            <strong className="tabular-nums">{money(reports.flow.netAssetMovementMinor)}</strong>
          </p>
          <p className="text-sm text-muted">
            Internal transfers appear on each account and cancel in the net movement. Openings are
            excluded. Cash movement is different from income or spending.
          </p>
          {reports.flow.accounts.length ? (
            <div className="space-y-3">
              {reports.flow.accounts.map((a: Row) => (
                <article className="rounded border border-line p-3" key={a.accountId}>
                  <h3 className="font-medium">
                    {reports.accounts.find((account) => account.id === a.accountId)?.name ??
                      a.accountId}
                  </h3>
                  <dl className="mt-2 grid gap-3 sm:grid-cols-3">
                    {[
                      ["In", a.inMinor],
                      ["Out", a.outMinor],
                      ["Net movement", a.netMovementMinor],
                    ].map(([name, amount]) => (
                      <div key={name}>
                        <dt className="text-sm text-muted">{name}</dt>
                        <dd className="tabular-nums">{money(amount)}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-muted">
              No bank or cash accounts recorded. Add accounts and their opening balances first.
            </p>
          )}
          <p className="text-xs text-muted">
            Statement coverage is not evaluated by this report. Review evidence in Statements.
          </p>
        </section>
      )}
      <section className="panel space-y-2">
        <h2 className="text-lg font-medium">Other views</h2>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-quiet" to="/" search={{ currency, month }}>
            Monthly budget and category chart
          </Link>
          <Link
            className="btn btn-quiet"
            to="/agents"
            search={{ currency, month, section: "accounts" }}
          >
            Accounts, cards and loan debt
          </Link>
          <Link
            className="btn btn-quiet"
            to="/agents"
            search={{ currency, month, section: "investments" }}
          >
            Investment valuations
          </Link>
          <Link
            className="btn btn-quiet"
            to="/agents"
            search={{ currency, month, section: "chat" }}
          >
            Spending chat
          </Link>
        </div>
        <p className="text-sm text-muted">
          AI is optional and requires a configured provider and consent. These reports use recorded
          data without an AI call.
        </p>
      </section>
    </div>
  );
}
