import { z } from "zod";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  inMonth,
  settingsForMonth,
  type BudgetData,
  type Currency,
  type MonthlySettings,
  type Transaction,
  type TxKind,
} from "../budget.ts";

export const AGENT_API_VERSION = "v1" as const;
export const MAX_AGENT_PAGE_SIZE = 100;
const MAX_MINOR_UNITS = 10_000_000_000;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const currencySchema = z.enum(["INR", "USD"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate);
const revisionSchema = z.string().min(1).max(128);
const idempotencySchema = z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const monthSchema = z.string().regex(MONTH_PATTERN);

const transactionFieldsSchema = z.object({
  kind: z.enum(["income", "expense"]),
  amountMinor: z.number().int().positive().max(MAX_MINOR_UNITS),
  category: z.string().trim().min(1).max(40),
  note: z.string().max(80),
  date: dateSchema,
}).strict().superRefine((value, context) => {
  const categories = value.kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  if (!categories.includes(value.category as never)) {
    context.addIssue({ code: "custom", path: ["category"], message: "Category does not match transaction type." });
  }
});

const transactionPatchSchema = z.object({
  kind: z.enum(["income", "expense"]).optional(),
  amountMinor: z.number().int().positive().max(MAX_MINOR_UNITS).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  note: z.string().max(80).optional(),
  date: dateSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Provide at least one transaction field.");

const monthSettingsSchema = z.object({
  goalName: z.string().trim().min(1).max(40),
  goalTargetMinor: z.number().int().positive().max(MAX_MINOR_UNITS),
  categoryBudgets: z.record(z.string().trim().min(1).max(40), z.number().int().positive().max(MAX_MINOR_UNITS)).superRefine((budgets, context) => {
    for (const category of Object.keys(budgets)) {
      if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
        context.addIssue({ code: "custom", path: [category], message: "Unknown expense category." });
      }
    }
  }),
}).strict();

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ version: z.literal(1), operation: z.literal("transactions.list"), currency: currencySchema, month: monthSchema.optional(), offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(MAX_AGENT_PAGE_SIZE).default(50) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("transactions.get"), currency: currencySchema, transactionId: z.string().min(1).max(160) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("settings.get"), currency: currencySchema, month: monthSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("transactions.create"), currency: currencySchema, expectedRevision: revisionSchema, idempotencyKey: idempotencySchema, transaction: transactionFieldsSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("transactions.update"), currency: currencySchema, expectedRevision: revisionSchema, idempotencyKey: idempotencySchema, transactionId: z.string().min(1).max(160), patch: transactionPatchSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("transactions.delete"), currency: currencySchema, expectedRevision: revisionSchema, idempotencyKey: idempotencySchema, transactionId: z.string().min(1).max(160) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("settings.update"), currency: currencySchema, expectedRevision: revisionSchema, idempotencyKey: idempotencySchema, month: monthSchema, settings: monthSettingsSchema }).strict(),
]);

type AgentRequest = z.infer<typeof requestSchema>;

export type AgentApiResponse =
  | { status: 200; body: { version: "v1"; ok: true; revision: string; data: unknown; replayed?: true } }
  | { status: 400 | 403 | 404 | 409 | 413 | 503; body: { version: "v1"; ok: false; error: { code: string; message: string; retryable: boolean } } };

export type AgentCommitResult =
  | { status: "committed" | "replayed"; revision: string }
  | { status: "conflict"; revision: string }
  | { status: "idempotency-conflict"; revision: string };

/**
 * Storage adapters must serialize this call with a transaction and durably
 * enforce both expectedRevision and the idempotency key in the same commit.
 * No production adapter is connected while Tally's canonical store is in the
 * browser and the local database migration is awaiting approval.
 */
export interface AgentLedgerAdapter {
  read(currency: Currency): Promise<{ data: BudgetData; revision: string }>;
  commit(args: {
    currency: Currency;
    expectedRevision: string;
    idempotencyKey: string;
    requestFingerprint: string;
    nextData: BudgetData;
  }): Promise<AgentCommitResult>;
}

export type AgentApiPolicy = {
  authenticated: boolean;
  writesEnabled: boolean;
};

