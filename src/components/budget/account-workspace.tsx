import { useEffect, useState } from "react";
import { TallyClient } from "@/lib/agent-tools/client";
import { formatMoney, type Currency } from "@/lib/budget";
type Row = Record<string, any>;
type Props = {
  client: TallyClient;
  currency: Currency;
  month: string;
  revision: number;
  categories: Row[];
  busy: boolean;
  canRead: boolean;
  canWrite: boolean;
  run: (tool: string, args: Row, onResult?: (value: Row) => void) => Promise<void>;
};
function amount(input: string, allowZero = false, signed = false) {
  const text = input.trim();
  if (!(signed ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(text))
    throw new Error("Use an amount with at most two decimal places.");
  const [whole, decimals = ""] = text.replace(/^-/, "").split(".");
  const minor =
    (BigInt(whole) * 100n + BigInt(decimals.padEnd(2, "0"))) * (text.startsWith("-") ? -1n : 1n);
  if (minor > 1_000_000_000_000n || minor < -1_000_000_000_000n || (!allowZero && minor === 0n))
    throw new Error("Choose a bounded, nonzero amount.");
  return Number(minor);
}
export function AccountWorkspace({
  client,
  currency,
  month,
  revision,
  categories,
  busy,
  canRead,
  canWrite,
  run,
}: Props) {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [correctionAccount, setCorrectionAccount] = useState("");
  const [correctionDelta, setCorrectionDelta] = useState("0");
  const [correctionReason, setCorrectionReason] = useState("");
  const [position, setPosition] = useState<Row | null>(null),
    [report, setReport] = useState<Row | null>(null);
  const [events, setEvents] = useState<Row[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(""),
    [type, setType] = useState("bank");
  const [openingKnown, setOpeningKnown] = useState(false),
    [openingAmount, setOpeningAmount] = useState("0");
  const [openingDate, setOpeningDate] = useState(asOf),
    [timing, setTiming] = useState("start_of_day");
  const [eventKind, setEventKind] = useState("expense"),
    [primary, setPrimary] = useState(""),
    [secondary, setSecondary] = useState("");
  const [eventAmount, setEventAmount] = useState(""),
    [interest, setInterest] = useState("0"),
    [fee, setFee] = useState("0");
  const [eventDate, setEventDate] = useState(asOf),
    [note, setNote] = useState("");
  const [categoryId, setCategoryId] = useState("expense:Personal"),
    [originalId, setOriginalId] = useState("");
  const [preview, setPreview] = useState<Row | null>(null),
    [approvalId, setApprovalId] = useState("");
  const [approved, setApproved] = useState(false),
    [reviewing, setReviewing] = useState(false);
  const [year, monthNumber] = month.split("-").map(Number);
  const from = `${month}-01`,
    to = `${month}-${String(new Date(year, monthNumber, 0).getDate()).padStart(2, "0")}`;
  const accounts = position?.accounts?.map((row: Row) => row.account) ?? [];
  const active = accounts.filter((a: Row) => !a.archived);
  const money = (value: number | null) =>
    value === null ? "Unknown" : formatMoney(value, currency);
  const control = "field w-full";
  const locked = busy || reviewing || !canWrite;
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    setError("");
    void Promise.all([
      client.call("tally_get_financial_position", { currency, asOf }),
      client.call("tally_get_income_expense_report", { currency, from, to }),
      client.call("tally_list_journal_events", { currency, from, to, limit: 50 }),
    ])
      .then(([p, r, page]) => {
        if (live) {
          setPosition(p);
          setReport(r);
          setEvents(page.items);
          setNext(page.nextCursor);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [client, currency, revision, asOf, from, to, canRead]);
  function staged(value: Row, commitTool: string) {
    setPreview({ ...value, commitTool });
    setApprovalId("");
    setApproved(false);
    setError("");
  }
  function prepare(tool: string, args: Row, commitTool = "tally_commit_account_change") {
    if (preview) {
      setError("Commit or cancel the current preview before preparing another change.");
      return;
    }
    void run(tool, { currency, expectedRevision: revision, ...args }, (value) =>
      staged(value, commitTool),
    );
  }
  function opening() {
    return { date: openingDate, timing, balanceMinor: amount(openingAmount, true, true) };
  }
  function prepareJournal() {
    try {
      const base = { kind: eventKind, date: eventDate, note };
      let event: Row;
      if (eventKind === "income" || eventKind === "expense" || eventKind === "refund")
        event = {
          ...base,
          accountId: primary,
          allocations: [{ categoryId, amountMinor: amount(eventAmount) }],
          ...(eventKind === "refund" ? { originalEventId: originalId } : {}),
        };
      else if (eventKind === "transfer" || eventKind === "card_payment")
        event = {
          ...base,
          fromAccountId: primary,
          toAccountId: secondary,
          amountMinor: amount(eventAmount),
        };
      else if (eventKind === "loan_borrowing")
        event = {
          ...base,
          assetAccountId: primary,
          loanAccountId: secondary,
          amountMinor: amount(eventAmount),
        };
      else
        event = {
          ...base,
          assetAccountId: primary,
          loanAccountId: secondary,
          principalMinor: amount(eventAmount, true),
          ...(amount(interest, true) || amount(fee, true)
            ? {
                allocations: [
                  ...(amount(interest, true)
                    ? [{ categoryId, amountMinor: amount(interest), component: "interest" }]
                    : []),
                  ...(amount(fee, true)
                    ? [{ categoryId, amountMinor: amount(fee), component: "fee" }]
                    : []),
                ],
              }
            : {}),
        };
      prepare("tally_prepare_journal_event", { event }, "tally_commit_journal_event");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the journal amounts.");
    }
  }
  async function approve() {
    if (!preview || !approvalId) return;
    setReviewing(true);
    setError("");
    try {
      await client.request("/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId, previewHash: preview.previewHash, approve: true }),
      });
      setApproved(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Review response interrupted. Check the review decision before retrying.",
      );
    } finally {
      setReviewing(false);
    }
  }
  if (!canRead)
    return <section className="panel">Account access is unavailable for this connection.</section>;
  return (
    <div className="space-y-5">
      <section className="panel space-y-3">
        <h2 className="text-xl font-semibold">Recorded accounts</h2>
        <p className="text-sm text-muted">
          Bank and cash balances, card debt and loan principal come from reviewed journals. Legacy
          budget entries are separate until an explicit migration. Dated statement coverage appears
          when the statement workflows are activated.
        </p>
        <label className="block max-w-xs">
          Balances as of
          <input
            type="date"
            className={control}
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Known assets", position?.assetsMinor ?? 0],
            ["Known liabilities", position?.liabilitiesMinor ?? 0],
            ["Recorded net position", position?.netPositionMinor ?? null],
          ].map(([label, value]) => (
            <div className="rounded border border-line p-3" key={String(label)}>
              <p className="text-sm text-muted">{String(label)}</p>
              <p className="text-xl font-medium">{money(value as number | null)}</p>
            </div>
          ))}
        </div>
        {!position?.complete && (
          <p className="text-sm">
            Some opening balances are unknown. These totals cover known balances only.
          </p>
        )}
        <p className="text-xs text-muted">
          As of {asOf} · tracked accounts only · review each account’s source status · no live bank
          connection
        </p>
        {position?.accounts?.map((row: Row) => (
          <div key={row.account.id} className="rounded border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">{row.account.name}</h3>
                <p className="text-sm text-muted">
                  {row.account.type.replaceAll("_", " ")} {row.account.archived ? "· archived" : ""}
                </p>
              </div>
              <p className="text-lg">{money(row.balanceMinor)}</p>
            </div>
            <p className="mt-1 text-xs text-muted">
              {row.openingKnown
                ? `Opening ${row.account.opening.date} (${row.account.opening.timing.replaceAll("_", " ")})`
                : "Opening unknown"}{" "}
              · latest recorded event {row.lastRecordedDate ?? "none"} · {row.reconciliation}
              {row.lastStatementDate ? ` · latest statement ${row.lastStatementDate}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {!row.account.opening && (
                <button
                  className="btn btn-quiet"
                  disabled={locked}
                  onClick={() => {
                    try {
                      prepare("tally_prepare_opening_balance", {
                        accountId: row.account.id,
                        opening: opening(),
                      });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Review opening using fields below
                </button>
              )}
              <button
                className="btn btn-quiet"
                disabled={locked}
                onClick={() =>
                  prepare("tally_prepare_account_update", {
                    accountId: row.account.id,
                    archived: !row.account.archived,
                  })
                }
              >
                {row.account.archived ? "Review restore" : "Review archive"}
              </button>
            </div>
          </div>
        ))}
        {!accounts.length && (
          <p className="text-muted">
            No accounts recorded. Add an account below; an unknown opening stays unknown.
          </p>
        )}
      </section>
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Add account / opening fields</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Account name
            <input
              className={control}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Account type
            <select className={control} value={type} onChange={(e) => setType(e.target.value)}>
              {["bank", "cash", "credit_card", "loan"].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Opening date
            <input
              type="date"
              className={control}
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
          </label>
          <label>
            Opening cutoff
            <select className={control} value={timing} onChange={(e) => setTiming(e.target.value)}>
              <option value="start_of_day">Before that day’s movements</option>
              <option value="end_of_day">After that day’s movements</option>
            </select>
          </label>
          <label>
            Opening amount
            <input
              inputMode="decimal"
              className={control}
              value={openingAmount}
              onChange={(e) => setOpeningAmount(e.target.value)}
            />
            <span className="text-xs text-muted">
              Positive card/loan amount means debt; a negative amount means a credit.
            </span>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={openingKnown}
            onChange={(e) => setOpeningKnown(e.target.checked)}
          />
          Include this reviewed opening with the new account
        </label>
        <button
          className="btn btn-primary"
          disabled={locked || !name.trim()}
          onClick={() => {
            try {
              prepare("tally_prepare_account", {
                name,
                type,
                ...(openingKnown ? { opening: opening() } : {}),
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Prepare account preview
        </button>
      </section>
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Record money movement</h2>
        <p className="text-sm text-muted">
          Transfers and ATM withdrawals move assets. Card payments and loan principal settle debt;
          only purchases, interest and fees count as expense.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Event
            <select
              className={control}
              value={eventKind}
              onChange={(e) => {
                setEventKind(e.target.value);
                setCategoryId(e.target.value === "income" ? "income:Pay" : "expense:Personal");
              }}
            >
              {[
                "expense",
                "income",
                "transfer",
                "card_payment",
                "loan_borrowing",
                "loan_payment",
                "refund",
              ].map((kind) => (
                <option key={kind} value={kind}>
                  {kind === "transfer" ? "Transfer / ATM withdrawal" : kind.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Date
            <input
              type="date"
              className={control}
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </label>
          <label>
            Bank / cash / paying or receiving account
            <select
              className={control}
              value={primary}
              onChange={(e) => setPrimary(e.target.value)}
            >
              <option value="">Choose account</option>
              {active.map((a: Row) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.type}
                </option>
              ))}
            </select>
          </label>
          {["transfer", "card_payment", "loan_borrowing", "loan_payment"].includes(eventKind) && (
            <label>
              Destination / card / loan account
              <select
                className={control}
                value={secondary}
                onChange={(e) => setSecondary(e.target.value)}
              >
                <option value="">Choose counterpart</option>
                {active.map((a: Row) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.type}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {eventKind === "loan_payment" ? "Principal paid" : "Amount"}
            <input
              inputMode="decimal"
              className={control}
              value={eventAmount}
              onChange={(e) => setEventAmount(e.target.value)}
            />
          </label>
          {["income", "expense", "loan_payment", "refund"].includes(eventKind) && (
            <label>
              {eventKind === "loan_payment"
                ? "Interest / fee category"
                : "Income / expense category"}
              <select
                className={control}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories
                  .filter(
                    (c) =>
                      !c.archived && c.kind === (eventKind === "income" ? "income" : "expense"),
                  )
                  .map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {eventKind === "loan_payment" && (
            <>
              <label>
                Interest paid
                <input
                  inputMode="decimal"
                  className={control}
                  value={interest}
                  onChange={(e) => setInterest(e.target.value)}
                />
              </label>
              <label>
                Fees paid
                <input
                  inputMode="decimal"
                  className={control}
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                />
              </label>
            </>
          )}
          {eventKind === "refund" && (
            <label>
              Original purchase
              <select
                className={control}
                value={originalId}
                onChange={(e) => setOriginalId(e.target.value)}
              >
                <option value="">Choose recorded purchase</option>
                {events
                  .filter((e) => e.kind === "expense")
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.date} · {e.note || "Purchase"} · {e.id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Description
            <input
              className={control}
              maxLength={80}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={locked || !primary || !eventAmount}
          onClick={prepareJournal}
        >
          Prepare journal preview
        </button>
        <p className="text-xs text-muted">
          For multiple category splits, use the same journal operation in Tools or MCP with explicit
          allocations.
        </p>
      </section>
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Correct an opening amount</h2>
        <p className="text-sm text-muted">
          Use an explicit correction to a previously reviewed opening amount. The original stays in
          history. This does not reconcile a statement or fill an unexplained closing-balance
          difference.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Account
            <select
              className={control}
              value={correctionAccount}
              onChange={(e) => setCorrectionAccount(e.target.value)}
            >
              <option value="">Choose an account with an opening</option>
              {accounts
                .filter((a: Row) => a.opening)
                .map((a: Row) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Signed correction amount
            <input
              className={control}
              inputMode="decimal"
              value={correctionDelta}
              onChange={(e) => setCorrectionDelta(e.target.value)}
            />
          </label>
          <label>
            Reason
            <input
              className={control}
              maxLength={80}
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted">
          Correction date: {eventDate}. Positive increases an asset balance or liability; negative
          decreases it. Openings are not income or expense.
        </p>
        <button
          className="btn btn-quiet"
          disabled={locked || !correctionAccount || !correctionReason.trim()}
          onClick={() => {
            try {
              prepare("tally_prepare_opening_correction", {
                accountId: correctionAccount,
                date: eventDate,
                deltaMinor: amount(correctionDelta, false, true),
                note: correctionReason,
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Prepare opening correction
        </button>
      </section>
      {preview && (
        <section className="panel space-y-3">
          <h2 className="text-lg font-medium">Review proposed change</h2>
          <p className="text-sm text-muted">
            Nothing is posted until the displayed change is reviewed and committed. Account, cutoff,
            currency and postings must match your intent.
          </p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
            {JSON.stringify(preview.review, null, 2)}
          </pre>
          <div className="flex flex-wrap gap-2">
            {preview.approvalRequired !== false && !approvalId && (
              <button
                className="btn btn-quiet"
                disabled={locked}
                onClick={() =>
                  void run("tally_request_approval", { currency, planId: preview.planId }, (v) =>
                    setApprovalId(v.approvalId),
                  )
                }
              >
                Request review
              </button>
            )}
            {preview.approvalRequired !== false && approvalId && !approved && (
              <>
                <button className="btn btn-quiet" disabled={locked} onClick={() => void approve()}>
                  Approve displayed preview
                </button>
                <button
                  className="btn btn-quiet"
                  disabled={locked}
                  onClick={() =>
                    void run("tally_get_approval", { currency, approvalId }, (v) =>
                      setApproved(v.status === "approved"),
                    )
                  }
                >
                  Check review decision
                </button>
              </>
            )}
            {(preview.approvalRequired === false || approved) && (
              <button
                className="btn btn-primary"
                disabled={locked}
                onClick={() =>
                  void run(
                    preview.commitTool,
                    {
                      currency,
                      expectedRevision: preview.revision,
                      planId: preview.planId,
                      previewHash: preview.previewHash,
                      ...(preview.approvalRequired !== false ? { approvalId } : {}),
                    },
                    () => {
                      setPreview(null);
                      setApprovalId("");
                      setApproved(false);
                    },
                  )
                }
              >
                Commit displayed change
              </button>
            )}
            <button
              className="btn btn-quiet"
              disabled={locked}
              onClick={() =>
                void run(
                  "tally_cancel_operation",
                  { currency, operationId: preview.planId },
                  () => {
                    setPreview(null);
                    setApprovalId("");
                    setApproved(false);
                  },
                )
              }
            >
              Cancel preview
            </button>
          </div>
        </section>
      )}
      <section className="panel space-y-3">
        <h2 className="text-lg font-medium">Journal report · {month}</h2>
        <p>
          Income {money(report?.incomeMinor ?? 0)} · Net expense {money(report?.expenseMinor ?? 0)}
        </p>
        <p className="text-xs text-muted">
          {from} through {to} · account journals only · legacy entries excluded · not reconciled
        </p>
        {events.map((event) => (
          <details className="rounded border border-line p-3" key={event.id}>
            <summary>
              {event.date} · {event.kind.replaceAll("_", " ")} · {event.note || "Recorded event"}
            </summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(event, null, 2)}
            </pre>
            {!["opening", "opening_correction", "reversal"].includes(event.kind) && (
              <button
                className="btn btn-quiet mt-2"
                disabled={locked || !note.trim()}
                onClick={() =>
                  prepare(
                    "tally_prepare_journal_reversal",
                    { eventId: event.id, date: eventDate, note },
                    "tally_commit_journal_event",
                  )
                }
              >
                Review reversal using date and reason above
              </button>
            )}
          </details>
        ))}
        {next && (
          <button
            className="btn btn-quiet"
            disabled={busy}
            onClick={() =>
              void run(
                "tally_list_journal_events",
                { currency, from, to, limit: 50, cursor: next },
                (page) => {
                  setEvents((rows) => [...rows, ...page.items]);
                  setNext(page.nextCursor);
                },
              )
            }
          >
            Next recorded events
          </button>
        )}
      </section>
      {error && (
        <p role="alert" className="text-expense">
          {error}
        </p>
      )}
    </div>
  );
}
