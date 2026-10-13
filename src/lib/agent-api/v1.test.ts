import assert from "node:assert/strict";
import { test } from "node:test";
import type { BudgetData, Currency } from "../budget.ts";
import { executeAgentApiV1, type AgentCommitResult, type AgentLedgerAdapter } from "./v1.ts";

const sampleLedger = (currency: Currency): BudgetData => ({
  currency,
  sample: false,
  transactions: [
    {
      id: "existing-1",
      kind: "expense",
      amountCents: 1250,
      category: "Dining",
      note: "Lunch",
      date: "2026-10-05",
      createdAt: 1,
      sample: false,
    },
    {
      id: "other-month",
      kind: "income",
      amountCents: 50000,
      category: "Pay",
      note: "Synthetic",
      date: "2026-09-01",
      createdAt: 2,
      sample: false,
    },
  ],
  settingsByMonth: {
    "2026-10": { goalName: "Cushion", goalTargetCents: 40000, categoryBudgets: { Dining: 8000 } },
  },
});

class SyntheticAdapter implements AgentLedgerAdapter {
  data = sampleLedger("INR");
  revision = "rev-1";
  private readonly receipts = new Map<string, { fingerprint: string; revision: string }>();
  private readonly writeQueue: Array<() => void> = [];

  async read(currency: Currency) {
    if (currency !== this.data.currency)
      return { data: structuredClone(this.data), revision: this.revision };
    return { data: structuredClone(this.data), revision: this.revision };
  }

  async commit(args: Parameters<AgentLedgerAdapter["commit"]>[0]): Promise<AgentCommitResult> {
    const previous = this.receipts.get(`${args.currency}:${args.idempotencyKey}`);
    if (previous)
      return previous.fingerprint === args.requestFingerprint
        ? { status: "replayed", revision: this.revision }
        : { status: "idempotency-conflict", revision: this.revision };
    if (args.expectedRevision !== this.revision)
      return { status: "conflict", revision: this.revision };
    this.data = structuredClone(args.nextData);
    this.revision = `rev-${Number(this.revision.slice(4)) + 1}`;
    this.receipts.set(`${args.currency}:${args.idempotencyKey}`, {
      fingerprint: args.requestFingerprint,
      revision: this.revision,
    });
    return { status: "committed", revision: this.revision };
  }
}

const authenticated = { authenticated: true, writesEnabled: true };
const disabledWrites = { authenticated: true, writesEnabled: false };

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    operation: "transactions.create",
    currency: "INR",
    expectedRevision: "rev-1",
    idempotencyKey: "synthetic-create-0001",
    transaction: {
      kind: "expense",
      amountMinor: 450,
      category: "Dining",
      note: "Tea",
      date: "2026-10-09",
    },
    ...overrides,
  };
}

test("v1 list is currency-scoped, month-filtered, paginated, and omits internal fields", async () => {
  const adapter = new SyntheticAdapter();
  const result = await executeAgentApiV1(
    { version: 1, operation: "transactions.list", currency: "INR", month: "2026-10", limit: 1 },
    adapter,
    authenticated,
  );
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.version, "v1");
  const body = result.body.data as {
    total: number;
    hasMore: boolean;
    transactions: Array<Record<string, unknown>>;
  };
  assert.equal(body.total, 1);
  assert.equal(body.hasMore, false);
  assert.equal(body.transactions[0]?.amountMinor, 1250);
  assert.equal("sample" in (body.transactions[0] ?? {}), false);
});

test("reads and writes require authentication; writes also stay disabled by default", async () => {
  const adapter = new SyntheticAdapter();
  const read = { version: 1, operation: "transactions.list", currency: "INR" };
  assert.equal(
    (await executeAgentApiV1(read, adapter, { authenticated: false, writesEnabled: true })).status,
    403,
  );
  const write = createRequest();
  const result = await executeAgentApiV1(write, adapter, disabledWrites);
  assert.equal(result.status, 403);
  assert.equal(adapter.data.transactions.length, 2);
});

test("create is idempotent for a retry and never duplicates a ledger row", async () => {
  const adapter = new SyntheticAdapter();
  const request = createRequest();
  const first = await executeAgentApiV1(request, adapter, authenticated);
  assert.equal(first.status, 200);
  const retry = await executeAgentApiV1(request, adapter, authenticated);
  assert.equal(retry.status, 200);
  if (retry.status === 200) assert.equal(retry.body.replayed, true);
  assert.equal(adapter.data.transactions.length, 3);
});

