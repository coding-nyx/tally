import { createHash, randomUUID } from "node:crypto";
import { catalog, requestSchema, transaction, amount, month as monthSchema } from "./catalog.ts";
import type {
  WorkspaceStore,
  Workspace,
  Principal,
  Ledger,
  Plan,
  PrivateFile,
  Receipt,
  UndoDelta,
} from "./store.ts";
import {
  buildStatementPreview,
  parseStatementCsv,
  transactionsToCsv,
  suggestStatementMapping,
} from "../bank-statement.ts";
import type { StatementPreviewRow } from "../bank-statement.ts";
import { settingsForMonth, budgetStatus, type Currency, type Transaction } from "../budget.ts";
import {
  buildSpendingSummary,
  spendingChatConfig,
  validateSpendingChatRequest,
} from "../ai/spending-chat.ts";
import { answerSpendingQuestion } from "../ai/spending-chat.server.ts";
import { createTransactionReportPdf } from "../transaction-report-pdf.ts";

export class ToolError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.status = status;
  }
}
export type ToolResult =
  | { ok: true; result: Record<string, unknown>; replayed?: boolean }
  | { ok: false; error: { code: string; message: string } };
function fail(code: string, message: string, status = 400): never {
  throw new ToolError(code, message, status);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function hash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function publicTx(tx: Transaction) {
  const { amountCents, ...rest } = tx;
  return { ...rest, amountMinor: amountCents };
}
function assertPrincipal(p: Principal, scope: string, currency?: Currency) {
  if (p.expiresAt <= Date.now()) fail("unauthorized", "The access grant has expired.", 401);
  if (!p.scopes.includes(scope))
    fail("forbidden", `This access grant does not allow ${scope}.`, 403);
  if (currency && !p.currencies.includes(currency))
    fail("forbidden", "This currency is outside the access grant.", 403);
}
function checkedCategory(ledger: Ledger, kind: string, name: string, allowArchived = false) {
  const cat = ledger.categories.find((c) => c.kind === kind && c.name === name);
  if (!cat || (cat.archived && !allowArchived))
    fail("invalid_category", "Choose an active category of the same transaction kind.");
  return cat;
}
function validateLedger(ledger: Ledger) {
  if (ledger.data.transactions.length > 100_000)
    fail("quota", "The ledger is over the 100,000-entry limit.");
  const ids = new Set<string>();
  let total = 0;
  for (const tx of ledger.data.transactions) {
    if (!tx.id || tx.id.length > 128 || ids.has(tx.id))
      fail("invalid_ledger", "Transaction ids must be unique.");
    ids.add(tx.id);
    transaction.parse(publicTxInput(tx));
    if (!Number.isSafeInteger(tx.createdAt) || tx.createdAt < 0 || typeof tx.sample !== "boolean")
      fail("invalid_ledger", "Invalid transaction metadata.");
    checkedCategory(ledger, tx.kind, tx.category, true);
    total += tx.amountCents;
    if (!Number.isSafeInteger(total))
      fail("invalid_ledger", "The combined ledger amount exceeds safe integer precision.");
  }
  for (const [key, setting] of Object.entries(ledger.data.settingsByMonth)) {
    monthSchema.parse(key);
    if (typeof setting.goalName !== "string" || setting.goalName.length > 40)
      fail("invalid_ledger", "Invalid savings goal name.");
    amount.parse(setting.goalTargetCents);
    for (const [category, limit] of Object.entries(setting.categoryBudgets)) {
      checkedCategory(ledger, "expense", category, true);
      amount.parse(limit);
    }
  }
}
function publicTxInput(tx: Transaction) {
  return {
    kind: tx.kind,
    date: tx.date,
    category: tx.category,
    note: tx.note,
    amountMinor: tx.amountCents,
  };
}
function requireRevision(ledger: Ledger, expected: number) {
  if (expected !== ledger.revision)
    fail("revision_conflict", "Refresh the ledger revision and prepare the change again.", 409);
}
function findTx(ledger: Ledger, id: string) {
  return (
    ledger.data.transactions.find((t) => t.id === id) ??
    fail("not_found", "Transaction not found.", 404)
  );
}
function applyChange(ledger: Ledger, change: any) {
  if (change.action === "create") {
    const parsed = transaction.parse(change.transaction);
    checkedCategory(ledger, parsed.kind, parsed.category);
    ledger.data.transactions.push({
      id: randomUUID(),
      kind: parsed.kind,
      amountCents: parsed.amountMinor,
      category: parsed.category,
      note: parsed.note,
      date: parsed.date,
      createdAt: Date.now(),
      sample: false,
    });
  } else if (change.action === "update") {
    const tx = findTx(ledger, change.transactionId);
    const next = transaction.parse({ ...publicTxInput(tx), ...change.patch });
    // An archived category can remain on a historical entry, but cannot be newly selected.
    checkedCategory(
      ledger,
      next.kind,
      next.category,
      next.category === tx.category && next.kind === tx.kind,
    );
    Object.assign(tx, {
      kind: next.kind,
      amountCents: next.amountMinor,
      category: next.category,
      note: next.note,
      date: next.date,
    });
  } else {
    findTx(ledger, change.transactionId);
    ledger.data.transactions = ledger.data.transactions.filter(
      (t) => t.id !== change.transactionId,
    );
  }
  ledger.data.sample = ledger.data.transactions.some((t) => t.sample);
}
function paginate<T>(items: T[], args: any, binding: unknown) {
  const fingerprint = hash(binding);
  let offset = 0;
  if (args.cursor) {
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(args.cursor, "base64url").toString());
    } catch {
      fail("invalid_cursor", "Invalid cursor.");
    }
    if (parsed.fingerprint !== fingerprint)
      fail("stale_cursor", "The query or ledger changed. Start again without a cursor.", 409);
    if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
      fail("invalid_cursor", "Invalid cursor.");
    offset = parsed.offset;
  }
  const next = offset + args.limit;
  return {
    items: items.slice(offset, next),
    nextCursor:
      next < items.length
        ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString("base64url")
        : null,
    total: items.length,
  };
}
function owned<T extends { actorId: string; currency: Currency; expiresAt?: number }>(
  item: T | undefined,
  p: Principal,
  currency: Currency,
): T {
  if (!item || item.actorId !== p.actorId || item.currency !== currency)
    fail("not_found", "Handle not found.", 404);
  if (item.expiresAt !== undefined && item.expiresAt <= Date.now())
    fail("expired", "This handle has expired. Prepare a new operation.", 410);
  return item;
}
function cleanup(w: Workspace) {
  const now = Date.now();
  for (const [id, f] of Object.entries(w.files)) if (f.expiresAt <= now) delete w.files[id];
  for (const [id, d] of Object.entries(w.imports)) if (d.expiresAt <= now) delete w.imports[id];
  for (const [id, p] of Object.entries(w.plans))
    if (p.expiresAt <= now && p.status !== "committed") {
      delete w.plans[id];
      for (const [aid, a] of Object.entries(w.approvals))
        if (a.planId === id) delete w.approvals[aid];
    }
}

