import { ReviewDetails } from "./review-details";
import { useEffect, useRef, useState } from "react";
import { TallyClient } from "@/lib/agent-tools/client";
import { formatMoney, monthKey, defaultDateForMonth, type Currency } from "@/lib/budget";
type Row = Record<string, any>;
type Props = {
  client: TallyClient;
  currency: Currency;
  revision: number;
  busy: boolean;
  enabled: boolean;
  run: (tool: string, args: Row, onResult?: (value: Row) => void) => Promise<void>;
};
function minor(value: string) {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("Use at most two decimal places.");
  const [whole, decimal = ""] = value.trim().replace(/^-/u, "").split(".");
  const result =
    (BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"))) *
    (value.trim().startsWith("-") ? -1n : 1n);
  if (result > 1000000000000n || result < -1000000000000n)
    throw new Error("Amount exceeds the supported range.");
  return Number(result);
}
export function StatementWorkspace({ client, currency, revision, busy, enabled, run }: Props) {
  const [accounts, setAccounts] = useState<Row[]>([]),
    [statements, setStatements] = useState<Row[]>([]),
    [batches, setBatches] = useState<Row[]>([]);
  const [accountId, setAccountId] = useState(""),
    [from, setFrom] = useState(monthKey(new Date()) + "-01"),
    [to, setTo] = useState(defaultDateForMonth(monthKey(new Date()))),
    [closing, setClosing] = useState(""),
    [timing, setTiming] = useState("end_of_day");
  const [selected, setSelected] = useState(""),
    [rows, setRows] = useState<Row[]>([]),
    [mapping, setMapping] = useState(""),
    [decisions, setDecisions] = useState("[]");
  const [batchId, setBatchId] = useState(""),
    [legacy, setLegacy] = useState<Row | null>(null),
    [legacyDecisions, setLegacyDecisions] = useState("[]");
  const [preview, setPreview] = useState<Row | null>(null),
    [approvalId, setApprovalId] = useState(""),
    [approved, setApproved] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const [currentStatement, setCurrentStatement] = useState<Row | null>(null);
  const [rowsNext, setRowsNext] = useState<string | null>(null),
    [rowsTotal, setRowsTotal] = useState(0),
    [rowsMode, setRowsMode] = useState<"sources" | "matches">("sources"),
    [rowsRevision, setRowsRevision] = useState<number | null>(null);
  const [reading, setReading] = useState(false),
    [group, setGroup] = useState<string[]>([]),
    [statementNext, setStatementNext] = useState<string | null>(null),
    [legacyNext, setLegacyNext] = useState<string | null>(null),
    [legacyRevision, setLegacyRevision] = useState<number | null>(null);
  const rowRequest = useRef(0),
    legacyRequest = useRef(0);
  const [coverage, setCoverage] = useState<Row | null>(null);
  const money = (value: number | null) =>
    value === null ? "Unknown" : formatMoney(value, currency);
  const locked = busy || reviewing || uploading || reading;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.all([
      client.call("tally_list_accounts", { currency }),
      client.call("tally_list_account_statements", { currency, limit: 100 }),
      client.call("tally_list_legacy_migrations", { currency, limit: 100 }),
    ])
      .then(([a, s, b]) => {
        if (live) {
          setAccounts(a.accounts);
          setStatements(s.items);
          setStatementNext(s.nextCursor);
          setGroup((current) =>
            current.filter((id) => s.items.some((item: Row) => item.id === id)),
          );
          setBatches(b.items);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [client, currency, revision, enabled]);
  useEffect(() => {
    setReading(false);
    setSelected("");
    setCurrentStatement(null);
    setPreview(null);
    setApprovalId("");
    setApproved(false);
    setRows([]);
    setRowsNext(null);
    setLegacy(null);
    setLegacyNext(null);
    setGroup([]);
    setRowsTotal(0);
    setRowsRevision(null);
    setLegacyRevision(null);
    return () => {
      rowRequest.current += 1;
      legacyRequest.current += 1;
    };
  }, [client, currency]);
  function prepare(tool: string, args: Row, commitTool: string) {
    if (preview) {
      setError("Commit or cancel the current frozen preview first.");
      return;
    }
    void run(tool, { currency, expectedRevision: revision, ...args }, (value) => {
      setPreview({ ...value, commitTool });
      setApprovalId("");
      setApproved(false);
    });
  }
  async function upload(file: File, migration = false) {
    setUploading(true);
    setError("");
    try {
      const extra = migration
        ? {}
        : {
            accountId,
            periodFrom: from,
            periodTo: to,
            closingTiming: timing,
            ...(closing.trim() ? { closingMinor: minor(closing) } : {}),
          };
      const uploaded = await client.upload(currency, file);
      await run(
        migration ? "tally_stage_legacy_migration" : "tally_stage_account_statement",
        { currency, expectedRevision: revision, fileId: uploaded.fileId, ...extra },
        (v) => {
          if (migration) setBatchId(v.batchId);
          else {
            setSelected(v.statementId);
            setRows([]);
            setRowsNext(null);
            setMapping("");
            void inspect(v.statementId);
          }
        },
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Upload interrupted. Reuse the selected file to recover staging.",
      );
    } finally {
      setUploading(false);
    }
  }
  async function inspect(
    statementId: string,
    cursor?: string,
    mode: "sources" | "matches" = "sources",
  ) {
    const request = ++rowRequest.current;
    setSelected(statementId);
    if (!cursor) {
      setRows([]);
      setRowsNext(null);
      setRowsTotal(0);
      setRowsRevision(null);
    }
    setReading(true);
    setError("");
    try {
      const value = await client.call(
        mode === "matches" ? "tally_get_statement_matches" : "tally_get_account_statement",
        {
          currency,
          statementId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      );
      if (request !== rowRequest.current) return;
      const items =
        mode === "matches"
          ? value.items.map((r: Row) => ({
              ...r.observation,
              candidates: r.candidates,
              decision: r.decision,
              referenceConflicts: r.referenceConflicts,
            }))
          : value.items;
      setRows((previous) => (cursor ? [...previous, ...items] : items));
      setRowsNext(value.nextCursor);
      setRowsTotal(value.total);
      setRowsMode(mode);
      setRowsRevision(value.revision);
      if (mode === "matches" || cursor) return;
      setCurrentStatement(value.statement);
      if (value.statement.mapping) setMapping(JSON.stringify(value.statement.mapping, null, 2));
      else {
        const headers = value.statement.headers as string[];
        const find = (r: RegExp) => {
          const i = headers.findIndex((h) => r.test(h.toLowerCase()));
          return i < 0 ? null : i;
        };
        setMapping(
          JSON.stringify(
            {
              dateColumn: find(/date/),
              descriptionColumn: find(/description|narration|merchant/),
              currencyColumn: find(/^currency$/),
              dateFormat: "auto",
              amount: { mode: "signed", amountColumn: find(/^amount$/), positiveAmounts: "income" },
              referenceColumn: find(/reference|transaction.?id/),
            },
            null,
            2,
          ),
        );
      }
    } catch (e) {
      if (request === rowRequest.current) {
        setRowsNext(null);
        setError(e instanceof Error ? e.message : "Statement read failed.");
      }
    } finally {
      if (request === rowRequest.current) setReading(false);
    }
  }
  async function loadStatements() {
    if (!statementNext) return;
    setReading(true);
    try {
      const value = await client.call("tally_list_account_statements", {
        currency,
        limit: 100,
        cursor: statementNext,
      });
      setStatements((previous) => [...previous, ...value.items]);
      setStatementNext(value.nextCursor);
    } catch (e) {
      setStatementNext(null);
      setError(e instanceof Error ? e.message : "Statement list changed. Reload the list.");
    } finally {
      setReading(false);
    }
  }
  async function inspectLegacy(cursor?: string) {
    const request = ++legacyRequest.current;
    setReading(true);
    setError("");
    try {
      const value = await client.call("tally_get_legacy_migration", {
        currency,
        batchId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (request !== legacyRequest.current) return;
      setLegacy((previous) =>
        cursor && previous ? { ...value, items: [...previous.items, ...value.items] } : value,
      );
      setLegacyNext(value.nextCursor);
      setLegacyRevision(value.revision);
    } catch (e) {
      if (request === legacyRequest.current) {
        setLegacyNext(null);
        setError(e instanceof Error ? e.message : "Legacy rows changed. Read them again.");
      }
    } finally {
      if (request === legacyRequest.current) setReading(false);
    }
  }
  async function review() {
    if (!preview || !approvalId) return;
    setReviewing(true);
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
          : "Review response interrupted; inspect the approval decision before retrying.",
      );
    } finally {
      setReviewing(false);
    }
  }
  function parse(text: string) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("The decision or column mapping is not valid JSON.");
    }
  }
  function attempt(work: () => void) {
    setError("");
    try {
      work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid input.");
    }
  }
  if (!enabled)
    return (
      <section className="panel">
        Statement provenance and legacy migration await deliberate activation of Phase B.
      </section>
    );
  return (
    <div className="space-y-5">
      <section className="panel space-y-3">
        <h2 className="text-xl font-semibold">Statement evidence</h2>
        <p className="text-sm text-muted">
          Upload selected CSV or selectable-text PDF statements. Original evidence stays private.
          Mapping and staging add no financial postings; each journal link or exclusion needs
          explicit review.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Account
            <select
              aria-label="Statement account"
              className="field w-full"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Choose account</option>
              {accounts
                .filter((a) => !a.archived)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.type}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Observed closing balance
            <input
              className="field w-full"
              value={closing}
              onChange={(e) => setClosing(e.target.value)}
              placeholder="Optional; unknown stays unknown"
            />
          </label>
          <label>
            Period starts
            <input
              className="field w-full"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Period ends
            <input
              className="field w-full"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label>
            Closing cutoff
            <select
              aria-label="Closing cutoff"
              className="field w-full"
              value={timing}
              onChange={(e) => setTiming(e.target.value)}
            >
              <option value="end_of_day">After the day's movements</option>
              <option value="start_of_day">Before the day's movements</option>
            </select>
          </label>
          <label>
            Selected statement
            <input
              className="field w-full"
              type="file"
              accept=".csv,.pdf"
              disabled={locked || !accountId}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <p className="text-sm text-muted">
          Select mapped statements to review together (up to 10); inspect every page before
          preparing their grouped decisions.
        </p>
        {statements.map((s) => (
          <div key={s.id} className="flex items-center gap-2 rounded border border-line p-2">
            <input
              aria-label={`Include ${accounts.find((a) => a.id === s.accountId)?.name ?? "account"} statement ${s.periodFrom} to ${s.periodTo}`}
              type="checkbox"
              checked={group.includes(s.id)}
              disabled={locked || !s.mapping || (!group.includes(s.id) && group.length >= 10)}
              onChange={(e) =>
                setGroup((current) =>
                  e.target.checked ? [...current, s.id] : current.filter((id) => id !== s.id),
                )
              }
            />
            <button
              className="btn btn-quiet flex-1 text-left"
              disabled={locked}
              onClick={() => void inspect(s.id)}
            >
              {accounts.find((a) => a.id === s.accountId)?.name} · {s.periodFrom}–{s.periodTo} ·{" "}
              {s.rowCount} rows {s.mapping ? "· mapped" : "· mapping needed"}
            </button>
          </div>
        ))}
        {statementNext && (
          <button className="btn btn-quiet" disabled={locked} onClick={() => void loadStatements()}>
            Load more statements
          </button>
        )}
        {selected && (
          <div className="space-y-3 border-t border-line pt-3">
            <label className="block">
              Explicit column mapping (zero-based indices)
              <textarea
                aria-label="Explicit column mapping"
                className="field mt-1 min-h-40 w-full font-mono text-xs"
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              />
            </label>
            <p className="text-xs text-muted">
              For signed amounts, “income” means positive bank credit or card payment credit. Card
              charges increase recorded debt. Use explicit debit/credit columns when appropriate.
              Validate date format and reference column before saving.
            </p>
            <button
              className="btn btn-quiet"
              disabled={locked}
              onClick={() =>
                attempt(
                  () =>
                    void run(
                      "tally_revise_account_statement",
                      {
                        currency,
                        expectedRevision: revision,
                        statementId: selected,
                        mapping: parse(mapping),
                        reason: "Owner supplied explicit column/date/sign mapping",
                      },
                      (v) => {
                        setSelected(v.statementId);
                        void inspect(v.statementId);
                      },
                    ),
                )
              }
            >
              Save mapping revision
            </button>
            <button
              className="btn btn-quiet ml-2"
              disabled={locked || !(currentStatement?.id === selected && currentStatement.mapping)}
              onClick={() => void inspect(selected, undefined, "matches")}
            >
              Read matching suggestions
            </button>
            {rowsRevision !== null && rowsRevision !== revision && (
              <p className="text-expense">
                The workspace changed. Reopen this statement to refresh its pages and decisions.
              </p>
            )}
            <p className="text-sm">
              Showing {rows.length} of {rowsTotal} source rows{" "}
              {rowsMode === "matches" ? "with matching suggestions" : ""}.
            </p>
            <div className="max-h-80 space-y-2 overflow-auto">
              {rows.map((o) => (
                <div className="rounded border border-line p-2 text-sm" key={o.id ?? o.rowNumber}>
                  {o.unmapped ? (
                    <div>
                      <p>Original row {o.rowNumber} · mapping required</p>
                      <dl className="grid gap-1 text-xs">
                        {o.values.map((cell: string, index: number) => (
                          <div key={index} className="break-words">
                            <dt className="font-medium">
                              {currentStatement?.headers[index] ?? `Column ${index}`}
                            </dt>
                            <dd>{cell || "(blank)"}</dd>
                          </div>
                        ))}
                      </dl>
                      {o.parseError && <p className="text-expense">{o.parseError}</p>}
                    </div>
                  ) : (
                    <>
                      <p>
                        Row {o.rowNumber} · {o.date ?? "Invalid date"} ·{" "}
                        {money(o.movementMinor ?? null)} · {o.description}
                      </p>
                      <p className="break-all text-xs text-muted">
                        Observation: {o.id} · reference: {o.providerReference ?? "none"} ·{" "}
                        {o.decision?.disposition ?? "unresolved"}
                      </p>
                      {o.error && <p className="text-expense">{o.error}</p>}
                      {o.candidates?.map((c: Row) => (
                        <p className="break-all text-xs" key={c.eventId}>
                          Suggestion: {c.kind} · {c.canonicalDate} · {c.eventId}
                        </p>
                      ))}
                    </>
                  )}
                </div>
              ))}
            </div>
            {rowsNext && (
              <button
                className="btn btn-quiet"
                disabled={locked || rowsRevision !== revision}
                onClick={() => void inspect(selected, rowsNext, rowsMode)}
              >
                Load next source rows
              </button>
            )}
            <details>
              <summary>Review decision format</summary>
              <p className="text-sm">
                Use “create” with observationIds, an explicit journal event and reason; “link” with
                observationIds, eventId and reason; or “exclude” with observationIds and reason.
                Each row needs a decision. Counterparts from selected statements may share one
                event. Include their observation ids in the same create decision. Date and amount
                similarities remain suggestions.
              </p>
              <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(
                  [
                    {
                      action: "link",
                      observationIds: ["selected observation id"],
                      eventId: "reviewed journal event id",
                      reason: "Explicit evidence and chosen canonical date",
                    },
                  ],
                  null,
                  2,
                )}
              </pre>
            </details>
            <label className="block">
              Reviewed decisions
              <textarea
                aria-label="Reviewed decisions"
                className="field mt-1 min-h-32 w-full font-mono text-xs"
                value={decisions}
                onChange={(e) => setDecisions(e.target.value)}
              />
            </label>
            <button
              className="btn btn-primary"
              disabled={locked}
              onClick={() =>
                attempt(() =>
                  prepare(
                    "tally_prepare_statement_changes",
                    {
                      statementIds: group.length ? group : [selected],
                      decisions: parse(decisions),
                    },
                    "tally_commit_statement_changes",
                  ),
                )
              }
            >
              Preview{" "}
              {group.length > 1
                ? `${group.length} grouped statements`
                : "source and journal changes"}
            </button>
            <button
              className="btn btn-quiet ml-2"
              disabled={locked}
              onClick={() =>
                prepare(
                  "tally_prepare_statement_reconciliation",
                  { statementId: selected },
                  "tally_commit_statement_reconciliation",
                )
              }
            >
              Preview reconciliation
            </button>
          </div>
        )}
        <button
          className="btn btn-quiet"
          disabled={locked || !accountId}
          onClick={() =>
            void run("tally_get_statement_coverage", { currency, accountId, from, to }, setCoverage)
          }
        >
          Read coverage and discrepancies
        </button>
        {coverage && (
          <div className="space-y-2">
            <p className="text-sm">
              Coverage {coverage.from}–{coverage.to} · {coverage.gaps.length} gap(s) ·{" "}
              {coverage.overlappingStatementIds.length} overlap(s)
            </p>
            {coverage.gaps.map((g: Row) => (
              <p key={g.from} className="text-sm text-expense">
                Missing: {g.from}–{g.to}
              </p>
            ))}
            {coverage.statements.map((s: Row) => (
              <div key={s.statementId} className="rounded border border-line p-2 text-sm">
                <p>
                  {s.periodFrom}–{s.periodTo} · {s.reconciliation.status}
                </p>
                <p>
                  Observed {money(s.reconciliation.observedMinor)} · recorded{" "}
                  {money(s.reconciliation.computedMinor)} · difference{" "}
                  {money(s.reconciliation.differenceMinor)}
                </p>
                {s.reconciliation.reasons.map((reason: string) => (
                  <p key={reason} className="text-muted">
                    {reason}
                  </p>
                ))}
              </div>
            ))}
            <p className="text-xs text-muted">
              {coverage.freshness} Discrepancies create no balancing entries.
            </p>
          </div>
        )}
      </section>
      <section className="panel space-y-3">
        <h2 className="text-xl font-semibold">Reviewed legacy migration</h2>
        <p className="text-sm text-muted">
          Stage the current shared legacy ledger or a selected browser backup. Preserve the original
          entries and settings. Map accounts explicitly; entries already in an opening balance
          remain historical cutoff evidence. Unassigned entries stay visible separately.
        </p>
        <button
          className="btn btn-quiet"
          disabled={locked}
          onClick={() =>
            void run(
              "tally_stage_legacy_migration",
              { currency, expectedRevision: revision },
              (v) => setBatchId(v.batchId),
            )
          }
        >
          Stage shared legacy snapshot
        </button>
        <label className="block">
          Selected browser backup
          <input
            className="field w-full"
            type="file"
            accept=".json"
            disabled={locked}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f, true);
              e.target.value = "";
            }}
          />
        </label>
        <select
          aria-label="Legacy migration batch"
          className="field w-full"
          value={batchId}
          disabled={locked}
          onChange={(e) => {
            legacyRequest.current += 1;
            setBatchId(e.target.value);
            setLegacy(null);
            setLegacyNext(null);
          }}
        >
          <option value="">Choose staged batch</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.origin} · {b.entryCount} entries · {b.decided} decided · {b.id}
            </option>
          ))}
        </select>
        <button
          className="btn btn-quiet"
          disabled={locked || !batchId}
          onClick={() => void inspectLegacy()}
        >
          Read original entries and decisions
        </button>
        {legacy && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(legacy, null, 2)}
          </pre>
        )}
        {legacy && (
          <p className="text-sm">
            Showing {legacy.items.length} of {legacy.total} legacy entries.
          </p>
        )}
        {legacyRevision !== null && legacyRevision !== revision && legacy && (
          <p className="text-expense">
            The workspace changed. Read the original entries again before continuing review.
          </p>
        )}
        {legacyNext && (
          <button
            className="btn btn-quiet"
            disabled={locked || legacyRevision !== revision}
            onClick={() => void inspectLegacy(legacyNext)}
          >
            Load next legacy entries
          </button>
        )}
        <details>
          <summary>Migration decision format</summary>
          <p className="text-sm">
            Use “convert” with legacyIds, explicit event and reason; “cutoff” with legacyIds,
            accountId and reason; or “unassigned” with legacyIds and reason. Review every entry.
            Shared converted/cutoff entries leave legacy totals atomically; uploaded unassigned
            entries remain in their staged snapshot.
          </p>
        </details>
        <textarea
          aria-label="Legacy mapping decisions"
          className="field min-h-32 w-full font-mono text-xs"
          value={legacyDecisions}
          onChange={(e) => setLegacyDecisions(e.target.value)}
        />
        <button
          className="btn btn-primary"
          disabled={locked || !batchId}
          onClick={() =>
            attempt(() =>
              prepare(
                "tally_prepare_legacy_migration",
                { batchId, decisions: parse(legacyDecisions) },
                "tally_commit_legacy_migration",
              ),
            )
          }
        >
          Preview legacy conversion
        </button>
      </section>
      {preview && (
        <section className="panel space-y-3">
          <h2 className="text-xl font-semibold">Frozen change review</h2>
          <p className="text-sm">
            {currency} · revision {preview.revision} · exact plan {preview.planId}
          </p>
          <ReviewDetails value={preview.review} currency={currency} />
          {preview.revision !== revision && (
            <p className="text-expense">
              The ledger changed. Cancel this plan and prepare a fresh preview.
            </p>
          )}
          {preview.approvalRequired !== false && (
            <>
              <button
                className="btn btn-quiet"
                disabled={locked || !!approvalId || preview.revision !== revision}
                onClick={() =>
                  void run("tally_request_approval", { currency, planId: preview.planId }, (v) =>
                    setApprovalId(v.approvalId),
                  )
                }
              >
                Request review
              </button>
              <button
                className="btn btn-quiet ml-2"
                disabled={locked || !approvalId || approved || preview.revision !== revision}
                onClick={() => void review()}
              >
                Approve displayed changes
              </button>
            </>
          )}
          <button
            className="btn btn-primary ml-2"
            disabled={
              locked ||
              (preview.approvalRequired !== false && !approved) ||
              preview.revision !== revision
            }
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
                  setRows([]);
                  setCoverage(null);
                  setLegacy(null);
                },
              )
            }
          >
            Commit displayed changes
          </button>
          <button
            className="btn btn-quiet ml-2"
            disabled={locked}
            onClick={() =>
              void run("tally_cancel_operation", { currency, operationId: preview.planId }, () =>
                setPreview(null),
              )
            }
          >
            Cancel plan
          </button>
        </section>
      )}
      {error && (
        <p role="alert" className="panel text-expense">
          {error}
        </p>
      )}
    </div>
  );
}
