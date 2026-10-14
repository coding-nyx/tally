import { createHash, randomUUID } from "node:crypto";
import {
  accountBalance,
  applyAccountingChange,
  liability,
  prepareEvent,
  AccountingError,
  type Account,
  type AccountingLedger,
  type JournalEvent,
} from "./accounting.ts";
import { buildStatementPreview, type CsvTable, type StatementMapping } from "./bank-statement.ts";
import type { BudgetData, Currency, Transaction } from "./budget.ts";

export type SourceFile = {
  id: string;
  currency: Currency;
  name: string;
  mime: string;
  sha256: string;
  bytes: string;
  createdAt: number;
};
export type Statement = {
  id: string;
  currency: Currency;
  accountId: string;
  sourceFileId: string;
  previousId?: string;
  periodFrom: string;
  periodTo: string;
  openingMinor?: number;
  closingMinor?: number;
  closingTiming: "start_of_day" | "end_of_day";
  parser: string;
  table: CsvTable;
  mapping?: StatementMapping & { referenceColumn: number | null };
  reason?: string;
  createdAt: number;
};
export type Observation = {
  id: string;
  currency: Currency;
  statementId: string;
  accountId: string;
  sourceIdentity: string;
  rowNumber: number;
  values: string[];
  date?: string;
  movementMinor?: number;
  description: string;
  providerReference?: string;
  error?: string;
  signature: string;
};
export type SourceDecision = {
  id: string;
  currency: Currency;
  observationId: string;
  accountId: string;
  eventId?: string;
  disposition: "linked" | "excluded";
  reason: string;
  createdAt: number;
};
export type Reconciliation = {
  id: string;
  currency: Currency;
  statementId: string;
  accountId: string;
  asOf: string;
  observedMinor: number | null;
  computedMinor: number | null;
  differenceMinor: number | null;
  status: "matched" | "discrepancy" | "incomplete";
  unresolvedObservationIds: string[];
  excludedObservationIds: string[];
  unobservedEventIds: string[];
  reasons: string[];
  createdAt: number;
  revision: number;
};
export type MigrationBatch = {
  id: string;
  currency: Currency;
  sourceFileId?: string;
  origin: "shared" | "uploaded";
  snapshot: BudgetData;
  sha256: string;
  createdAt: number;
};
export type LegacyDecision = {
  id: string;
  currency: Currency;
  batchId: string;
  legacyId: string;
  previousId?: string;
  eventId?: string;
  accountId?: string;
  disposition: "converted" | "cutoff" | "unassigned";
  reason: string;
  createdAt: number;
};
export type StatementLedger = {
  files: SourceFile[];
  statements: Statement[];
  observations: Observation[];
  decisions: SourceDecision[];
  reconciliations: Reconciliation[];
  migrations: MigrationBatch[];
  legacyDecisions: LegacyDecision[];
};
export type StatementChange = {
  events: JournalEvent[];
  decisions: SourceDecision[];
  reconciliations: Reconciliation[];
  legacyDecisions: LegacyDecision[];
  removeLegacyIds: string[];
};
export function emptyStatements(): StatementLedger {
  return {
    files: [],
    statements: [],
    observations: [],
    decisions: [],
    reconciliations: [],
    migrations: [],
    legacyDecisions: [],
  };
}
function reject(message: string): never {
  throw new AccountingError("invalid_statement", message);
}
export function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function sumMinor(values: number[]) {
  const sum = values.reduce((s, v) => {
    if (!Number.isSafeInteger(v)) reject("Unsafe minor-unit amount.");
    return s + BigInt(v);
  }, 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER))
    reject("Amount total exceeds integer precision.");
  return Number(sum);
}
function account(ledger: AccountingLedger, id: string) {
  return ledger.accounts.find((a) => a.id === id) ?? reject("Account not found in this ledger.");
}
export function movement(event: JournalEvent, a: Account) {
  return sumMinor(
    event.postings
      .filter((p) => p.accountId === a.id)
      .map((p) => p.amountMinor * (p.side === (liability(a) ? "credit" : "debit") ? 1 : -1)),
  );
}
function latest(s: StatementLedger, id: string) {
  const statement = s.statements.find((v) => v.id === id) ?? reject("Statement not found.");
  if (s.statements.some((v) => v.previousId === id))
    reject("This statement revision was superseded.");
  return statement;
}
export function currentStatements(s: StatementLedger) {
  return s.statements.filter((v) => !s.statements.some((r) => r.previousId === v.id));
}
export function durableSource(
  s: StatementLedger,
  currency: Currency,
  file: { name: string; mime: string; bytes: string },
): SourceFile {
  const bytes = Buffer.from(file.bytes, "base64"),
    sha256 = digest(bytes);
  const existing = s.files.find((f) => f.currency === currency && f.sha256 === sha256);
  if (existing) return existing;
  if (
    s.files.length >= 100 ||
    sumMinor(s.files.map((f) => Buffer.byteLength(f.bytes, "base64"))) + bytes.length > 40 * 1048576
  )
    reject("Persistent evidence quota reached (100 files / 40 MB per currency).");
  const source = {
    id: randomUUID(),
    currency,
    name: file.name,
    mime: file.mime,
    sha256,
    bytes: file.bytes,
    createdAt: Date.now(),
  };
  s.files.push(source);
  return source;
}
export function stageStatement(
  s: StatementLedger,
  ledger: AccountingLedger,
  currency: Currency,
  source: SourceFile,
  table: CsvTable,
  args: any,
) {
  const a = account(ledger, args.accountId);
  if (a.archived) reject("Choose an active account.");
  if (args.periodFrom > args.periodTo) reject("Statement period is reversed.");
  if (table.rows.length > 1000) reject("Phase B supports at most 1,000 rows per statement.");
  const existing = s.statements.find(
    (v) => v.accountId === a.id && v.sourceFileId === source.id && !v.previousId,
  );
  if (existing) {
    const old =
      currentStatements(s).find((v) => v.id === existing.id) ??
      s.statements.find((v) => v.previousId === existing.id)!;
    if (
      ["periodFrom", "periodTo", "openingMinor", "closingMinor", "closingTiming"].some(
        (k) => (existing as any)[k] !== args[k],
      )
    )
      reject("The same account/file has different metadata. Revise its statement explicitly.");
    let current = old;
    while (s.statements.some((v) => v.previousId === current.id))
      current = s.statements.find((v) => v.previousId === current.id)!;
    return current;
  }
  if (s.statements.length >= 200) reject("Statement revision quota reached.");
  const statement: Statement = {
    id: randomUUID(),
    currency,
    accountId: a.id,
    sourceFileId: source.id,
    table: structuredClone(table),
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    ...(args.openingMinor !== undefined ? { openingMinor: args.openingMinor } : {}),
    ...(args.closingMinor !== undefined ? { closingMinor: args.closingMinor } : {}),
    closingTiming: args.closingTiming,
    parser: source.mime === "application/pdf" ? "tally-text-pdf/1" : "tally-csv/1",
    createdAt: Date.now(),
  };
  s.statements.push(statement);
  return statement;
}
export function reviseStatement(s: StatementLedger, ledger: AccountingLedger, args: any) {
  const old = latest(s, args.statementId);
  const a = account(ledger, old.accountId);
  if (s.statements.length >= 200) reject("Statement revision quota reached.");
  const table = structuredClone(old.table);
  for (const change of args.corrections ?? []) {
    const row =
      table.rows.find((r) => r.rowNumber === change.rowNumber) ??
      reject("Correction row not found.");
    if (change.values.length !== table.headers.length)
      reject("Corrected row width must match the header.");
    row.values = change.values;
    delete row.parseError;
  }
  const next: Statement = {
    ...structuredClone(old),
    id: randomUUID(),
    previousId: old.id,
    table,
    mapping: args.mapping,
    reason: args.reason,
    createdAt: Date.now(),
    ...(args.metadata ?? {}),
  };
  if (next.periodFrom > next.periodTo) reject("Statement period is reversed.");
  const ref = next.mapping!.referenceColumn;
  if (ref !== null && ref >= table.headers.length) reject("Reference column is outside the table.");
  const parsed = buildStatementPreview({
    table,
    mapping: next.mapping!,
    currency: old.currency,
    existing: [],
  });
  const source = s.files.find((f) => f.id === old.sourceFileId)!;
  const observations: Observation[] = parsed.map((row) => {
    const tx = row.transaction,
      description =
        next.mapping!.descriptionColumn === null
          ? ""
          : (row.values[next.mapping!.descriptionColumn] ?? "");
    const movementMinor = tx
      ? tx.amountCents * (tx.kind === "income" ? 1 : -1) * (liability(a) ? -1 : 1)
      : undefined;
    const error =
      row.error ??
      (tx && (tx.date < next.periodFrom || tx.date > next.periodTo)
        ? "Booking date is outside the statement period."
        : undefined);
    const signature = digest(JSON.stringify({ date: tx?.date, movementMinor, values: row.values }));
    return {
      id: randomUUID(),
      currency: old.currency,
      statementId: next.id,
      accountId: a.id,
      sourceIdentity: digest(`${a.id}:${source.sha256}:${row.rowNumber}`),
      rowNumber: row.rowNumber,
      values: row.values,
      description,
      ...(tx ? { date: tx.date, movementMinor } : {}),
      ...(ref !== null && row.values[ref]?.trim()
        ? { providerReference: row.values[ref].trim() }
        : {}),
      ...(error ? { error } : {}),
      signature,
    };
  });
  for (const prior of s.observations.filter((o) => o.statementId === old.id)) {
    const decision = reviewedSource(s, prior);
    if (
      decision?.disposition === "linked" &&
      !observations.some((o) => o.rowNumber === prior.rowNumber && o.signature === prior.signature)
    )
      reject(
        "A linked source row cannot be reclassified by changing its evidence. Retain the original and prepare a journal correction separately.",
      );
  }
  if (s.observations.length + observations.length > 10000) reject("Observation quota reached.");
  s.statements.push(next);
  s.observations.push(...observations);
  return next;
}
export function observationsFor(s: StatementLedger, statementId: string) {
  latest(s, statementId);
  return s.observations.filter((o) => o.statementId === statementId);
}
export function reviewedSource(s: StatementLedger, o: Observation) {
  const exact = s.decisions.find((d) => d.observationId === o.id);
  if (exact) return exact;
  const replay = s.observations.filter(
    (r) => r.sourceIdentity === o.sourceIdentity && r.signature === o.signature,
  );
  return s.decisions.find((d) => replay.some((r) => r.id === d.observationId));
}
export function matchCandidates(s: StatementLedger, ledger: AccountingLedger, statementId: string) {
  return observationsFor(s, statementId).map((o) => ({
    observation: o,
    decision: reviewedSource(s, o) ?? null,
    candidates: o.error
      ? []
      : ledger.events
          .filter(
            (e) =>
              e.kind !== "opening" &&
              e.kind !== "opening_correction" &&
              movement(e, account(ledger, o.accountId)) === o.movementMinor,
          )
          .filter((e) => {
            const ref = s.decisions.some(
              (d) =>
                d.eventId === e.id &&
                s.observations.some(
                  (r) =>
                    r.id === d.observationId &&
                    r.accountId === o.accountId &&
                    o.providerReference &&
                    r.providerReference === o.providerReference,
                ),
            );
            return ref || Math.abs(Date.parse(e.date) - Date.parse(o.date!)) <= 7 * 86400000;
          })
          .map((e) => ({
            eventId: e.id,
            canonicalDate: e.date,
            kind: e.kind,
            reason:
              "Same account movement with nearby booking date or reviewed provider reference; human decision required.",
          })),
    referenceConflicts: o.providerReference
      ? s.observations
          .filter(
            (r) =>
              r.id !== o.id &&
              r.accountId === o.accountId &&
              r.providerReference === o.providerReference &&
              r.signature !== o.signature,
          )
          .map((r) => r.id)
      : [],
  }));
}
export function previewStatementChange(
  s: StatementLedger,
  ledger: AccountingLedger,
  currency: Currency,
  args: any,
  categories: any[],
  actorId: string,
): StatementChange {
  const change: StatementChange = {
    events: [],
    decisions: [],
    reconciliations: [],
    legacyDecisions: [],
    removeLegacyIds: [],
  };
  const after = structuredClone(ledger);
  const selected = args.statementIds.map((id: string) => latest(s, id));
  if (new Set(args.statementIds).size !== args.statementIds.length)
    reject("Select each statement once.");
  const rows: Observation[] = selected.flatMap((v: Statement) => observationsFor(s, v.id));
  if (selected.some((v: Statement) => !v.mapping)) reject("Map every statement before preview.");
  const used = new Set<string>();
  const choose = (ids: string[]) =>
    ids.map((id) => {
      if (used.has(id)) reject("A row may have only one reviewed decision.");
      const o =
        rows.find((r) => r.id === id) ??
        reject("Observation is outside the selected latest statements.");
      if (reviewedSource(s, o))
        reject("This observation is already reviewed; it cannot create another event.");
      used.add(id);
      return o;
    });
  for (const decision of args.decisions) {
    const observations = choose(decision.observationIds);
    let event: JournalEvent | undefined;
    if (decision.action === "create") {
      if (observations.some((o) => o.error)) reject("Correct erroneous rows before posting.");
      event = prepareEvent(after, currency, { event: decision.event }, categories, actorId).event!;
      applyAccountingChange(after, { event }, categories);
      change.events.push(event);
    } else if (decision.action === "link")
      event =
        after.events.find((e) => e.id === decision.eventId) ?? reject("Matched event not found.");
    if (event) {
      if (
        ["opening", "opening_correction", "reversal"].includes(event.kind) ||
        after.events.some((e) => e.kind === "reversal" && e.relatedEventId === event!.id)
      )
        reject("Choose an unreversed ordinary journal event.");
      if (new Set(observations.map((o) => o.accountId)).size !== observations.length)
        reject(
          "Link one observation per account to an event; repeated legitimate rows need separate events or explicit exclusion.",
        );
      for (const o of observations) {
        if (o.error || !o.date || o.movementMinor === undefined)
          reject("Correct erroneous source rows before matching.");
        if (movement(event, account(ledger, o.accountId)) !== o.movementMinor)
          reject("Source account movement must match its journal exactly.");
      }
    }
    for (const o of observations)
      change.decisions.push({
        id: randomUUID(),
        currency,
        accountId: o.accountId,
        observationId: o.id,
        ...(event ? { eventId: event.id } : {}),
        disposition: event ? "linked" : "excluded",
        reason: decision.reason,
        createdAt: Date.now(),
      });
  }
  const unresolved = rows.filter((o) => !reviewedSource(s, o) && !used.has(o.id));
  if (unresolved.length)
    reject(
      `Review every row before committing (${unresolved.length} unresolved). Use explicit exclusion with a reason when necessary.`,
    );
  return change;
}
export function reconciliation(
  s: StatementLedger,
  ledger: AccountingLedger,
  statementId: string,
  revision: number,
): Reconciliation {
  const st = latest(s, statementId),
    rows = observationsFor(s, st.id),
    a = account(ledger, st.accountId);
  const balance = accountBalance(ledger, a.id, st.periodTo);
  const startBalance = (date: string) =>
    !a.opening ||
    a.opening.date > date ||
    (a.opening.date === date && a.opening.timing === "end_of_day")
      ? null
      : sumMinor(
          ledger.events
            .filter(
              (e) =>
                e.date < date ||
                (e.date === date && e.kind === "opening" && a.opening?.timing === "start_of_day"),
            )
            .map((e) => movement(e, a)),
        );
  const computed =
    st.closingTiming === "end_of_day" ? balance.balanceMinor : startBalance(st.periodTo);
  const unresolvedObservationIds = rows.filter((o) => !reviewedSource(s, o)).map((o) => o.id),
    excludedObservationIds = rows
      .filter((o) => reviewedSource(s, o)?.disposition === "excluded")
      .map((o) => o.id);
  const observedEvents = new Set(rows.map((o) => reviewedSource(s, o)?.eventId).filter(Boolean));
  const unobservedEventIds = ledger.events
    .filter(
      (e) =>
        e.date >= st.periodFrom &&
        (st.closingTiming === "end_of_day" ? e.date <= st.periodTo : e.date < st.periodTo) &&
        !["opening", "opening_correction"].includes(e.kind) &&
        movement(e, a) !== 0 &&
        !observedEvents.has(e.id),
    )
    .map((e) => e.id);
  const reasons: string[] = [];
  if (!st.mapping) reasons.push("Statement mapping is missing.");
  if (computed === null) reasons.push("Opening balance is unknown at the closing cutoff.");
  if (st.closingMinor === undefined) reasons.push("Closing balance was not supplied.");
  if (unresolvedObservationIds.length) reasons.push("Source rows remain unresolved.");
  if (unobservedEventIds.length)
    reasons.push("Recorded period events are missing from this statement’s reviewed observations.");
  if (excludedObservationIds.length)
    reasons.push("Excluded source rows require investigation; agreement alone is insufficient.");
  if (st.openingMinor !== undefined) {
    const before = startBalance(st.periodFrom);
    if (before === null) reasons.push("Statement opening cannot be checked at this cutoff.");
    else if (before !== st.openingMinor)
      reasons.push(
        `Statement opening differs by ${sumMinor([st.openingMinor, -before])} minor units.`,
      );
  }
  const differenceMinor =
    st.closingMinor !== undefined && computed !== null
      ? sumMinor([st.closingMinor, -computed])
      : null;
  return {
    id: randomUUID(),
    currency: st.currency,
    statementId: st.id,
    accountId: a.id,
    asOf: st.periodTo,
    observedMinor: st.closingMinor ?? null,
    computedMinor: computed,
    differenceMinor,
    status:
      differenceMinor !== null && differenceMinor !== 0
        ? "discrepancy"
        : reasons.length
          ? "incomplete"
          : "matched",
    unresolvedObservationIds,
    excludedObservationIds,
    unobservedEventIds,
    reasons,
    createdAt: Date.now(),
    revision,
  };
}
export function coverage(
  s: StatementLedger,
  ledger: AccountingLedger,
  accountId: string,
  from: string,
  to: string,
  revision: number,
) {
  account(ledger, accountId);
  if (from > to) reject("Coverage period is reversed.");
  const statements = currentStatements(s)
    .filter((v) => v.accountId === accountId && v.periodFrom <= to && v.periodTo >= from)
    .sort((a, b) => a.periodFrom.localeCompare(b.periodFrom));
  const gaps: Array<{ from: string; to: string }> = [],
    overlaps: string[] = [];
  let cursor = from;
  const shift = (date: string, n: number) =>
    new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);
  for (const st of statements) {
    if (st.periodFrom > cursor) gaps.push({ from: cursor, to: shift(st.periodFrom, -1) });
    if (st.periodFrom < cursor) overlaps.push(st.id);
    if (st.periodTo >= cursor) cursor = st.periodTo === "9999-12-31" ? "~" : shift(st.periodTo, 1);
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return {
    accountId,
    from,
    to,
    revision,
    gaps,
    overlappingStatementIds: overlaps,
    statements: statements.map((st) => ({
      statementId: st.id,
      periodFrom: st.periodFrom,
      periodTo: st.periodTo,
      closingTiming: st.closingTiming,
      reconciliation: reconciliation(s, ledger, st.id, revision),
    })),
    freshness: "Uploaded statement evidence at explicit dates; no live bank connection.",
  };
}
export function stageMigration(
  s: StatementLedger,
  currency: Currency,
  snapshot: BudgetData,
  origin: MigrationBatch["origin"],
  sourceFileId?: string,
) {
  if (snapshot.currency !== currency)
    reject("Legacy backup currency differs from the selected ledger.");
  if (!Array.isArray(snapshot.transactions) || snapshot.transactions.length > 1000)
    reject("Stage at most 1,000 legacy entries in a batch.");
  if (new Set(snapshot.transactions.map((t) => t.id)).size !== snapshot.transactions.length)
    reject("Legacy ids must be unique.");
  const sha256 = digest(JSON.stringify(snapshot));
  const old = s.migrations.find((b) => b.sha256 === sha256 && b.origin === origin);
  if (old) return old;
  if (s.migrations.length >= 30) reject("Migration batch quota reached.");
  const batch = {
    id: randomUUID(),
    currency,
    snapshot: structuredClone(snapshot),
    sha256,
    origin,
    ...(sourceFileId ? { sourceFileId } : {}),
    createdAt: Date.now(),
  };
  s.migrations.push(batch);
  return batch;
}
export function legacyDecisionFor(s: StatementLedger, batchId: string, legacyId: string) {
  return s.legacyDecisions.find(
    (d) =>
      d.batchId === batchId &&
      d.legacyId === legacyId &&
      !s.legacyDecisions.some((n) => n.previousId === d.id),
  );
}
export function previewMigration(
  s: StatementLedger,
  ledger: AccountingLedger,
  current: BudgetData,
  currency: Currency,
  args: any,
  categories: any[],
  actorId: string,
): StatementChange {
  const batch =
    s.migrations.find((b) => b.id === args.batchId) ?? reject("Migration batch not found.");
  if (batch.origin === "shared") {
    const pending = batch.snapshot.transactions.filter(
      (row) =>
        !legacyDecisionFor(s, batch.id, row.id) ||
        legacyDecisionFor(s, batch.id, row.id)!.disposition === "unassigned",
    );
    if (
      pending.some(
        (row) =>
          JSON.stringify(current.transactions.find((t) => t.id === row.id)) !== JSON.stringify(row),
      )
    )
      reject("Shared legacy entries changed since staging. Stage a new snapshot.");
    if (
      !s.legacyDecisions.some((d) => d.batchId === batch.id) &&
      digest(JSON.stringify(current)) !== batch.sha256
    )
      reject("Shared legacy data changed since staging. Stage a new snapshot.");
  }
  const change: StatementChange = {
      events: [],
      decisions: [],
      reconciliations: [],
      legacyDecisions: [],
      removeLegacyIds: [],
    },
    after = structuredClone(ledger),
    used = new Set<string>();
  for (const d of args.decisions) {
    const rows: Transaction[] = d.legacyIds.map((id: string) => {
      if (
        used.has(id) ||
        (legacyDecisionFor(s, batch.id, id) &&
          legacyDecisionFor(s, batch.id, id)!.disposition !== "unassigned")
      )
        reject("Legacy entry is already converted or cutoff-excluded.");
      const row =
        batch.snapshot.transactions.find((t) => t.id === id) ?? reject("Legacy entry not found.");
      used.add(id);
      return row;
    });
    let event: JournalEvent | undefined;
    if (d.action === "convert") {
      if (
        rows.some((row) =>
          s.legacyDecisions.some((v) => v.disposition === "converted" && v.legacyId === row.id),
        )
      )
        reject("This original legacy id was already converted in another batch.");
      event = prepareEvent(after, currency, { event: d.event }, categories, actorId).event!;
      const sourceTotal = sumMinor(rows.map((r) => r.amountCents));
      const roleTotal = sumMinor(
        event.postings
          .filter((p) => p.role === "income" || p.role === "expense")
          .map((p) => p.amountMinor),
      );
      const moved = Math.max(
        ...event.postings.filter((p) => p.accountId).map((p) => p.amountMinor),
        0,
      );
      if (sourceTotal !== roleTotal && sourceTotal !== moved)
        reject(
          "Converted source total must match the journal component or account movement exactly.",
        );
      if (rows.some((r) => r.date !== event!.date))
        reject("Preserve legacy booking dates; convert separate dates separately.");
      applyAccountingChange(after, { event }, categories);
      change.events.push(event);
    } else if (d.action === "cutoff") {
      const a = account(ledger, d.accountId);
      if (!a.opening) reject("Cutoff exclusion requires an explicitly reviewed opening.");
      if (
        rows.some(
          (r) =>
            r.date > a.opening!.date ||
            (r.date === a.opening!.date && a.opening!.timing === "start_of_day"),
        )
      )
        reject("These entries are after the opening cutoff; do not exclude future movements.");
    }
    for (const row of rows) {
      change.legacyDecisions.push({
        id: randomUUID(),
        currency,
        batchId: batch.id,
        legacyId: row.id,
        ...(legacyDecisionFor(s, batch.id, row.id)
          ? { previousId: legacyDecisionFor(s, batch.id, row.id)!.id }
          : {}),
        ...(event ? { eventId: event.id } : {}),
        ...(d.accountId ? { accountId: d.accountId } : {}),
        disposition:
          d.action === "convert" ? "converted" : d.action === "cutoff" ? "cutoff" : "unassigned",
        reason: d.reason,
        createdAt: Date.now(),
      });
      if (batch.origin === "shared" && d.action !== "unassigned")
        change.removeLegacyIds.push(row.id);
    }
  }
  if (
    batch.snapshot.transactions.some(
      (row) =>
        !used.has(row.id) &&
        !s.legacyDecisions.some((d) => d.batchId === batch.id && d.legacyId === row.id),
    )
  )
    reject("Decide every legacy entry, including explicit unassigned entries, before cutover.");
  return change;
}
export function applyStatementChange(
  s: StatementLedger,
  ledger: AccountingLedger,
  data: BudgetData,
  change: StatementChange,
  categories: any[],
) {
  if (
    s.decisions.length + change.decisions.length > 10000 ||
    s.legacyDecisions.length + change.legacyDecisions.length > 10000 ||
    s.reconciliations.length + change.reconciliations.length > 2000
  )
    reject("Phase B reviewed evidence quota reached.");
  for (const event of change.events) applyAccountingChange(ledger, { event }, categories);
  for (const decision of change.decisions) {
    const o =
      s.observations.find((v) => v.id === decision.observationId) ??
      reject("Source observation vanished.");
    latest(s, o.statementId);
    if (reviewedSource(s, o)) reject("Source observation already decided.");
    s.decisions.push(structuredClone(decision));
  }
  for (const decision of change.legacyDecisions) {
    const previous = legacyDecisionFor(s, decision.batchId, decision.legacyId);
    if (previous?.id !== decision.previousId || (previous && previous.disposition !== "unassigned"))
      reject("Legacy mapping was already changed.");
    s.legacyDecisions.push(structuredClone(decision));
  }
  s.reconciliations.push(...structuredClone(change.reconciliations));
  const removed = new Set(change.removeLegacyIds);
  data.transactions = data.transactions.filter((t) => !removed.has(t.id));
  data.sample = data.transactions.some((t) => t.sample);
}