export class AgentToolService {
  private instance = randomUUID();
  private controllers = new Map<string, AbortController>();
  store: WorkspaceStore;
  private environment: Record<string, string | undefined>;
  private provider: typeof answerSpendingQuestion;
  constructor(
    store: WorkspaceStore,
    environment: Record<string, string | undefined> = {},
    provider = answerSpendingQuestion,
  ) {
    this.store = store;
    this.environment = environment;
    this.provider = provider;
  }
  async execute(p: Principal, input: unknown): Promise<ToolResult> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success)
      fail(
        "invalid_request",
        "Use version 2 with tool, args, and an idempotencyKey for mutations.",
      );
    const request = parsed.data;
    const definition = catalog[request.tool] ?? fail("unknown_tool", "Unknown Tally tool.", 404);
    const validation = definition.schema.safeParse(request.args);
    if (!validation.success)
      fail(
        "invalid_args",
        validation.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 1000),
      );
    const args: any = validation.data;
    assertPrincipal(p, definition.scope, args.currency);
    if (definition.effect !== "read" && !request.idempotencyKey)
      fail(
        "idempotency_required",
        "Supply an idempotencyKey and reuse it only for retries of this exact request.",
      );
    const fingerprint = hash({ tool: request.tool, args });
    const key = JSON.stringify([p.actorId, request.idempotencyKey]);
    let providerJob: { id: string; context: any; question: string } | undefined;
    let cancelJob: string | undefined;
    const response = await this.store.transaction(p.ownerId, async (w) => {
      cleanup(w);
      const prior = request.idempotencyKey ? w.receipts[key] : undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail("idempotency_conflict", "This key belongs to a different request.", 409);
        return { ok: true as const, result: structuredClone(prior.result), replayed: true };
      }
      if (definition.effect !== "read" && Object.keys(w.receipts).length >= 10_000)
        fail(
          "quota",
          "The workspace has reached its 10,000-operation receipt limit. Owner maintenance is required.",
        );
      const ledger = args.currency ? w.ledgers[args.currency as Currency] : undefined;
      if (ledger && args.expectedRevision !== undefined)
        requireRevision(ledger, args.expectedRevision);
      const before = ledger ? structuredClone(ledger) : undefined;
      let changed = false;
      let result: Record<string, unknown>;
      const plan = (
        operation: string,
        after: Ledger | undefined,
        review: unknown,
        extra: Partial<Plan> = {},
      ) => {
        if (Object.values(w.plans).filter((q) => q.status === "pending").length >= 30)
          fail("quota", "Cancel unused previews before preparing another.");
        const value: Plan = {
          id: randomUUID(),
          actorId: p.actorId,
          currency: args.currency,
          operation,
          revision: ledger!.revision,
          hash: hash({ operation, after, review, ...extra }),
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          status: "pending",
          before,
          after,
          review,
          ...extra,
        };
        w.plans[value.id] = value;
        return {
          operationId: value.id,
          planId: value.id,
          previewHash: value.hash,
          revision: value.revision,
          expiresAt: value.expiresAt,
          review: value.review,
          approvalRequired: true,
        };
      };
      const commit = (operation: string) => {
        const preview = owned(w.plans[args.planId], p, args.currency);
        if (preview.operation !== operation || preview.status !== "pending")
          fail("invalid_plan", "This preview cannot be committed.", 409);
        requireRevision(ledger!, preview.revision);
        if (preview.requiredScope) assertPrincipal(p, preview.requiredScope, args.currency);
        const approval = w.approvals[args.approvalId];
        if (
          !approval ||
          approval.actorId !== p.actorId ||
          approval.planId !== preview.id ||
          approval.hash !== preview.hash ||
          approval.expiresAt <= Date.now() ||
          approval.status !== "approved"
        )
          fail(
            "approval_required",
            "The owner must approve this exact preview through the trusted approval interface.",
            403,
          );
        if (!preview.after) fail("invalid_plan", "This preview has no ledger change.");
        if (preview.importId) {
          const draft = owned(w.imports[preview.importId], p, args.currency);
          if (draft.status !== "draft")
            fail("invalid_import", "This import cannot be committed.", 409);
          draft.status = "committed";
          draft.receiptId = preview.id;
        }
        if (operation === "restore") {
          const file = this.makeFile(
            w,
            p,
            args.currency,
            `tally-${args.currency}-before-restore.json`,
            "application/json",
            Buffer.from(this.backup(ledger!)),
          );
          result = { backupFileId: file.id };
        } else result = {};
        w.ledgers[args.currency as Currency] = structuredClone(preview.after);
        preview.status = "committed";
        preview.receiptId = preview.id;
        approval.status = "consumed";
        changed = true;
        return { ...result, operationId: preview.id, previewHash: preview.hash };
      };
      const settings = () => {
        const value = structuredClone(settingsForMonth(ledger!.data, args.month));
        ledger!.data.settingsByMonth[args.month] = value;
        return value;
      };
      const summary = () => this.summary(ledger!, args.month);
      switch (request.tool.slice(6)) {
        case "get_capabilities":
          result = {
            version: 2,
            tools: Object.entries(catalog)
              .filter(([, t]) => p.scopes.includes(t.scope))
              .map(([name, t]) => ({ name, scope: t.scope, effect: t.effect })),
            currencies: p.currencies,
            limits: {
              controlBytes: 16384,
              fileBytes: 10485760,
              statementRows: 20000,
              batchChanges: 100,
              pageSize: 100,
              receipts: 10000,
            },
            transports: ["private-rest", "stdio-mcp"],
            remoteMcpOAuth: false,
          };
          break;
        case "get_service_status":
          result = { state: "ready", persistence: "canonical", version: 2 };
          break;
        case "list_ledgers":
          result = {
            ledgers: p.currencies.map((currency) => ({
              currency,
              revision: w.ledgers[currency].revision,
              entryCount: w.ledgers[currency].data.transactions.length,
            })),
          };
          break;
        case "get_ledger":
          result = {
            currency: args.currency,
            revision: ledger!.revision,
            entryCount: ledger!.data.transactions.length,
          };
          break;
        case "list_months":
          result = {
            months: [
              ...new Set([
                ...ledger!.data.transactions.map((t) => t.date.slice(0, 7)),
                ...Object.keys(ledger!.data.settingsByMonth),
              ]),
            ].sort(),
          };
          break;
        case "list_categories":
          result = {
            categories: ledger!.categories.filter((v) => args.includeArchived || !v.archived),
            revision: ledger!.revision,
          };
          break;
        case "create_category": {
          if (
            ledger!.categories.some(
              (c) => c.name.toLocaleLowerCase("en-US") === args.name.toLocaleLowerCase("en-US"),
            )
          )
            fail("category_conflict", "A category with this name already exists.", 409);
          if (ledger!.categories.length >= 100)
            fail("quota", "A ledger can have at most 100 categories.");
          const category = {
            id: randomUUID(),
            name: args.name,
            kind: args.kind,
            archived: false,
            builtIn: false,
          };
          ledger!.categories.push(category);
          changed = true;
          result = { category };
          break;
        }
        case "update_category":
        case "archive_category":
        case "restore_category": {
          const category =
            ledger!.categories.find((c) => c.id === args.categoryId) ??
            fail("not_found", "Category not found.", 404);
          if (request.tool === "tally_update_category") {
            if (
              ledger!.categories.some(
                (c) =>
                  c.id !== category.id &&
                  c.name.toLocaleLowerCase("en-US") === args.name.toLocaleLowerCase("en-US"),
              )
            )
              fail("category_conflict", "A category with this name already exists.", 409);
            for (const tx of ledger!.data.transactions)
              if (tx.category === category.name && tx.kind === category.kind)
                tx.category = args.name;
            for (const value of Object.values(ledger!.data.settingsByMonth))
              if (Object.hasOwn(value.categoryBudgets, category.name)) {
                value.categoryBudgets[args.name] = value.categoryBudgets[category.name];
                delete value.categoryBudgets[category.name];
              }
            category.name = args.name;
          } else category.archived = request.tool === "tally_archive_category";
          changed = true;
          result = { category };
          break;
        }
        case "get_preferences":
          result = { ...w.preferences };
          break;
        case "update_preferences":
          w.preferences.currency = args.currency;
          result = { ...w.preferences };
          break;
        case "list_transactions":
          result = {
            ...paginate(
              ledger!.data.transactions
                .filter(
                  (t) =>
                    (!args.month || t.date.startsWith(args.month)) &&
                    (!args.kind || t.kind === args.kind),
                )
                .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
                .map(publicTx),
              args,
              {
                actor: p.actorId,
                currency: args.currency,
                month: args.month,
                kind: args.kind,
                revision: ledger!.revision,
              },
            ),
            revision: ledger!.revision,
          };
          break;
        case "get_transaction":
          result = {
            transaction: publicTx(findTx(ledger!, args.transactionId)),
            revision: ledger!.revision,
          };
          break;
        case "create_transaction":
          applyChange(ledger!, { action: "create", transaction: args.transaction });
          changed = true;
          result = { transaction: publicTx(ledger!.data.transactions.at(-1)!) };
          break;
        case "update_transaction":
          applyChange(ledger!, {
            action: "update",
            transactionId: args.transactionId,
            patch: args.patch,
          });
          changed = true;
          result = { transaction: publicTx(findTx(ledger!, args.transactionId)) };
          break;
        case "prepare_delete_transaction": {
          const after = structuredClone(ledger!);
          const tx = publicTx(findTx(after, args.transactionId));
          applyChange(after, { action: "delete", transactionId: args.transactionId });
          result = plan("delete", after, { transaction: tx });
          break;
        }
        case "delete_transaction":
          result = commit("delete");
          break;
        case "prepare_batch_changes": {
          const after = structuredClone(ledger!);
          for (const change of args.changes) applyChange(after, change);
          validateLedger(after);
          result = plan("batch", after, { changes: args.changes });
          break;
        }
        case "commit_batch_changes":
          result = commit("batch");
          break;
        case "get_month_settings":
          result = {
            settings: settingsForMonth(ledger!.data, args.month),
            revision: ledger!.revision,
          };
          break;
        case "get_savings_goal": {
          const s = settingsForMonth(ledger!.data, args.month);
          result = { name: s.goalName, targetMinor: s.goalTargetCents, revision: ledger!.revision };
          break;
        }
        case "set_savings_goal": {
          const s = settings();
          s.goalName = args.name;
          s.goalTargetCents = args.targetMinor;
          changed = true;
          result = { name: s.goalName, targetMinor: s.goalTargetCents };
          break;
        }
        case "get_category_budget": {
          checkedCategory(ledger!, "expense", args.category, true);
          result = {
            category: args.category,
            limitMinor:
              settingsForMonth(ledger!.data, args.month).categoryBudgets[args.category] ?? null,
            revision: ledger!.revision,
          };
          break;
        }
        case "set_category_budget":
        case "clear_category_budget": {
          checkedCategory(
            ledger!,
            "expense",
            args.category,
            request.tool === "tally_clear_category_budget",
          );
          const s = settings();
          if (request.tool === "tally_set_category_budget")
            s.categoryBudgets[args.category] = args.limitMinor;
          else delete s.categoryBudgets[args.category];
          changed = true;
          result = {
            category: args.category,
            limitMinor: s.categoryBudgets[args.category] ?? null,
          };
          break;
        }
        case "get_month_summary":
          result = summary();
          break;
        case "get_category_totals":
          result = {
            currency: args.currency,
            month: args.month,
            categories: summary().categories,
            revision: ledger!.revision,
          };
          break;
        case "get_budget_status":
          result = {
            ...summary(),
            statuses: ledger!.categories
              .filter((c) => c.kind === "expense")
              .map((c) => {
                const spent = ledger!.data.transactions
                  .filter(
                    (t) =>
                      t.kind === "expense" &&
                      t.category === c.name &&
                      t.date.startsWith(args.month),
                  )
                  .reduce((s, t) => s + t.amountCents, 0);
                const limit = settingsForMonth(ledger!.data, args.month).categoryBudgets[c.name];
                return {
                  category: c.name,
                  spentMinor: spent,
                  limitMinor: limit ?? null,
                  status: budgetStatus(spent, limit),
                };
              }),
          };
          break;
        case "stage_statement": {
          const file = owned(w.files[args.fileId], p, args.currency);
          const bytes = Buffer.from(file.bytes, "base64");
          let table;
          let warnings: string[] = [];
          if (file.mime === "application/pdf") {
            const { extractServerPdf } = await import("./pdf.server.ts");
            const extracted = await extractServerPdf(bytes);
            table = extracted.table;
            warnings = extracted.warnings;
          } else if (file.mime === "text/csv") table = parseStatementCsv(bytes.toString("utf8"));
          else fail("unsupported_file", "Stage a CSV or selectable-text PDF.");
          const draft = {
            id: randomUUID(),
            actorId: p.actorId,
            currency: args.currency,
            table,
            generation: 0,
            expiresAt: Date.now() + 86400000,
            status: "draft" as const,
            warnings,
          };
          w.imports[draft.id] = draft;
          result = {
            importId: draft.id,
            headers: table.headers,
            rowCount: table.rows.length,
            suggestedMapping: suggestStatementMapping(table.headers),
            warnings,
            expiresAt: draft.expiresAt,
          };
          break;
        }
        case "get_import": {
          const draft = owned(w.imports[args.importId], p, args.currency);
          result = {
            importId: draft.id,
            status: draft.status,
            headers: draft.table.headers,
            mapping: draft.mapping ?? null,
            generation: draft.generation,
            warnings: draft.warnings,
            ...paginate(draft.table.rows, args, {
              importId: draft.id,
              generation: draft.generation,
              actor: p.actorId,
            }),
          };
          break;
        }
        case "set_import_mapping":
        case "correct_import_rows": {
          const draft = owned(w.imports[args.importId], p, args.currency);
          if (draft.status !== "draft")
            fail("invalid_import", "This import is no longer editable.", 409);
          if (request.tool === "tally_set_import_mapping") {
            draft.mapping = args.mapping;
            this.importRows(draft, ledger!);
          } else
            for (const correction of args.corrections) {
              const row =
                draft.table.rows.find((r) => r.rowNumber === correction.rowNumber) ??
                fail("not_found", "Import row not found.");
              if (correction.values.length !== draft.table.headers.length)
                fail("invalid_row", "Corrected rows must have one cell per column.");
              row.values = correction.values;
              delete row.parseError;
            }
          draft.generation += 1;
          for (const v of Object.values(w.plans))
            if (v.importId === draft.id && v.status === "pending") v.status = "cancelled";
          result = { importId: draft.id, generation: draft.generation, reviewRequired: true };
          break;
        }
        case "preview_import": {
          const draft = owned(w.imports[args.importId], p, args.currency);
          if (draft.status !== "draft")
            fail("invalid_import", "This import is no longer editable.", 409);
          const rows = this.importRows(draft, ledger!);
          const invalid = rows.filter((r) => r.error || !r.transaction);
          const selected = rows.filter((r) => !r.error && r.transaction && !r.duplicate);
          const review = {
            importId: draft.id,
            generation: draft.generation,
            rowCount: rows.length,
            valid: selected.length,
            invalid: invalid.length,
            duplicates: rows.filter((r) => r.duplicate).length,
            errors: invalid.slice(0, 100).map((r) => ({ rowNumber: r.rowNumber, error: r.error })),
            correctionsRequired: invalid.length > 0,
          };
          if (invalid.length) {
            result = review;
            break;
          }
          if (!selected.length) fail("empty_import", "No nonduplicate entries remain to import.");
          const after = structuredClone(ledger!);
          for (const row of selected)
            applyChange(after, {
              action: "create",
              transaction: publicTxInput(row.transaction as Transaction),
            });
          validateLedger(after);
          result = plan("import", after, review, { importId: draft.id });
          break;
        }
        case "commit_import":
          result = commit("import");
          break;
        case "cancel_import": {
          const draft = owned(w.imports[args.importId], p, args.currency);
          if (draft.status !== "committed") {
            draft.status = "cancelled";
            for (const value of Object.values(w.plans))
              if (value.importId === draft.id && value.status === "pending")
                value.status = "cancelled";
          }
          result = {
            importId: draft.id,
            status: draft.status,
            operationId: draft.receiptId ?? null,
          };
          break;
        }
        case "export_transactions_csv":
          result = this.fileResult(
            this.makeFile(
              w,
              p,
              args.currency,
              `tally-${args.currency}.csv`,
              "text/csv",
              Buffer.from(
                transactionsToCsv(
                  ledger!.data.transactions.filter(
                    (t) => !args.month || t.date.startsWith(args.month),
                  ),
                  args.currency,
                ),
              ),
            ),
          );
          break;
        case "export_monthly_pdf":
          result = this.fileResult(
            this.makeFile(
              w,
              p,
              args.currency,
              `tally-${args.currency}-${args.month}.pdf`,
              "application/pdf",
              Buffer.from(await createTransactionReportPdf(ledger!.data, args.month)),
            ),
          );
          break;
        case "export_backup":
          result = this.fileResult(
            this.makeFile(
              w,
              p,
              args.currency,
              `tally-${args.currency}.json`,
              "application/json",
              Buffer.from(this.backup(ledger!)),
            ),
          );
          break;
        case "get_file":
          result = this.fileResult(owned(w.files[args.fileId], p, args.currency));
          break;
        case "preview_restore": {
          const file = owned(w.files[args.fileId], p, args.currency);
          let data: any;
          try {
            data = JSON.parse(Buffer.from(file.bytes, "base64").toString());
          } catch {
            fail("invalid_backup", "Backup is not valid JSON.");
          }
          if (
            !["tally-budget-backup/v2", "tally-agent-backup/v3"].includes(data.format) ||
            data.currency !== args.currency ||
            data.ledger?.currency !== args.currency
          )
            fail("currency_mismatch", "Choose a supported backup for this currency.");
          const after = structuredClone(ledger!);
          after.data = data.ledger;
          if (data.format === "tally-agent-backup/v3") {
            if (!Array.isArray(data.categories) || data.categories.length > 100)
              fail("invalid_backup", "Invalid category catalog.");
            after.categories = data.categories;
            const catIds = new Set<string>();
            const names = new Set<string>();
            for (const c of after.categories) {
              if (
                !c.id ||
                typeof c.id !== "string" ||
                c.id.length > 128 ||
                catIds.has(c.id) ||
                typeof c.name !== "string" ||
                !c.name.trim() ||
                c.name.length > 40 ||
                names.has(c.name.toLocaleLowerCase("en-US")) ||
                !["income", "expense"].includes(c.kind) ||
                typeof c.archived !== "boolean" ||
                typeof c.builtIn !== "boolean"
              )
                fail("invalid_backup", "Invalid or duplicate category.");
              catIds.add(c.id);
              names.add(c.name.toLocaleLowerCase("en-US"));
            }
          }
          validateLedger(after);
          result = plan("restore", after, {
            replaceEntryCount: ledger!.data.transactions.length,
            restoredEntryCount: after.data.transactions.length,
            categories: after.categories,
            currency: args.currency,
            sourceFileId: file.id,
          });
          break;
        }
        case "commit_restore":
          result = commit("restore");
          break;
        case "get_recovery_status":
          result = {
            uploadedFiles: Object.values(w.files)
              .filter(
                (f) =>
                  f.actorId === p.actorId && f.currency === args.currency && f.purpose === "upload",
              )
              .map((f) => ({ fileId: f.id, name: f.name, expiresAt: f.expiresAt })),
            browserLocalStorageAccessible: false,
          };
          break;
        case "export_raw_recovery": {
          const file = owned(w.files[args.fileId], p, args.currency);
          result = this.fileResult(
            this.makeFile(
              w,
              p,
              args.currency,
              file.name,
              file.mime,
              Buffer.from(file.bytes, "base64"),
            ),
          );
          break;
        }
        case "verify_ledger_integrity":
          validateLedger(ledger!);
          result = {
            valid: true,
            currency: args.currency,
            revision: ledger!.revision,
            entries: ledger!.data.transactions.length,
          };
          break;
        case "prepare_clear_month":
        case "prepare_remove_sample_entries": {
          const removed = ledger!.data.transactions.filter((t) =>
            request.tool === "tally_prepare_clear_month" ? t.date.startsWith(args.month) : t.sample,
          );
          const after = structuredClone(ledger!);
          const ids = new Set(removed.map((t) => t.id));
          after.data.transactions = after.data.transactions.filter((t) => !ids.has(t.id));
          after.data.sample = after.data.transactions.some((t) => t.sample);
          result = plan(
            request.tool === "tally_prepare_clear_month" ? "clear-month" : "remove-samples",
            after,
            { month: args.month ?? null, count: removed.length, transactionIds: [...ids] },
          );
          break;
        }
        case "clear_month":
          result = commit("clear-month");
          break;
        case "remove_sample_entries":
          result = commit("remove-samples");
          break;
        case "get_ai_status":
          result = {
            configured: spendingChatConfig(this.environment) !== null,
            maxDailyRequests: 20,
            maxQuestionCharacters: 500,
            maxOutputTokens: 500,
            timeoutMs: 15000,
            consentRequired: true,
          };
          break;
        case "create_analysis_context": {
          const context = buildSpendingSummary(ledger!.data, args.month);
          context.goal.name = "Monthly savings goal";
          // Custom category labels can contain personal information. Replace them for provider context.
          context.categories = context.categories.map((c, i) => {
            const category = ledger!.categories.find((v) => v.name === c.name);
            return {
              ...c,
              name:
                category?.builtIn && category.id === `expense:${c.name}`
                  ? c.name
                  : `Custom category ${i + 1}`,
            };
          });
          if (!validateSpendingChatRequest({ question: "Context validation", summary: context }))
            fail("context_limit", "Monthly totals exceed the bounded provider-context limits.");
          const config = spendingChatConfig(this.environment);
          const provider = config
            ? { name: config.provider, host: new URL(config.endpoint).host, model: config.model }
            : null;
          result = plan(
            "ai-consent",
            undefined,
            {
              context,
              question: args.question,
              provider: provider ?? "unconfigured",
              disclosure:
                "This question and the displayed monthly aggregates will be sent to the configured external AI provider.",
            },
            { context, question: args.question, providerIdentity: hash(provider) },
          );
          result.contextId = result.planId;
          break;
        }
        case "ask_spending_question": {
          const config = spendingChatConfig(this.environment);
          if (!config) fail("provider_unconfigured", "The AI provider is not configured.", 503);
          const context = owned(w.plans[args.contextId], p, args.currency);
          if (
            context.operation !== "ai-consent" ||
            context.status !== "pending" ||
            !context.context
          )
            fail("invalid_context", "Create a new analysis context.");
          requireRevision(ledger!, context.revision);
          if (
            context.question !== args.question ||
            context.providerIdentity !==
              hash({
                name: config.provider,
                host: new URL(config.endpoint).host,
                model: config.model,
              })
          )
            fail(
              "stale_context",
              "The question or provider changed. Create and approve a new context.",
              409,
            );
          const approval = w.approvals[args.approvalId];
          if (
            !approval ||
            approval.planId !== context.id ||
            approval.hash !== context.hash ||
            approval.actorId !== p.actorId ||
            approval.status !== "approved" ||
            approval.expiresAt <= Date.now()
          )
            fail(
              "consent_required",
              "The owner must approve the displayed external data-sharing context.",
              403,
            );
          const jobs = Object.values(w.ai);
          if (jobs.some((j) => j.status === "pending" && j.startedAt > Date.now() - 20000))
            fail("busy", "One provider request is already pending.", 409);
          if (jobs.filter((j) => j.startedAt >= Date.now() - 86400000).length >= 20)
            fail("rate_limit", "The daily provider request limit is reached.", 429);
          const id = randomUUID();
          approval.status = "consumed";
          context.status = "committed";
          context.receiptId = id;
          w.ai[id] = {
            id,
            actorId: p.actorId,
            currency: args.currency,
            contextId: context.id,
            status: "pending",
            instance: this.instance,
            startedAt: Date.now(),
          };
          providerJob = { id, context: context.context, question: args.question };
          result = { requestId: id, status: "pending" };
          break;
        }
        case "get_ai_request":
        case "cancel_ai_request": {
          const job = owned(w.ai[args.requestId], p, args.currency);
          if (job.status === "pending" && job.startedAt <= Date.now() - 20000) {
            job.status = "interrupted";
            job.error =
              "The server restarted during this provider request. Its outcome is unknown; review before retrying.";
          }
          if (request.tool === "tally_cancel_ai_request" && job.status === "pending") {
            job.status = "cancelled";
            cancelJob = job.id;
          }
          result = {
            requestId: job.id,
            status: job.status,
            answer: job.answer ?? null,
            error: job.error ?? null,
          };
          break;
        }
        case "request_approval": {
          const preview = owned(w.plans[args.planId], p, args.currency);
          if (preview.status !== "pending")
            fail("invalid_plan", "This operation is no longer awaiting approval.", 409);
          const value = {
            id: randomUUID(),
            planId: preview.id,
            actorId: p.actorId,
            hash: preview.hash,
            expiresAt: Math.min(preview.expiresAt, Date.now() + 900000),
            status: "requested" as const,
          };
          w.approvals[value.id] = value;
          result = {
            approvalId: value.id,
            status: value.status,
            previewHash: value.hash,
            expiresAt: value.expiresAt,
          };
          break;
        }
        case "get_approval": {
          const value = w.approvals[args.approvalId];
          const preview = value ? w.plans[value.planId] : undefined;
          owned(preview, p, args.currency);
          if (!value || value.actorId !== p.actorId) fail("not_found", "Approval not found.", 404);
          result = {
            approvalId: value.id,
            planId: value.planId,
            status: value.expiresAt <= Date.now() ? "expired" : value.status,
            expiresAt: value.expiresAt,
          };
          break;
        }
        case "get_operation":
        case "get_operation_receipt":
        case "cancel_operation": {
          const receipt = Object.values(w.receipts).find(
            (r) =>
              r.id === args.operationId &&
              r.actorId === p.actorId &&
              r.currency === args.currency &&
              r.result.committed === true,
          );
          if (receipt) {
            result = { receipt: this.publicReceipt(receipt, p) };
            break;
          }
          if (request.tool === "tally_get_operation_receipt") {
            const prepared = Object.values(w.receipts).find(
              (r) =>
                r.id === args.operationId &&
                r.actorId === p.actorId &&
                r.currency === args.currency,
            );
            if (prepared) {
              result = { receipt: this.publicReceipt(prepared, p) };
              break;
            }
            fail("not_found", "Operation receipt not found.", 404);
          }
          const value = owned(w.plans[args.operationId], p, args.currency);
          if (request.tool === "tally_cancel_operation" && value.status === "pending")
            value.status = "cancelled";
          const original = Object.values(w.receipts).find((r) => r.id === value.id);
          const canRead =
            original && p.scopes.includes(original.requiredScope ?? catalog[original.tool]?.scope);
          result = {
            operationId: value.id,
            status: value.status,
            previewHash: value.hash,
            revision: value.revision,
            review: canRead ? value.review : { redacted: true },
          };
          break;
        }
        case "list_audit_events":
          result = paginate(
            w.audit
              .filter((a) => a.currency === args.currency)
              .slice()
              .reverse(),
            args,
            { actor: p.actorId, currency: args.currency, auditLength: w.audit.length },
          );
          break;
        case "prepare_undo": {
          const receipt = Object.values(w.receipts).find(
            (r) =>
              r.id === args.operationId &&
              r.actorId === p.actorId &&
              r.currency === args.currency &&
              r.result.committed === true,
          );
          if (!receipt?.undo || !receipt.afterHash || hash(ledger) !== receipt.afterHash)
            fail(
              "undo_conflict",
              "The ledger changed after this operation, or this operation cannot be undone.",
              409,
            );
          const requiredScope = receipt.requiredScope ?? catalog[receipt.tool].scope;
          assertPrincipal(p, requiredScope, args.currency);
          const after = structuredClone(ledger!);
          const original = receipt.undo;
          after.data.transactions = after.data.transactions.filter(
            (t) => !Object.hasOwn(original.transactions, t.id),
          );
          for (const tx of Object.values(original.transactions))
            if (tx) after.data.transactions.push(structuredClone(tx));
          for (const [key, value] of Object.entries(original.settings)) {
            if (value) after.data.settingsByMonth[key] = structuredClone(value);
            else delete after.data.settingsByMonth[key];
          }
          if (original.categories) after.categories = structuredClone(original.categories);
          after.data.sample = original.sample;
          result = plan(
            "undo",
            after,
            {
              originalOperationId: receipt.id,
              originalTool: receipt.tool,
              restoreRevisionContent: receipt.undo.previousRevision,
            },
            { requiredScope },
          );
          break;
        }
        case "commit_undo":
          result = commit("undo");
          break;
        default:
          fail("unknown_tool", "Unknown tool.", 404);
      }
      if (changed) {
        const current = w.ledgers[args.currency as Currency];
        validateLedger(current);
        current.revision = before!.revision + 1;
        result.revision = current.revision;
        result.committed = true;
      }
      if (definition.effect === "write" || definition.effect === "external")
        result.committed = true;
      if (definition.effect !== "read") {
        const operationId =
          typeof result.operationId === "string" ? result.operationId : randomUUID();
        result.operationId = operationId;
        const receipt: Receipt = {
          id: operationId,
          actorId: p.actorId,
          currency: args.currency,
          key: request.idempotencyKey!,
          fingerprint,
          tool: request.tool,
          requiredScope: w.plans[operationId]?.requiredScope ?? definition.scope,
          committedAt: Date.now(),
          result: structuredClone(result),
          ...(changed
            ? {
                undo: this.undoDelta(before!, w.ledgers[args.currency as Currency]),
                afterHash: hash(w.ledgers[args.currency as Currency]),
                revision: result.revision as number,
              }
            : {}),
        };
        w.receipts[key] = receipt;
        if (changed && w.plans[operationId]) {
          delete w.plans[operationId].before;
          delete w.plans[operationId].after;
        }
        w.audit.push({
          id: randomUUID(),
          currency: args.currency,
          actorId: p.actorId,
          tool: request.tool,
          operationId,
          at: receipt.committedAt,
          revision: receipt.revision,
        });
      }
      return { ok: true as const, result };
    });
    if (cancelJob) this.controllers.get(cancelJob)?.abort();
    if (providerJob) {
      const controller = new AbortController();
      this.controllers.set(providerJob.id, controller);
      void this.runProvider(p, providerJob, controller).catch(() => undefined);
    }
    return response;
  }
  private undoDelta(before: Ledger, after: Ledger): UndoDelta {
    const prior = new Map(before.data.transactions.map((t) => [t.id, t]));
    const next = new Map(after.data.transactions.map((t) => [t.id, t]));
    const transactions = Object.fromEntries(
      [...new Set([...prior.keys(), ...next.keys()])]
        .filter((id) => hash(prior.get(id)) !== hash(next.get(id)))
        .map((id) => [id, prior.get(id) ?? null]),
    );
    const settings = Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(before.data.settingsByMonth),
          ...Object.keys(after.data.settingsByMonth),
        ]),
      ]
        .filter(
          (key) => hash(before.data.settingsByMonth[key]) !== hash(after.data.settingsByMonth[key]),
        )
        .map((key) => [key, before.data.settingsByMonth[key] ?? null]),
    );
    return {
      transactions,
      settings,
      sample: before.data.sample,
      previousRevision: before.revision,
      ...(hash(before.categories) !== hash(after.categories)
        ? { categories: before.categories }
        : {}),
    };
  }
  private publicReceipt(r: Receipt, p: Principal) {
    return {
      operationId: r.id,
      tool: r.tool,
      committedAt: r.committedAt,
      currency: r.currency,
      revision: r.revision,
      result: p.scopes.includes(r.requiredScope ?? catalog[r.tool]?.scope)
        ? r.result
        : { committed: r.result.committed ?? false, redacted: true },
    };
  }
  private summary(ledger: Ledger, month: string) {
    validateLedger(ledger);
    const summary = buildSpendingSummary(ledger.data, month);
    return {
      currency: ledger.data.currency,
      month,
      revision: ledger.revision,
      incomeMinor: summary.incomeCents,
      spendingMinor: summary.spendingCents,
      remainingMinor: summary.remainingCents,
      goal: { name: summary.goal.name, targetMinor: summary.goal.targetCents },
      categories: ledger.categories
        .filter((c) => c.kind === "expense")
        .map((c) => ({
          category: c.name,
          spentMinor: ledger.data.transactions
            .filter(
              (t) => t.kind === "expense" && t.category === c.name && t.date.startsWith(month),
            )
            .reduce((sum, t) => sum + t.amountCents, 0),
          budgetMinor: settingsForMonth(ledger.data, month).categoryBudgets[c.name] ?? null,
        })),
    };
  }
  private importRows(draft: Workspace["imports"][string], ledger: Ledger): StatementPreviewRow[] {
    if (!draft.mapping) fail("mapping_required", "Set the statement column mapping first.");
    const rows = buildStatementPreview({
      table: draft.table,
      mapping: draft.mapping,
      currency: draft.currency,
      existing: ledger.data.transactions,
    });
    if (draft.mapping.categoryColumn != null) {
      const index = draft.mapping.categoryColumn;
      if (index < 0 || index >= draft.table.headers.length)
        fail("invalid_mapping", "Category column is outside the table.");
      for (const row of rows)
        if (row.transaction && !row.error) {
          const label = row.values[index]?.trim() ?? "";
          try {
            checkedCategory(ledger, row.transaction.kind, label);
            row.transaction.category = label;
          } catch {
            row.transaction = null;
            row.error =
              "Choose an active category of the same kind, or create it before importing.";
          }
        }
    }
    for (const row of rows)
      if (row.transaction && !row.error) {
        try {
          checkedCategory(ledger, row.transaction.kind, row.transaction.category);
        } catch {
          row.transaction = null;
          row.error = "The default import category is unavailable. Map an active category column.";
        }
      }
    return rows;
  }
  private backup(ledger: Ledger) {
    return JSON.stringify(
      {
        format: "tally-agent-backup/v3",
        currency: ledger.data.currency,
        ledger: ledger.data,
        categories: ledger.categories,
      },
      null,
      2,
    );
  }
  private makeFile(
    w: Workspace,
    p: Principal,
    currency: Currency,
    name: string,
    mime: string,
    bytes: Buffer,
    purpose: "upload" | "download" = "download",
  ) {
    if (bytes.length > 10485760) fail("file_too_large", "The file exceeds 10 MB.", 413);
    if (
      Object.values(w.files).reduce((sum, f) => sum + Buffer.byteLength(f.bytes, "base64"), 0) +
        bytes.length >
      40 * 1048576
    )
      fail("quota", "The private file quota is reached. Wait for expired files to be removed.");
    const file: PrivateFile = {
      id: randomUUID(),
      actorId: p.actorId,
      currency,
      name: name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120),
      mime,
      bytes: bytes.toString("base64"),
      purpose,
      expiresAt: Date.now() + (purpose === "upload" ? 86400000 : 900000),
    };
    w.files[file.id] = file;
    return file;
  }
  private fileResult(file: PrivateFile) {
    return {
      fileId: file.id,
      name: file.name,
      mime: file.mime,
      bytes: Buffer.byteLength(file.bytes, "base64"),
      expiresAt: file.expiresAt,
      downloadPath: `api/agent/files/${file.id}?currency=${file.currency}`,
    };
  }
  async upload(p: Principal, currency: Currency, name: string, mime: string, bytes: Buffer) {
    assertPrincipal(p, "files:write", currency);
    if (!["text/csv", "application/pdf", "application/json", "text/plain"].includes(mime))
      fail("unsupported_file", "Choose CSV, PDF, JSON or raw text recovery material.");
    if (!bytes.length) fail("empty_file", "This file is empty.");
    return this.store.transaction(p.ownerId, async (w) => {
      cleanup(w);
      return this.fileResult(this.makeFile(w, p, currency, name, mime, bytes, "upload"));
    });
  }
  async download(p: Principal, currency: Currency, fileId: string) {
    assertPrincipal(p, "files:read", currency);
    const file = await this.store.transaction(p.ownerId, async (w) => {
      const file = owned(w.files[fileId], p, currency);
      return { name: file.name, mime: file.mime, bytes: Buffer.from(file.bytes, "base64") };
    });
    return { ...file, bytes: Buffer.from(file.bytes) };
  }
  async approvals(p: Principal) {
    assertPrincipal(p, "owner:approve");
    if (p.role !== "owner") fail("forbidden", "Only the owner can review approvals.", 403);
    return this.store.transaction(p.ownerId, async (w) => {
      cleanup(w);
      return Object.values(w.approvals)
        .filter((a) => a.status === "requested" && a.expiresAt > Date.now())
        .flatMap((a) => {
          const plan = w.plans[a.planId];
          return plan && p.currencies.includes(plan.currency)
            ? [
                {
                  approvalId: a.id,
                  actorId: a.actorId,
                  planId: plan.id,
                  currency: plan.currency,
                  operation: plan.operation,
                  review: plan.review,
                  previewHash: plan.hash,
                  expiresAt: a.expiresAt,
                  revision: plan.revision,
                },
              ]
            : [];
        });
    });
  }
  async decide(p: Principal, approvalId: string, previewHash: string, approve: boolean) {
    assertPrincipal(p, "owner:approve");
    if (p.role !== "owner") fail("forbidden", "An agent cannot grant approvals.", 403);
    return this.store.transaction(p.ownerId, async (w) => {
      const a = w.approvals[approvalId];
      const plan = a ? w.plans[a.planId] : undefined;
      if (!a || !plan || !p.currencies.includes(plan.currency))
        fail("not_found", "Approval not found.", 404);
      if (
        a.expiresAt <= Date.now() ||
        plan.expiresAt <= Date.now() ||
        plan.status !== "pending" ||
        a.hash !== previewHash ||
        plan.hash !== previewHash ||
        plan.revision !== w.ledgers[plan.currency].revision
      )
        fail(
          "stale_approval",
          "This preview expired or the ledger changed. Prepare it again.",
          409,
        );
      if (a.status !== "requested")
        fail("approval_decided", "This approval has already been decided.", 409);
      a.status = approve ? "approved" : "rejected";
      a.decidedBy = p.actorId;
      w.audit.push({
        id: randomUUID(),
        actorId: p.actorId,
        currency: plan.currency,
        tool: approve ? "owner_approve" : "owner_reject",
        operationId: plan.id,
        at: Date.now(),
      });
      return { approvalId, status: a.status };
    });
  }
  async approvalRows(p: Principal, approvalId: string, cursor?: string) {
    assertPrincipal(p, "owner:approve");
    if (p.role !== "owner") fail("forbidden", "Only the owner can review frozen changes.", 403);
    return this.store.transaction(p.ownerId, async (w) => {
      const approval = w.approvals[approvalId];
      const plan = approval ? w.plans[approval.planId] : undefined;
      if (
        !plan ||
        !p.currencies.includes(plan.currency) ||
        plan.expiresAt <= Date.now() ||
        approval.expiresAt <= Date.now()
      )
        fail("not_found", "Approval preview not found or expired.", 404);
      if (!plan.after) return { items: [], nextCursor: null, total: 0, previewHash: plan.hash };
      const prior = new Map(plan.before?.data.transactions.map((t) => [t.id, t]) ?? []);
      const next = new Map(plan.after?.data.transactions.map((t) => [t.id, t]) ?? []);
      const changes = [...new Set([...prior.keys(), ...next.keys()])].flatMap((id) =>
        hash(prior.get(id)) === hash(next.get(id))
          ? []
          : [
              {
                transactionId: id,
                before: prior.has(id) ? publicTx(prior.get(id)!) : null,
                after: next.has(id) ? publicTx(next.get(id)!) : null,
              },
            ],
      );
      return {
        ...paginate(
          changes,
          { limit: 100, cursor },
          { approvalId, hash: plan.hash, actor: p.actorId },
        ),
        previewHash: plan.hash,
      };
    });
  }
  private async runProvider(
    p: Principal,
    job: { id: string; context: any; question: string },
    controller: AbortController,
  ) {
    const pending = await this.store.transaction(
      p.ownerId,
      async (w) => w.ai[job.id]?.status === "pending",
    );
    if (!pending) {
      this.controllers.delete(job.id);
      return;
    }
    let answer: string | undefined;
    let error: string | undefined;
    try {
      answer = await this.provider(
        { question: job.question, summary: job.context },
        controller.signal,
        this.environment,
      );
    } catch {
      error = controller.signal.aborted
        ? "Request cancelled."
        : "The provider request failed or timed out. Review before starting a new request.";
    }
    await this.store.transaction(p.ownerId, async (w) => {
      const request = w.ai[job.id];
      if (request?.status === "pending") {
        request.status = answer ? "completed" : controller.signal.aborted ? "cancelled" : "failed";
        request.answer = answer;
        request.error = error;
      }
    });
    this.controllers.delete(job.id);
  }
}