export async function executeAgentApiV1(
  input: unknown,
  adapter: AgentLedgerAdapter,
  policy: AgentApiPolicy,
): Promise<AgentApiResponse> {
  if (encodedSize(input) > 16_384) return fail(413, "REQUEST_TOO_LARGE", "Request exceeds the 16 KB limit.");
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return fail(400, "INVALID_REQUEST", "Request does not match the Tally agent API v1 schema.");
  const request = parsed.data;

  if (!policy.authenticated) return fail(403, "AUTH_REQUIRED", "Authenticate before using the Tally agent API.");
  if (isWrite(request) && !policy.writesEnabled) {
    return fail(403, "WRITE_DISABLED", "Authenticated agent writes are disabled until local API setup is approved.");
  }

  try {
    const snapshot = await adapter.read(request.currency);
    if (snapshot.data.currency !== request.currency) return fail(409, "CURRENCY_MISMATCH", "The selected ledger currency does not match this request.");
    if (!isWrite(request)) return readResponse(request, snapshot.data, snapshot.revision);

    if (request.operation === "transactions.update" && !snapshot.data.transactions.some((transaction) => transaction.id === request.transactionId)) {
      return fail(404, "NOT_FOUND", "Transaction was not found in this currency ledger.");
    }
    if (request.operation === "transactions.delete" && !snapshot.data.transactions.some((transaction) => transaction.id === request.transactionId)) {
      const replay = replayResponse(request, snapshot.data, snapshot.revision);
      return replay ?? fail(404, "NOT_FOUND", "Transaction was not found in this currency ledger.");
    }

    if (snapshot.revision !== request.expectedRevision) {
      const replay = replayResponse(request, snapshot.data, snapshot.revision);
      if (replay) return replay;
      if (request.operation === "transactions.create" && snapshot.data.transactions.some((transaction) => transaction.id === idForIdempotencyKey(request.currency, request.idempotencyKey))) {
        return fail(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different operation.");
      }
      return fail(409, "REVISION_CONFLICT", "The ledger changed. Read it again and retry against the new revision.");
    }

    const nextData = applyRequest(snapshot.data, request);
    const committed = await adapter.commit({
      currency: request.currency,
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: stableFingerprintInput(request),
      nextData,
    });
    if (committed.status === "conflict") return fail(409, "REVISION_CONFLICT", "The ledger changed during this write. Read it again and retry.");
    if (committed.status === "idempotency-conflict") return fail(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different operation.");
    return success(committed.revision, mutationResult(request, nextData), committed.status === "replayed");
  } catch (error) {
    if (error instanceof Error && error.message === "invalid-patch") return fail(400, "INVALID_TRANSACTION", "The updated transaction is invalid for its direction or category.");
    if (error instanceof Error && error.message === "not-found") return fail(404, "NOT_FOUND", "Resource was not found in this currency ledger.");
    return fail(503, "STORE_UNAVAILABLE", "The Tally ledger adapter is unavailable. No write was confirmed.", true);
  }
}

function readResponse(request: Exclude<AgentRequest, { operation: "transactions.create" | "transactions.update" | "transactions.delete" | "settings.update" }>, data: BudgetData, revision: string): AgentApiResponse {
  switch (request.operation) {
    case "transactions.list": {
      const transactions = data.transactions
        .filter((transaction) => !request.month || inMonth(transaction.date, request.month))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
      const page = transactions.slice(request.offset, request.offset + request.limit);
      return success(revision, {
        currency: data.currency,
        total: transactions.length,
        offset: request.offset,
        limit: request.limit,
        hasMore: request.offset + page.length < transactions.length,
        transactions: page.map(publicTransaction),
      });
    }
    case "transactions.get": {
      const transaction = data.transactions.find((candidate) => candidate.id === request.transactionId);
      return transaction ? success(revision, publicTransaction(transaction)) : fail(404, "NOT_FOUND", "Transaction was not found in this currency ledger.");
    }
    case "settings.get": {
      return success(revision, { currency: data.currency, month: request.month, settings: publicSettings(settingsForMonth(data, request.month)) });
    }
  }
}

function applyRequest(data: BudgetData, request: Extract<AgentRequest, { operation: "transactions.create" | "transactions.update" | "transactions.delete" | "settings.update" }>): BudgetData {
  switch (request.operation) {
    case "transactions.create": {
      const id = idForIdempotencyKey(request.currency, request.idempotencyKey);
      const transaction = parsePublicTransaction(request.transaction, id);
      return {
        ...data,
        transactions: [...data.transactions, transaction],
        sample: data.transactions.some((candidate) => candidate.sample),
      };
    }
    case "transactions.update": {
      const index = data.transactions.findIndex((candidate) => candidate.id === request.transactionId);
      if (index < 0) throw new Error("not-found");
      const current = data.transactions[index]!;
      const patched = { kind: current.kind, amountMinor: current.amountCents, category: current.category, note: current.note, date: current.date, ...request.patch };
      const validated = transactionFieldsSchema.safeParse(patched);
      if (!validated.success) throw new Error("invalid-patch");
      const transactions = data.transactions.slice();
      transactions[index] = parsePublicTransaction(validated.data, current.id);
      transactions[index] = { ...transactions[index]!, createdAt: current.createdAt, sample: current.sample };
      return { ...data, transactions, sample: transactions.some((candidate) => candidate.sample) };
    }
    case "transactions.delete": {
      const transactions = data.transactions.filter((candidate) => candidate.id !== request.transactionId);
      if (transactions.length === data.transactions.length) throw new Error("not-found");
      return { ...data, transactions, sample: transactions.some((candidate) => candidate.sample) };
    }
    case "settings.update": {
      const settings: MonthlySettings = {
        goalName: request.settings.goalName,
        goalTargetCents: request.settings.goalTargetMinor,
        categoryBudgets: request.settings.categoryBudgets,
      };
      return { ...data, settingsByMonth: { ...data.settingsByMonth, [request.month]: settings } };
    }
  }
}

function mutationResult(request: Extract<AgentRequest, { operation: "transactions.create" | "transactions.update" | "transactions.delete" | "settings.update" }>, data: BudgetData): unknown {
  switch (request.operation) {
    case "transactions.create":
      return publicTransaction(data.transactions.find((transaction) => transaction.id === idForIdempotencyKey(request.currency, request.idempotencyKey))!);
    case "transactions.update":
      return publicTransaction(data.transactions.find((transaction) => transaction.id === request.transactionId)!);
    case "transactions.delete":
      return { transactionId: request.transactionId, deleted: true };
    case "settings.update":
      return { currency: data.currency, month: request.month, settings: publicSettings(settingsForMonth(data, request.month)) };
  }
}

function replayResponse(request: Extract<AgentRequest, { operation: "transactions.create" | "transactions.update" | "transactions.delete" | "settings.update" }>, data: BudgetData, revision: string): AgentApiResponse | null {
  switch (request.operation) {
    case "transactions.create": {
      const existing = data.transactions.find((transaction) => transaction.id === idForIdempotencyKey(request.currency, request.idempotencyKey));
      if (!existing || !samePublicTransaction(existing, request.transaction)) return null;
      return success(revision, publicTransaction(existing), true);
    }
    case "transactions.update": {
      const existing = data.transactions.find((transaction) => transaction.id === request.transactionId);
      if (!existing || !Object.entries(request.patch).every(([key, value]) => existing[key as keyof Transaction] === value)) return null;
      return success(revision, publicTransaction(existing), true);
    }
    case "transactions.delete":
      return data.transactions.some((transaction) => transaction.id === request.transactionId)
        ? null
        : success(revision, { transactionId: request.transactionId, deleted: true }, true);
    case "settings.update": {
      const existing = settingsForMonth(data, request.month);
      const desired = { goalName: request.settings.goalName, goalTargetCents: request.settings.goalTargetMinor, categoryBudgets: request.settings.categoryBudgets };
      return JSON.stringify(existing) === JSON.stringify(desired)
        ? success(revision, { currency: data.currency, month: request.month, settings: publicSettings(existing) }, true)
        : null;
    }
  }
}

function publicTransaction(transaction: Transaction) {
  return {
    id: transaction.id,
    kind: transaction.kind,
    amountMinor: transaction.amountCents,
    category: transaction.category,
    note: transaction.note,
    date: transaction.date,
    createdAt: transaction.createdAt,
  };
}

function publicSettings(settings: MonthlySettings) {
  return {
    goalName: settings.goalName,
    goalTargetMinor: settings.goalTargetCents,
    categoryBudgets: settings.categoryBudgets,
  };
}

function parsePublicTransaction(input: z.infer<typeof transactionFieldsSchema>, id: string): Transaction {
  return {
    id,
    kind: input.kind as TxKind,
    amountCents: input.amountMinor,
    category: input.category,
    note: input.note,
    date: input.date,
    createdAt: Date.now(),
    sample: false,
  };
}

function samePublicTransaction(transaction: Transaction, input: z.infer<typeof transactionFieldsSchema>): boolean {
  return transaction.kind === input.kind && transaction.amountCents === input.amountMinor &&
    transaction.category === input.category && transaction.note === input.note && transaction.date === input.date;
}

function idForIdempotencyKey(currency: Currency, key: string): string {
  return `agent:${currency}:${key}`;
}

function isWrite(request: AgentRequest): request is Extract<AgentRequest, { operation: "transactions.create" | "transactions.update" | "transactions.delete" | "settings.update" }> {
  return request.operation === "transactions.create" || request.operation === "transactions.update" || request.operation === "transactions.delete" || request.operation === "settings.update";
}

function stableFingerprintInput(request: AgentRequest): string {
  return JSON.stringify(request);
}

function success(revision: string, data: unknown, replayed = false): AgentApiResponse {
  return { status: 200, body: { version: AGENT_API_VERSION, ok: true, revision, data, ...(replayed ? { replayed: true as const } : {}) } };
}

function fail(status: 400 | 403 | 404 | 409 | 413 | 503, code: string, message: string, retryable = false): AgentApiResponse {
  return { status, body: { version: AGENT_API_VERSION, ok: false, error: { code, message, retryable } } };
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}
