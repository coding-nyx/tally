import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore, type Principal } from "./store.ts";
import { scopes } from "./catalog.ts";
const shared: Principal = {
  ownerId: "synthetic-preview-policy",
  actorId: "tailnet-shared",
  role: "owner",
  currencies: ["INR", "USD"],
  scopes,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const currency = "INR";
const transaction = {
  kind: "expense",
  amountMinor: 1250,
  category: "Personal",
  date: "2026-10-14",
  note: "Synthetic preview policy",
};
function fixture(environment = { TALLY_AGENT_AUTH_MODE: "tailnet" }) {
  const store = new MemoryWorkspaceStore();
  return { store, service: new AgentToolService(store, environment) };
}
async function call(
  service: AgentToolService,
  tool: string,
  args = {},
  principal = shared,
  idempotencyKey = randomUUID(),
) {
  const response = await service.execute(principal, {
    version: 2,
    tool: `tally_${tool}`,
    args,
    idempotencyKey,
  });
  assert.ok(response.ok);
  return response;
}
const commitArgs = (p: Record<string, any>) => ({
  currency,
  expectedRevision: p.revision,
  planId: p.planId,
  previewHash: p.previewHash,
});
test("shared financial preview commits directly once; preserves hash, revision, currency and receipt checks", async () => {
  const { service } = fixture();
  assert.equal((await call(service, "get_capabilities")).result.financialApprovalRequired, false);
  const created = await call(service, "create_transaction", {
    currency,
    expectedRevision: 0,
    transaction,
  });
  const plan = (
    await call(service, "prepare_delete_transaction", {
      currency,
      expectedRevision: 1,
      transactionId: (created.result.transaction as any).id,
    })
  ).result;
  assert.equal(plan.approvalRequired, false);
  await assert.rejects(
    call(service, "delete_transaction", { ...commitArgs(plan), previewHash: undefined }),
    /previewHash/,
  );
  await assert.rejects(
    call(service, "delete_transaction", { ...commitArgs(plan), previewHash: "0".repeat(64) }),
    /exact frozen preview hash/,
  );
  await assert.rejects(
    call(service, "delete_transaction", {
      ...commitArgs(plan),
      currency: "USD",
      expectedRevision: 0,
    }),
    /not found/,
  );
  const key = randomUUID();
  const removed = await call(service, "delete_transaction", commitArgs(plan), shared, key);
  assert.equal(removed.result.revision, 2);
  const replay = await call(service, "delete_transaction", commitArgs(plan), shared, key);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, removed.result);
  assert.equal((await call(service, "get_ledger", { currency })).result.entryCount, 0);
  assert.equal((await call(service, "get_ledger", { currency: "USD" })).result.revision, 0);
});
test("shared previews cannot commit after cancellation, expiry or a later ledger edit", async () => {
  for (const invalidate of ["cancel", "expire", "edit"]) {
    const { store, service } = fixture();
    const plan = (
      await call(service, "prepare_batch_changes", {
        currency,
        expectedRevision: 0,
        changes: [{ action: "create", transaction }],
      })
    ).result;
    if (invalidate === "cancel")
      await call(service, "cancel_operation", { currency, operationId: plan.planId });
    if (invalidate === "expire")
      await store.transaction(shared.ownerId, async (w) => {
        w.plans[plan.planId as string].expiresAt = 1;
      });
    if (invalidate === "edit")
      await call(service, "create_transaction", { currency, expectedRevision: 0, transaction });
    await assert.rejects(
      call(service, "commit_batch_changes", commitArgs(plan)),
      /cannot be committed|not found|changed|revision/i,
    );
  }
});
test("bearer principals and non-shared principals still require owner approval", async () => {
  for (const [env, principal] of [
    [{ TALLY_AGENT_AUTH_MODE: "bearer" }, shared],
    [
      { TALLY_AGENT_AUTH_MODE: "tailnet" },
      { ...shared, actorId: "synthetic-agent", role: "agent" as const },
    ],
  ] as const) {
    const { service } = fixture(env);
    const plan = (
      await call(
        service,
        "prepare_batch_changes",
        { currency, expectedRevision: 0, changes: [{ action: "create", transaction }] },
        principal,
      )
    ).result;
    assert.equal(plan.approvalRequired, true);
    await assert.rejects(
      call(service, "commit_batch_changes", commitArgs(plan), principal),
      /owner must approve/,
    );
  }
});
test("external AI consent stays separate from shared financial commits", async () => {
  let providerCalls = 0;
  const service = new AgentToolService(
    new MemoryWorkspaceStore(),
    {
      TALLY_AGENT_AUTH_MODE: "tailnet",
      TALLY_AI_PROVIDER: "deepseek",
      TALLY_AI_MODEL: "synthetic",
      TALLY_AI_API_KEY: "synthetic-test-not-a-credential",
    },
    async () => {
      providerCalls += 1;
      throw new Error("Unexpected provider dispatch");
    },
  );
  const plan = (
    await call(service, "create_analysis_context", {
      currency,
      month: "2026-10",
      question: "How much did I spend?",
    })
  ).result;
  assert.equal(plan.approvalRequired, true);
  await assert.rejects(
    call(service, "ask_spending_question", {
      currency,
      contextId: plan.contextId,
      question: "How much did I spend?",
    }),
    /approvalId/,
  );
  await assert.rejects(
    call(service, "ask_spending_question", {
      currency,
      contextId: plan.contextId,
      approvalId: "synthetic-unapproved",
      question: "How much did I spend?",
    }),
    /consent|approv/i,
  );
  assert.equal(providerCalls, 0);
  assert.equal((await call(service, "get_ai_status")).result.consentRequired, true);
});