test("stale writers conflict, and reusing a create key with different data is rejected", async () => {
  const adapter = new SyntheticAdapter();
  const [first, second] = await Promise.all([
    executeAgentApiV1(createRequest(), adapter, authenticated),
    executeAgentApiV1(
      createRequest({
        idempotencyKey: "synthetic-create-0002",
        transaction: {
          kind: "expense",
          amountMinor: 550,
          category: "Dining",
          note: "Coffee",
          date: "2026-10-10",
        },
      }),
      adapter,
      authenticated,
    ),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const reused = await executeAgentApiV1(
    createRequest({
      transaction: {
        kind: "expense",
        amountMinor: 900,
        category: "Dining",
        note: "Different",
        date: "2026-10-09",
      },
    }),
    adapter,
    authenticated,
  );
  assert.equal(reused.status, 409);
  if (reused.status === 409) assert.equal(reused.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("invalid dates, direction/category mismatches, extra fields, and oversized payloads fail closed", async () => {
  const adapter = new SyntheticAdapter();
  const invalidDate = await executeAgentApiV1(
    createRequest({
      transaction: {
        kind: "expense",
        amountMinor: 10,
        category: "Dining",
        note: "x",
        date: "2026-02-30",
      },
    }),
    adapter,
    authenticated,
  );
  assert.equal(invalidDate.status, 400);
  const wrongCategory = await executeAgentApiV1(
    createRequest({
      transaction: {
        kind: "income",
        amountMinor: 10,
        category: "Dining",
        note: "x",
        date: "2026-10-01",
      },
    }),
    adapter,
    authenticated,
  );
  assert.equal(wrongCategory.status, 400);
  const extra = await executeAgentApiV1(
    { ...createRequest(), userId: "attacker-controlled" },
    adapter,
    authenticated,
  );
  assert.equal(extra.status, 400);
  const large = await executeAgentApiV1(
    { ...createRequest(), note: "x".repeat(20_000) },
    adapter,
    authenticated,
  );
  assert.equal(large.status, 413);
});

test("cross-currency snapshots are rejected and storage exceptions are sanitized", async () => {
  const adapter = new SyntheticAdapter();
  const mismatch = await executeAgentApiV1(
    { version: 1, operation: "transactions.list", currency: "USD" },
    adapter,
    authenticated,
  );
  assert.equal(mismatch.status, 409);
  const broken: AgentLedgerAdapter = {
    read: async () => {
      throw new Error("raw private storage detail");
    },
    commit: adapter.commit.bind(adapter),
  };
  const unavailable = await executeAgentApiV1(
    { version: 1, operation: "transactions.list", currency: "INR" },
    broken,
    authenticated,
  );
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(JSON.stringify(unavailable), /raw private storage detail/);
});

test("transaction update and monthly settings remain bounded and currency-scoped", async () => {
  const adapter = new SyntheticAdapter();
  const update = await executeAgentApiV1(
    {
      version: 1,
      operation: "transactions.update",
      currency: "INR",
      expectedRevision: "rev-1",
      idempotencyKey: "synthetic-update-001",
      transactionId: "existing-1",
      patch: { note: "Updated synthetic lunch" },
    },
    adapter,
    authenticated,
  );
  assert.equal(update.status, 200);
  const invalidPatch = await executeAgentApiV1(
    {
      version: 1,
      operation: "transactions.update",
      currency: "INR",
      expectedRevision: "rev-2",
      idempotencyKey: "synthetic-update-002",
      transactionId: "existing-1",
      patch: { kind: "income" },
    },
    adapter,
    authenticated,
  );
  assert.equal(invalidPatch.status, 400);
  const settings = await executeAgentApiV1(
    {
      version: 1,
      operation: "settings.update",
      currency: "INR",
      expectedRevision: "rev-2",
      idempotencyKey: "synthetic-settings-01",
      month: "2026-10",
      settings: { goalName: "Buffer", goalTargetMinor: 60000, categoryBudgets: { Dining: 9000 } },
    },
    adapter,
    authenticated,
  );
  assert.equal(settings.status, 200);
  assert.equal(adapter.data.settingsByMonth["2026-10"]?.goalTargetCents, 60000);
});

test("v1 amount-only update retry maps amountMinor onto internal amountCents", async () => {
  const adapter = new SyntheticAdapter();
  const request = {
    version: 1,
    operation: "transactions.update",
    currency: "INR",
    expectedRevision: "rev-1",
    idempotencyKey: "synthetic-amount-retry",
    transactionId: "existing-1",
    patch: { amountMinor: 3456 },
  };
  const first = await executeAgentApiV1(request, adapter, authenticated);
  assert.equal(first.status, 200);
  const retry = await executeAgentApiV1(request, adapter, authenticated);
  assert.equal(retry.status, 200);
  if (retry.status === 200) assert.equal(retry.body.replayed, true);
  assert.equal(adapter.data.transactions[0].amountCents, 3456);
});
