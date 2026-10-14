import { AnalysisWorkspace } from "./analysis-workspace";
import { InvestmentWorkspace } from "./investment-workspace";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { TallyClient, TallyClientError, agentBaseUrl } from "@/lib/agent-tools/client";
import { formatMoney, monthKey, defaultDateForMonth, type Currency } from "@/lib/budget";
import { StatementWorkspace } from "./statement-workspace";
import { AccountWorkspace } from "./account-workspace";

type Row = Record<string, any>;
const workspaceSections = [
  ["accounts", "Accounts & debt"],
  ["investments", "Investments"],
  ["analysis", "Analysis"],
  ["statements", "Statements"],
  ["ledger", "Legacy budget"],
  ["categories", "Categories"],
  ["imports", "Legacy imports"],
  ["approvals", "Review & consent"],
  ["chat", "Spending chat"],
  ["tools", "Advanced tools"],
];

/** Owner/agent UI uses exactly the same service as REST and MCP; no local replica writes. */
export function AgentWorkspace({
  initial = {},
}: { initial?: { currency?: Currency; month?: string; section?: string } } = {}) {
  const navigate = useNavigate({ from: "/agents" });
  const [token, setToken] = useState("");
  const [client, setClient] = useState<TallyClient | null>(null);
  const [currency, setCurrency] = useState<Currency>(initial.currency ?? "INR");
  const [month, setMonth] = useState(initial.month ?? monthKey(new Date()));
  useEffect(() => {
    if (initial.currency) setCurrency(initial.currency);
    if (initial.month) setMonth(initial.month);
    if (initial.section) setTab(initial.section);
  }, [initial.currency, initial.month, initial.section]);
  const [revision, setRevision] = useState(0);
  const [summary, setSummary] = useState<Row | null>(null);
  const [categories, setCategories] = useState<Row[]>([]);
  const [entries, setEntries] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [needsCredential, setNeedsCredential] = useState(false);
  const [tab, setTab] = useState(initial.section ?? "accounts");
  const [kind, setKind] = useState("expense");
  const [category, setCategory] = useState("Personal");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(defaultDateForMonth(monthKey(new Date())));
  const [editId, setEditId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [goalName, setGoalName] = useState("");
  const [goalAmount, setGoalAmount] = useState("");
  const [limit, setLimit] = useState("");
  const [draft, setDraft] = useState<Row | null>(null);
  const [mapping, setMapping] = useState("{}");
  const [preview, setPreview] = useState<Row | null>(null);
  const [approvalId, setApprovalId] = useState("");
  const [approvals, setApprovals] = useState<Row[]>([]);
  const [approvalRows, setApprovalRows] = useState<Row[]>([]);
  const [approvalRowsNext, setApprovalRowsNext] = useState<string | null>(null);
  const [approvalRowsId, setApprovalRowsId] = useState("");
  const [tools, setTools] = useState<Row[]>([]);
  const [selectedTool, setSelectedTool] = useState("tally_get_capabilities");
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<Row | null>(null);
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState<Row | null>(null);
  const [ai, setAi] = useState<Row | null>(null);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [aiStatusError, setAiStatusError] = useState("");
  const connection = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const retry = useRef<{
    tool: string;
    args: Row;
    key?: string;
    onResult?: (value: Row) => void;
  } | null>(null);
  const allowed = (name: string) => tools.some((t) => t.name === name);
  function changeSection(value: string) {
    setTab(value);
    void navigate({ search: { currency, month, section: value } });
    if (!retry.current) setError("");
  }

  async function refresh(active = client, selectedCurrency = currency, selectedMonth = month) {
    if (!active) return;
    const epoch = generation.current;
    const [meta, stats, cats] = await Promise.all([
      active.call("tally_get_ledger", { currency: selectedCurrency }),
      active.call("tally_get_month_summary", { currency: selectedCurrency, month: selectedMonth }),
      active.call("tally_list_categories", { currency: selectedCurrency, includeArchived: true }),
    ]);
    if (epoch !== generation.current) return;
    if (
      meta.revision !== stats.revision ||
      (cats.revision !== undefined && cats.revision !== meta.revision)
    )
      throw new TallyClientError(
        "revision_conflict",
        "The ledger changed while loading. Refresh the workspace.",
        409,
      );
    setRevision(meta.revision);
    setSummary(stats);
    setCategories(cats.categories);
    setGoalName(stats.goal.name);
    setGoalAmount(String(stats.goal.targetMinor / 100));
    if (allowed("tally_list_transactions") || active !== client) {
      try {
        const page = await active.call("tally_list_transactions", {
          currency: selectedCurrency,
          month: selectedMonth,
          limit: 50,
        });
        if (epoch === generation.current) {
          setEntries(page.items);
          setCursor(page.nextCursor);
        }
      } catch {
        setEntries([]);
        setCursor(null);
      }
    }
  }
  useEffect(() => {
    if (!client) return;
    generation.current += 1;
    let active = true;
    setSummary(null);
    setCategories([]);
    setApprovalId("");
    setPreview(null);
    setDraft(null);
    setContext(null);
    setAi(null);
    setEditId(null);
    setError("");
    setEntries([]);
    setCursor(null);
    void refresh().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
      abort.current?.abort();
    }; /* explicit scope changes invalidate all UI previews */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, currency, month]);
  useEffect(() => {
    void connect();
    return () => connection.current?.abort();
    // Connection discovery is read-only and runs once per page visit, including reloads.
  }, []);
  useEffect(() => {
    setAiReady(null);
    setAiStatusError("");
    if (!client) return;
    if (!tools.some((tool) => tool.name === "tally_get_ai_status")) {
      setAiReady(false);
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    // Optional provider readiness must not keep the ledger connection busy.
    void client.call("tally_get_ai_status", {}, undefined, signal).then(
      (status) => {
        if (!controller.signal.aborted) setAiReady(status.configured === true);
      },
      () => {
        if (!controller.signal.aborted)
          setAiStatusError("AI availability could not be checked. Reconnect to retry.");
      },
    );
    return () => controller.abort();
  }, [client, tools]);
  useEffect(() => {
    if (!client || !ai?.requestId || ai.status !== "pending") return;
    const timer = setInterval(() => {
      void client
        .call("tally_get_ai_request", { currency, requestId: ai.requestId })
        .then(setAi)
        .catch((e) => setError(e.message));
    }, 1000);
    return () => clearInterval(timer);
  }, [client, currency, ai]);
  async function run(tool: string, args: Row, onResult?: (value: Row) => void, repeating = false) {
    if (!client || busy) return;
    if (retry.current && !repeating) {
      setError(
        "Resolve the interrupted request with Retry same request before starting another operation.",
      );
      return;
    }
    const mutating = tools.find((t) => t.name === tool)?.effect !== "read";
    const request =
      repeating && retry.current
        ? retry.current
        : { tool, args, key: mutating ? crypto.randomUUID() : undefined, onResult };
    retry.current = request;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    try {
      const value = await client.call(request.tool, request.args, request.key, controller.signal);
      setResult(value);
      retry.current = null;
      request.onResult?.(value);
      if (mutating) await refresh();
    } catch (e) {
      if (e instanceof TallyClientError && e.code !== "unavailable") {
        retry.current = null;
        if (e.code === "revision_conflict" || e.code === "stale_cursor")
          await refresh().catch(() => undefined);
      }
      setError(
        controller.signal.aborted
          ? "Request interrupted. The server may have committed it. Retry the same request to retrieve its receipt."
          : e instanceof Error
            ? e.message
            : "Request failed. Retry the same request.",
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }
  function minor(input: string) {
    if (!/^\d+(\.\d{1,2})?$/.test(input.trim()))
      throw new Error("Enter a positive amount with at most two decimals.");
    const [whole, fraction = ""] = input.trim().split(".");
    const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Enter a positive amount.");
    return value;
  }
  async function connect(accessToken = "") {
    connection.current?.abort();
    const controller = new AbortController();
    connection.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    setConnecting(true);
    setError("");
    try {
      const active = new TallyClient(agentBaseUrl(window.location), accessToken);
      const discovered = await active.discover(signal);
      if (signal.aborted) return;
      setTools(discovered.tools);
      setClient(active);
      setToken("");
      setNeedsCredential(false);
    } catch (e) {
      if (controller.signal.aborted) return;
      setNeedsCredential(e instanceof TallyClientError && e.code === "unauthorized");
      setError(
        signal.aborted
          ? "Connection timed out. Check your private Tailscale connection and retry."
          : e instanceof TallyClientError
            ? e.message
            : "Could not reach your private Tally server. Check your Tailscale connection and retry.",
      );
    } finally {
      if (connection.current === controller) {
        setConnecting(false);
        connection.current = null;
      }
    }
  }
  async function upload(file: File | undefined, restore = false) {
    if (!file || !client || busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setDraft(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const uploaded = await client.upload(currency, file, controller.signal);
      const args = restore
        ? { currency, fileId: uploaded.fileId, expectedRevision: revision }
        : { currency, fileId: uploaded.fileId };
      const tool = restore ? "tally_preview_restore" : "tally_stage_statement";
      const key = crypto.randomUUID();
      retry.current = { tool, args, key };
      const staged = await client.call(tool, args, key, controller.signal);
      retry.current = null;
      setResult(staged);
      if (restore) setPreview(staged);
      else {
        const rows = await client.call("tally_get_import", {
          currency,
          importId: staged.importId,
          limit: 100,
        });
        setDraft({ ...staged, ...rows });
        const s = staged.suggestedMapping;
        setMapping(
          JSON.stringify(
            {
              dateColumn: s.dateColumn ?? 0,
              descriptionColumn: s.descriptionColumn,
              currencyColumn: s.currencyColumn,
              categoryColumn:
                staged.headers.findIndex((h: string) => /^category$/i.test(h)) >= 0
                  ? staged.headers.findIndex((h: string) => /^category$/i.test(h))
                  : null,
              dateFormat: "auto",
              amount:
                s.debitColumn != null && s.creditColumn != null
                  ? {
                      mode: "debit-credit",
                      debitColumn: s.debitColumn,
                      creditColumn: s.creditColumn,
                    }
                  : {
                      mode: "signed",
                      amountColumn: s.amountColumn ?? 1,
                      positiveAmounts: "expense",
                    },
            },
            null,
            2,
          ),
        );
      }
    } catch (e) {
      setError(
        controller.signal.aborted
          ? "Upload interrupted. No import has been committed."
          : e instanceof Error
            ? e.message
            : "Upload failed.",
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }
  async function requestApproval(value: Row) {
    await run("tally_request_approval", { currency, planId: value.planId }, (v) =>
      setApprovalId(v.approvalId),
    );
  }
  async function reviewApprovals() {
    if (!client) return;
    try {
      const response = await client.request("/approvals");
      setApprovals((await response.json()).result.approvals);
      setApprovalRows([]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read approvals.");
    }
  }
  async function loadApprovalRows(approvalId: string, cursor?: string) {
    if (!client) return;
    try {
      const response = await client.request(
        `/approval-rows?approvalId=${encodeURIComponent(approvalId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const value = (await response.json()).result;
      setApprovalRows((rows) => (cursor ? [...rows, ...value.items] : value.items));
      setApprovalRowsNext(value.nextCursor);
      setApprovalRowsId(approvalId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Frozen changes could not be read.");
    }
  }
  async function decide(value: Row, approved: boolean) {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.request("/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approvalId: value.approvalId,
          previewHash: value.previewHash,
          approve: approved,
        }),
      });
      await reviewApprovals();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }
  const money = (v: number) => formatMoney(v, currency);
  const control = "field w-full";
  if (!client)
    return (
      <main className="mx-auto max-w-lg p-6">
        <Link to="/" className="text-accent">
          ← Tally
        </Link>
        <section className="panel mt-6">
          <h1 className="text-2xl font-semibold">Shared workspace</h1>
          <p className="mt-3 text-muted">
            This workspace stores records on your private Tally server so the app and authorized
            agents use the same ledger. The dashboard and tool workspace read and update this same
            ledger.
          </p>
          <p className="mt-3 text-sm text-muted">
            Your private Tailscale connection opens this workspace automatically. Reviewed imports
            and destructive changes still require an explicit review step.
          </p>
          {needsCredential && (
            <label className="mt-3 block">
              Access credential for this token-based deployment
              <input
                type="password"
                autoComplete="off"
                className={control}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          )}
          {connecting ? (
            <p role="status" className="mt-4 text-muted">
              Connecting to your workspace…
            </p>
          ) : (
            <button className="btn btn-primary mt-4" onClick={() => void connect(token)}>
              {needsCredential ? "Connect" : "Retry connection"}
            </button>
          )}
          {error && (
            <p role="alert" className="mt-3 text-expense">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tally shared workspace</h1>
          <p className="text-sm text-muted">
            One private server workspace · {summary ? `revision ${revision}` : "loading ledger…"}
          </p>
        </div>
        <div className="grid w-full grid-cols-2 items-center gap-2 sm:w-auto sm:grid-cols-[6rem_11rem_auto_auto]">
          <select
            aria-label="Ledger currency"
            className="field min-w-24 shrink-0"
            value={currency}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value as Currency;
              setCurrency(next);
              void navigate({ search: { currency: next, month, section: tab }, replace: true });
            }}
          >
            <option>INR</option>
            <option>USD</option>
          </select>
          <input
            aria-label="Month"
            className="field"
            type="month"
            value={month}
            disabled={busy}
            onChange={(e) => {
              setMonth(e.target.value);
              void navigate({
                search: { currency, month: e.target.value, section: tab },
                replace: true,
              });
            }}
          />
          <button
            className="btn btn-quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Refresh workspace
          </button>
          <button
            className="btn btn-quiet"
            onClick={() => {
              generation.current += 1;
              abort.current?.abort();
              setClient(null);
              setEntries([]);
              setCategories([]);
              setTools([]);
              setSummary(null);
              setResult(null);
              setDraft(null);
              setPreview(null);
              setContext(null);
              setAi(null);
              setApprovals([]);
              retry.current = null;
            }}
          >
            Disconnect
          </button>
        </div>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:hidden">
        <label className="text-sm">
          Workspace section
          <select
            className="field mt-1"
            aria-label="Workspace section"
            value={tab}
            onChange={(e) => changeSection(e.target.value)}
          >
            {workspaceSections.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Link className="btn btn-quiet" to="/" search={{ currency, month }}>
          Dashboard
        </Link>
      </div>
      <nav className="hidden flex-wrap items-center gap-2 sm:flex" aria-label="Workspace sections">
        <Link className="btn btn-quiet" to="/" search={{ currency, month }}>
          Dashboard
        </Link>
        {workspaceSections
          .filter(([value]) =>
            ["accounts", "investments", "statements", "analysis"].includes(value),
          )
          .map(([value, label]) => (
            <button
              key={value}
              className={`btn ${tab === value ? "btn-primary" : "btn-quiet"}`}
              aria-pressed={tab === value}
              onClick={() => changeSection(value)}
            >
              {label}
            </button>
          ))}
        <details
          className="relative ml-auto"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.removeAttribute("open");
              e.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="More workspace sections"
            className={`btn list-none [&::-webkit-details-marker]:hidden ${["accounts", "investments", "statements", "analysis"].includes(tab) ? "btn-quiet" : "btn-primary"}`}
          >
            More <ChevronDown size={16} aria-hidden="true" className="shrink-0" />
          </summary>
          <div className="absolute right-0 top-full z-30 mt-2 grid min-w-52 rounded-md border border-line bg-surface p-1 shadow-lg">
            {workspaceSections
              .filter(
                ([value]) => !["accounts", "investments", "statements", "analysis"].includes(value),
              )
              .map(([value, label]) => (
                <button
                  key={value}
                  className="btn btn-quiet justify-start text-left"
                  aria-pressed={tab === value}
                  onClick={(e) => {
                    changeSection(value);
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  {label}
                </button>
              ))}
          </div>
        </details>
      </nav>
      {tab === "analysis" && (
        <AnalysisWorkspace
          key={`${currency}:${month}`}
          client={client}
          currency={currency}
          month={month}
          revision={revision}
        />
      )}
      <div hidden={tab !== "accounts"}>
        <AccountWorkspace
          key={currency}
          client={client}
          currency={currency}
          month={month}
          revision={revision}
          categories={categories}
          busy={busy}
          canRead={allowed("tally_list_accounts")}
          canWrite={allowed("tally_prepare_account") && allowed("tally_prepare_journal_event")}
          run={run}
        />
      </div>
      {tab === "investments" && (
        <InvestmentWorkspace
          key={currency}
          client={client}
          currency={currency}
          revision={revision}
          busy={busy}
          enabled={allowed("tally_get_investment_portfolio")}
          canWrite={allowed("tally_prepare_investment_change")}
          run={run}
        />
      )}
      <div hidden={tab !== "statements"}>
        <StatementWorkspace
          key={currency}
          client={client}
          currency={currency}
          revision={revision}
          busy={busy}
          enabled={allowed("tally_list_account_statements")}
          run={run}
        />
      </div>
      {error && (
        <section role="alert" className="panel border-expense">
          <p className="text-expense">{error}</p>
          {retry.current && (
            <button
              className="btn btn-quiet mt-2"
              disabled={busy}
              onClick={() => void run(retry.current!.tool, retry.current!.args, undefined, true)}
            >
              Retry same request
            </button>
          )}
        </section>
      )}
      {busy && (
        <p role="status">
          Working…{" "}
          <button className="btn btn-quiet" onClick={() => abort.current?.abort()}>
            Stop waiting
          </button>
        </p>
      )}
      {tab === "ledger" && (
        <>
          <section className="panel text-sm text-muted">
            These income/expense entries are unassigned legacy budget records. They do not include
            account journals. Accounts shows recorded bank/cash balances and liabilities; migration
            requires a separate review.
          </section>
          <section className="grid gap-3 sm:grid-cols-3">
            {[
              ["Income", summary?.incomeMinor ?? 0],
              ["Spending", summary?.spendingMinor ?? 0],
              ["Remaining", summary?.remainingMinor ?? 0],
            ].map(([name, value]) => (
              <div className="panel" key={String(name)}>
                <p className="text-muted">{name}</p>
                <p className="text-2xl font-semibold tabular-nums">{money(Number(value))}</p>
              </div>
            ))}
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            {allowed("tally_create_transaction") && (
              <form
                className="panel space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  try {
                    const transaction = { kind, amountMinor: minor(amount), category, note, date };
                    void run(
                      editId ? "tally_update_transaction" : "tally_create_transaction",
                      {
                        currency,
                        expectedRevision: revision,
                        ...(editId
                          ? { transactionId: editId, patch: transaction }
                          : { transaction }),
                      },
                      () => {
                        setEditId(null);
                        setAmount("");
                        setNote("");
                      },
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <h2 className="text-lg font-medium">{editId ? "Edit entry" : "Add entry"}</h2>
                <label className="block">
                  Type
                  <select
                    aria-label="Kind"
                    className={control}
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setCategory(
                        categories.find((c) => c.kind === e.target.value && !c.archived)?.name ??
                          "",
                      );
                    }}
                  >
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </label>
                <label className="block">
                  Category
                  <select
                    aria-label="Category"
                    className={control}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {categories
                      .filter((c) => c.kind === kind && (!c.archived || c.name === category))
                      .map((c) => (
                        <option key={c.id}>{c.name}</option>
                      ))}
                  </select>
                </label>
                <label className="block">
                  Amount ({currency})
                  <input
                    inputMode="decimal"
                    required
                    className={control}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label className="block">
                  Date
                  <input
                    className={control}
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label className="block">
                  Description
                  <input
                    className={control}
                    maxLength={80}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <button className="btn btn-primary" disabled={busy}>
                  Save entry
                </button>
                {editId && (
                  <button type="button" className="btn btn-quiet" onClick={() => setEditId(null)}>
                    Cancel edit
                  </button>
                )}
              </form>
            )}
            {allowed("tally_set_savings_goal") && (
              <section className="panel space-y-3">
                <h2 className="text-lg font-medium">Monthly settings</h2>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      void run("tally_set_savings_goal", {
                        currency,
                        month,
                        expectedRevision: revision,
                        name: goalName,
                        targetMinor: minor(goalAmount),
                      });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <label className="block">
                    Savings goal
                    <input
                      className={control}
                      maxLength={40}
                      value={goalName}
                      onChange={(e) => setGoalName(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    Goal amount
                    <input
                      className={control}
                      inputMode="decimal"
                      value={goalAmount}
                      onChange={(e) => setGoalAmount(e.target.value)}
                    />
                  </label>
                  <button className="btn btn-quiet" disabled={busy}>
                    Save goal
                  </button>
                </form>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      void run(
                        limit.trim() ? "tally_set_category_budget" : "tally_clear_category_budget",
                        {
                          currency,
                          month,
                          expectedRevision: revision,
                          category,
                          ...(limit.trim() ? { limitMinor: minor(limit) } : {}),
                        },
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <label className="block">
                    Budget category
                    <select
                      aria-label="Category"
                      className={control}
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value);
                        setKind("expense");
                      }}
                    >
                      {categories
                        .filter((c) => c.kind === "expense" && !c.archived)
                        .map((c) => (
                          <option key={c.id}>{c.name}</option>
                        ))}
                    </select>
                  </label>
                  <label className="block">
                    Limit (blank removes limit)
                    <input
                      className={control}
                      inputMode="decimal"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                    />
                  </label>
                  <button className="btn btn-quiet" disabled={busy}>
                    Save budget
                  </button>
                </form>
              </section>
            )}
          </div>
          <section className="panel">
            <h2 className="text-lg font-medium">Entries</h2>
            {entries.map((tx) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-3"
                key={tx.id}
              >
                <div className="min-w-0 break-words">
                  <p>{tx.note || tx.category}</p>
                  <p className="text-xs text-muted">
                    {tx.date} · {tx.category} · {tx.kind}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="tabular-nums">{money(tx.amountMinor)}</strong>
                  {allowed("tally_update_transaction") && (
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        setEditId(tx.id);
                        setKind(tx.kind);
                        setCategory(tx.category);
                        setAmount(String(tx.amountMinor / 100));
                        setNote(tx.note);
                        setDate(tx.date);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {allowed("tally_prepare_delete_transaction") && (
                    <button
                      className="btn btn-quiet"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          "tally_prepare_delete_transaction",
                          { currency, transactionId: tx.id, expectedRevision: revision },
                          (v) => {
                            setPreview({ ...v, commitTool: "tally_delete_transaction" });
                            setTab("imports");
                          },
                        )
                      }
                    >
                      Review delete
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!entries.length && (
              <p className="mt-3 text-muted">
                No visible entries. Detailed transaction access requires its own grant.
              </p>
            )}
            {cursor && (
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() =>
                  void run(
                    "tally_list_transactions",
                    { currency, month, limit: 50, cursor },
                    (page) => {
                      setEntries((rows) => [...rows, ...page.items]);
                      setCursor(page.nextCursor);
                    },
                  )
                }
              >
                More entries
              </button>
            )}
          </section>
          <section className="panel">
            <h2 className="text-lg font-medium">Budgets</h2>
            {summary?.categories.map((c: Row) => (
              <p key={c.category} className="mt-2">
                {c.category}: {money(c.spentMinor)}
                {c.budgetMinor == null ? " · no limit" : ` of ${money(c.budgetMinor)}`}
              </p>
            ))}
          </section>
          <section className="panel flex flex-wrap gap-2">
            {[
              ["tally_export_transactions_csv", "Export CSV"],
              ["tally_export_monthly_pdf", "Export PDF"],
              ["tally_export_backup", "Export backup"],
            ]
              .filter(([name]) => allowed(name))
              .map(([name, label]) => (
                <button
                  key={name}
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      name,
                      { currency, ...(name === "tally_export_backup" ? {} : { month }) },
                      (v) =>
                        void client.download(currency, v.fileId).catch((e) => setError(e.message)),
                    )
                  }
                >
                  {label}
                </button>
              ))}
            <button
              className="btn btn-quiet"
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              Refresh
            </button>
          </section>
        </>
      )}
      {tab === "categories" && (
        <section className="panel space-y-3">
          <h2 className="text-lg font-medium">Categories</h2>
          <p className="text-muted">
            Names and budgets belong to this currency. Renaming updates historical references;
            archiving preserves them.
          </p>
          {allowed("tally_create_category") && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  "tally_create_category",
                  { currency, expectedRevision: revision, kind, name: categoryName },
                  () => setCategoryName(""),
                );
              }}
            >
              <input
                aria-label="New category name"
                className="field min-w-0 flex-1"
                maxLength={40}
                required
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
              />
              <select
                aria-label="Category type"
                className="field"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
              <button className="btn btn-primary" disabled={busy}>
                Create category
              </button>
            </form>
          )}
          {categories.map((c) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2"
              key={c.id}
            >
              <span>
                {c.name} · {c.kind}
                {c.archived ? " · archived" : ""}
              </span>
              {allowed("tally_update_category") && (
                <div className="flex gap-2">
                  <button
                    className="btn btn-quiet"
                    disabled={busy}
                    onClick={() => {
                      const name = window.prompt("New category name", c.name);
                      if (name)
                        void run("tally_update_category", {
                          currency,
                          expectedRevision: revision,
                          categoryId: c.id,
                          name,
                        });
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="btn btn-quiet"
                    disabled={busy}
                    onClick={() =>
                      void run(c.archived ? "tally_restore_category" : "tally_archive_category", {
                        currency,
                        expectedRevision: revision,
                        categoryId: c.id,
                      })
                    }
                  >
                    {c.archived ? "Restore" : "Archive"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
      {tab === "imports" && (
        <section className="panel space-y-4">
          <h2 className="text-lg font-medium">Import and recovery</h2>
          <p className="text-muted">
            Files selected here are uploaded to your private Tally server. Review mapping, currency,
            dates, categories and duplicates before committing. Scanned and password-protected PDFs
            are unsupported.
          </p>
          <label className="block">
            CSV or text PDF
            <input
              className={control}
              disabled={busy}
              type="file"
              accept=".csv,.pdf"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <label className="block">
            Restore a Tally JSON backup
            <input
              className={control}
              disabled={busy}
              type="file"
              accept=".json"
              onChange={(e) => {
                void upload(e.target.files?.[0], true);
                e.target.value = "";
              }}
            />
          </label>
          {draft && (
            <>
              <h3>{draft.rowCount} staged rows</h3>
              <p className="text-muted">
                The suggested amount direction must be checked against your bank’s statement. Date
                format can be auto, dmy or mdy. Column numbers start at zero.
              </p>
              <label className="block">
                Column mapping
                <textarea
                  aria-label="Column mapping"
                  className={`${control} min-h-52 font-mono text-sm`}
                  value={mapping}
                  onChange={(e) => {
                    setMapping(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => {
                  try {
                    void run(
                      "tally_set_import_mapping",
                      { currency, importId: draft.importId, mapping: JSON.parse(mapping) },
                      () => setPreview(null),
                    );
                  } catch {
                    setError("Mapping must be valid JSON.");
                  }
                }}
              >
                Apply mapping
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    "tally_preview_import",
                    { currency, importId: draft.importId, expectedRevision: revision },
                    setPreview,
                  )
                }
              >
                Preview import
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() =>
                  void run("tally_cancel_import", { currency, importId: draft.importId }, () => {
                    setDraft(null);
                    setPreview(null);
                  })
                }
              >
                Cancel import
              </button>
              <div className="max-h-96 overflow-auto rounded border border-line">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="p-2">Row</th>
                      {draft.headers.map((h: string) => (
                        <th className="p-2 text-left" key={h}>
                          {h}
                        </th>
                      ))}
                      <th>Correct</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.items.map((row: Row) => (
                      <tr key={row.rowNumber} className="border-t border-line">
                        <td className="p-2">{row.rowNumber}</td>
                        {row.values.map((value: string, index: number) => (
                          <td className="max-w-52 break-words p-2" key={index}>
                            {value}
                          </td>
                        ))}
                        <td>
                          <button
                            className="btn btn-quiet"
                            disabled={busy}
                            onClick={() => {
                              const input = window.prompt(
                                "Correct this row as a JSON array of column values",
                                JSON.stringify(row.values),
                              );
                              if (input)
                                try {
                                  const values = JSON.parse(input);
                                  void run(
                                    "tally_correct_import_rows",
                                    {
                                      currency,
                                      importId: draft.importId,
                                      corrections: [{ rowNumber: row.rowNumber, values }],
                                    },
                                    () => {
                                      setDraft({
                                        ...draft,
                                        items: draft.items.map((r: Row) =>
                                          r.rowNumber === row.rowNumber ? { ...r, values } : r,
                                        ),
                                      });
                                      setPreview(null);
                                    },
                                  );
                                } catch {
                                  setError("Enter a JSON array of column values.");
                                }
                            }}
                          >
                            Correct
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {draft.nextCursor && (
                <button
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "tally_get_import",
                      { currency, importId: draft.importId, limit: 100, cursor: draft.nextCursor },
                      (v) => setDraft({ ...draft, ...v }),
                    )
                  }
                >
                  Next rows
                </button>
              )}
            </>
          )}
          {preview && (
            <div className="rounded border border-line p-3">
              <h3 className="font-medium">Review</h3>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(preview.review ?? preview, null, 2)}
              </pre>
              {preview.planId && (
                <>
                  {preview.approvalRequired !== false && (
                    <>
                      <button
                        className="btn btn-quiet mt-3"
                        disabled={busy}
                        onClick={() => void requestApproval(preview)}
                      >
                        Request owner approval
                      </button>
                      <label className="mt-3 block">
                        Approval id
                        <input
                          className={control}
                          value={approvalId}
                          onChange={(e) => setApprovalId(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <button
                    className="btn btn-primary mt-3"
                    disabled={busy || (preview.approvalRequired !== false && !approvalId)}
                    onClick={() =>
                      void run(
                        preview.commitTool ??
                          (draft ? "tally_commit_import" : "tally_commit_restore"),
                        {
                          currency,
                          expectedRevision: preview.revision,
                          planId: preview.planId,
                          previewHash: preview.previewHash,
                          ...(preview.approvalRequired !== false ? { approvalId } : {}),
                        },
                        () => {
                          setPreview(null);
                          setDraft(null);
                          setApprovalId("");
                        },
                      )
                    }
                  >
                    Commit displayed preview
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}
      {tab === "approvals" && (
        <section className="panel space-y-3">
          <h2 className="text-lg font-medium">Review and consent</h2>
          <p className="text-muted">
            Review the exact currency, rows and revision before deciding. Bearer deployments require
            an owner grant. Private shared Tailscale financial previews can be committed directly;
            external AI requests still require consent.
          </p>
          <button className="btn btn-quiet" onClick={() => void reviewApprovals()}>
            Refresh approvals
          </button>
          {!approvals.length && (
            <p className="text-sm text-muted">
              No approvals loaded. Refresh to check pending reviews. Private financial changes use
              their displayed preview directly; external AI sharing still needs consent.
            </p>
          )}
          {approvals.map((a) => (
            <div key={a.approvalId} className="rounded border border-line p-3">
              <p className="font-medium">
                {a.operation} · {a.currency} · revision {a.revision}
              </p>
              <p className="text-sm text-muted">
                Requested by {a.actorId} · {a.approvalId}
              </p>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(a.review, null, 2)}
              </pre>
              {a.review?.importId && (
                <button
                  className="btn btn-quiet"
                  onClick={() => void loadApprovalRows(a.approvalId)}
                >
                  Inspect frozen rows
                </button>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void decide(a, true)}
                >
                  Approve displayed preview
                </button>
                <button
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() => void decide(a, false)}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
          {approvalRowsNext && (
            <button
              className="btn btn-quiet"
              onClick={() => void loadApprovalRows(approvalRowsId, approvalRowsNext)}
            >
              More frozen changes
            </button>
          )}
          {approvalRows.length > 0 && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
              {JSON.stringify(approvalRows, null, 2)}
            </pre>
          )}
        </section>
      )}
      {tab === "chat" && (
        <section className="panel space-y-3">
          <h2 className="text-lg font-medium">Spending chat</h2>
          <p className="text-muted">
            {aiStatusError ||
              (aiReady === null
                ? "Checking provider availability…"
                : aiReady
                  ? "Review the monthly aggregates and approve external sharing before sending each question."
                  : "Provider unconfigured. No financial data is sent.")}
          </p>
          <button
            className="btn btn-quiet"
            disabled={busy || !question.trim() || !allowed("tally_create_analysis_context")}
            onClick={() =>
              void run("tally_create_analysis_context", { currency, month, question }, setContext)
            }
          >
            Review monthly context
          </button>
          {context && (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(context.review, null, 2)}
              </pre>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => void requestApproval(context)}
              >
                Request data-sharing approval
              </button>
              <label className="block">
                Approved consent id
                <input
                  className={control}
                  value={approvalId}
                  onChange={(e) => setApprovalId(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="block">
            Question
            <textarea
              aria-label="Question"
              className={control}
              maxLength={500}
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setContext(null);
                setApprovalId("");
              }}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={
              busy || !aiReady || !context || !approvalId || !question || ai?.status === "pending"
            }
            onClick={() =>
              void run(
                "tally_ask_spending_question",
                { currency, contextId: context!.contextId, approvalId, question },
                setAi,
              )
            }
          >
            Send approved question
          </button>
          {ai && (
            <div role="status">
              <p>{ai.status}</p>
              <p className="whitespace-pre-wrap">{ai.answer ?? ai.error ?? ""}</p>
              {ai.status === "pending" && (
                <button
                  className="btn btn-quiet"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "tally_cancel_ai_request",
                      { currency, requestId: ai.requestId },
                      setAi,
                    )
                  }
                >
                  Cancel provider request
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {tab === "tools" && (
        <section className="panel space-y-3">
          <h2 className="text-lg font-medium">Agent tool console</h2>
          <p className="text-muted">
            Only operations allowed by this credential are listed. This console uses the same typed
            contracts as MCP.
          </p>
          <select
            aria-label="Tool"
            className={control}
            value={selectedTool}
            onChange={(e) => {
              setSelectedTool(e.target.value);
              setArgsText("{}");
            }}
          >
            {tools.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
          <p className="text-sm text-muted">
            {tools.find((t) => t.name === selectedTool)?.description}
          </p>
          <details>
            <summary>Input schema</summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(tools.find((t) => t.name === selectedTool)?.inputSchema, null, 2)}
            </pre>
          </details>
          <label className="block">
            Arguments
            <textarea
              aria-label="Arguments"
              className={`${control} min-h-32 font-mono text-sm`}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              try {
                void run(selectedTool, JSON.parse(argsText));
              } catch {
                setError("Arguments must be a JSON object.");
              }
            }}
          >
            Run tool
          </button>
          {result && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </section>
      )}
      <p className="text-center text-xs text-muted">
        Private server storage ·{" "}
        <Link to="/" search={{ currency, month }}>
          Dashboard
        </Link>
      </p>
    </main>
  );
}
