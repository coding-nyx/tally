import assert from "node:assert/strict";
import test from "node:test";
import { AgentToolService, ToolError } from "./service.ts";
import { MemoryWorkspaceStore, type Principal } from "./store.ts";
import { catalog, foundationCatalog, legacyCatalog, scopes } from "./catalog.ts";
const agent: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-agent",
  role: "agent",
  currencies: ["INR", "USD"],
  scopes: scopes.filter((s) => s !== "owner:approve"),
  expiresAt: Date.now() + 3600000,
};
const owner: Principal = { ...agent, actorId: "synthetic-human", role: "owner", scopes };
const tx = {
  kind: "expense",
  amountMinor: 1200,
  category: "Groceries",
  date: "2026-10-12",
  note: "Synthetic groceries",
};
function fixture(env = {}, provider?: ConstructorParameters<typeof AgentToolService>[2]) {
  return new AgentToolService(new MemoryWorkspaceStore(), env, provider);
}
let sequence = 0;
const exercised = new Set<string>();
async function call(
  s: AgentToolService,
  tool: string,
  args: Record<string, unknown> = {},
  p = agent,
  key?: string,
) {
  exercised.add(tool);
  const full = `tally_${tool}`;
  const response = await s.execute(p, {
    version: 2,
    tool: full,
    args,
    ...(catalog[full]?.effect !== "read"
      ? { idempotencyKey: key ?? `synthetic-${++sequence}` }
      : {}),
  });
  assert.equal(response.ok, true);
  if (!response.ok) throw new Error("Unexpected failure");
  return response.result as Record<string, any>;
}
async function approve(s: AgentToolService, value: Record<string, any>) {
  const approval = await call(s, "request_approval", { currency: "INR", planId: value.planId });
  await assert.rejects(
    s.decide(agent, approval.approvalId, value.previewHash, true),
    /does not allow|Only the owner/,
  );
  const reviewed = await s.approvalRows(owner, approval.approvalId);
  assert.ok(Array.isArray(reviewed.items));
  await s.decide(owner, approval.approvalId, value.previewHash, true);
  return approval.approvalId;
}
test("catalog covers 62 real operations and rejects unauthenticated/overbroad arguments", async () => {
  assert.equal(Object.keys(legacyCatalog).length, 62);
  assert.equal(Object.keys(foundationCatalog).length, 83);
  assert.equal(Object.keys(catalog).length, 99);
  const s = fixture();
  await assert.rejects(
    call(s, "get_ledger", { currency: "INR", authenticated: true }),
    /Unrecognized key/,
  );
  await assert.rejects(
    call(s, "get_ledger", { currency: "USD" }, { ...agent, currencies: ["INR"] }),
    /outside/,
  );
  await assert.rejects(
    call(s, "get_ledger", { currency: "INR" }, { ...agent, expiresAt: 1 }),
    /expired/,
  );
  const readOnly = { ...agent, scopes: ["summary:read"] };
  await assert.rejects(
    call(s, "list_transactions", { currency: "INR" }, readOnly),
    /does not allow/,
  );
  await assert.rejects(
    s.execute(agent, {
      version: 2,
      tool: "tally_create_transaction",
      args: { currency: "INR", expectedRevision: 0, transaction: tx },
    }),
    /idempotencyKey/,
  );
  await assert.rejects(
    call(s, "create_transaction", {
      currency: "INR",
      expectedRevision: 0,
      transaction: { ...tx, date: "2026-02-30" },
    }),
    /calendar/,
  );
});
test("discovery, preferences, deterministic analysis and currency separation", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  const cm = { ...c, month: "2026-10" };
  for (const tool of [
    "get_capabilities",
    "get_service_status",
    "list_ledgers",
    "get_preferences",
    "get_ai_status",
  ])
    await call(s, tool);
  for (const tool of [
    "get_ledger",
    "list_months",
    "list_categories",
    "verify_ledger_integrity",
    "get_recovery_status",
  ])
    await call(s, tool, c);
  for (const tool of [
    "get_month_settings",
    "get_savings_goal",
    "get_month_summary",
    "get_category_totals",
    "get_budget_status",
  ])
    await call(s, tool, cm);
  await call(s, "update_preferences", { currency: "USD" });
  await call(s, "set_savings_goal", {
    ...cm,
    expectedRevision: 0,
    name: "Synthetic goal",
    targetMinor: 10000,
  });
  await call(s, "set_category_budget", {
    ...cm,
    expectedRevision: 1,
    category: "Groceries",
    limitMinor: 2000,
  });
  assert.equal(
    (await call(s, "get_category_budget", { ...cm, category: "Groceries" })).limitMinor,
    2000,
  );
  await call(s, "clear_category_budget", { ...cm, expectedRevision: 2, category: "Groceries" });
  assert.equal(
    (await call(s, "get_category_budget", { ...cm, category: "Groceries" })).limitMinor,
    null,
  );
  assert.equal((await call(s, "get_ledger", { currency: "USD" })).revision, 0);
});
test("durable receipts replay original results before revision checks, even after later edits", async () => {
  const s = fixture();
  const args = { currency: "INR", expectedRevision: 0, transaction: tx };
  const first = await call(s, "create_transaction", args, agent, "synthetic-fixed-create");
  const updated = await call(
    s,
    "update_transaction",
    {
      currency: "INR",
      expectedRevision: 1,
      transactionId: first.transaction.id,
      patch: { amountMinor: 3400 },
    },
    agent,
    "synthetic-fixed-update",
  );
  await call(s, "update_transaction", {
    currency: "INR",
    expectedRevision: 2,
    transactionId: first.transaction.id,
    patch: { note: "Later edit" },
  });
  assert.deepEqual(
    await call(s, "create_transaction", args, agent, "synthetic-fixed-create"),
    first,
  );
  assert.deepEqual(
    await call(
      s,
      "update_transaction",
      {
        currency: "INR",
        expectedRevision: 1,
        transactionId: first.transaction.id,
        patch: { amountMinor: 3400 },
      },
      agent,
      "synthetic-fixed-update",
    ),
    updated,
  );
  await assert.rejects(
    call(
      s,
      "create_transaction",
      { ...args, transaction: { ...tx, amountMinor: 2 } },
      agent,
      "synthetic-fixed-create",
    ),
    /different request/,
  );
  assert.equal(
    (await call(s, "get_transaction", { currency: "INR", transactionId: first.transaction.id }))
      .transaction.amountMinor,
    3400,
  );
  await call(s, "get_operation_receipt", { currency: "INR", operationId: first.operationId });
});
test("concurrent writers conflict atomically, and pagination rejects changed queries/snapshots", async () => {
  const s = fixture();
  const writes = await Promise.allSettled([
    call(s, "create_transaction", { currency: "INR", expectedRevision: 0, transaction: tx }),
    call(s, "create_transaction", { currency: "INR", expectedRevision: 0, transaction: tx }),
  ]);
  assert.equal(writes.filter((v) => v.status === "fulfilled").length, 1);
  await call(s, "create_transaction", {
    currency: "INR",
    expectedRevision: 1,
    transaction: { ...tx, note: "Second" },
  });
  const page = await call(s, "list_transactions", { currency: "INR", limit: 1 });
  assert.ok(page.nextCursor);
  assert.equal(
    (await call(s, "list_transactions", { currency: "INR", limit: 1, cursor: page.nextCursor }))
      .items.length,
    1,
  );
  await assert.rejects(
    call(s, "list_transactions", {
      currency: "INR",
      month: "2026-10",
      limit: 1,
      cursor: page.nextCursor,
    }),
    /changed/,
  );
  await call(s, "create_transaction", { currency: "INR", expectedRevision: 2, transaction: tx });
  await assert.rejects(
    call(s, "list_transactions", { currency: "INR", limit: 1, cursor: page.nextCursor }),
    /changed/,
  );
});
test("category create/rename/archive/restore updates history and budgets and preserves USD", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  const cat = await call(s, "create_category", {
    ...c,
    expectedRevision: 0,
    kind: "expense",
    name: "Synthetic pets",
  });
  await call(s, "create_transaction", {
    ...c,
    expectedRevision: 1,
    transaction: { ...tx, category: cat.category.name },
  });
  await call(s, "set_category_budget", {
    ...c,
    month: "2026-10",
    expectedRevision: 2,
    category: cat.category.name,
    limitMinor: 4000,
  });
  await call(s, "update_category", {
    ...c,
    expectedRevision: 3,
    categoryId: cat.category.id,
    name: "Synthetic animals",
  });
  const ledger = await call(s, "list_transactions", c);
  assert.equal(ledger.items[0].category, "Synthetic animals");
  assert.equal(
    (
      await call(s, "get_category_budget", {
        ...c,
        month: "2026-10",
        category: "Synthetic animals",
      })
    ).limitMinor,
    4000,
  );
  await call(s, "archive_category", { ...c, expectedRevision: 4, categoryId: cat.category.id });
  await assert.rejects(
    call(s, "create_transaction", {
      ...c,
      expectedRevision: 5,
      transaction: { ...tx, category: "Synthetic animals" },
    }),
    /active category/,
  );
  await call(s, "restore_category", { ...c, expectedRevision: 5, categoryId: cat.category.id });
  assert.equal((await call(s, "get_ledger", { currency: "USD" })).entryCount, 0);
});
test("frozen deletes/batches require owner approval, receipt replay survives cancellation, undo is guarded", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  const entry = await call(s, "create_transaction", { ...c, expectedRevision: 0, transaction: tx });
  const preview = await call(s, "prepare_delete_transaction", {
    ...c,
    expectedRevision: 1,
    transactionId: entry.transaction.id,
  });
  await assert.rejects(
    call(s, "delete_transaction", {
      ...c,
      expectedRevision: 1,
      planId: preview.planId,
      approvalId: "untrusted-confirmed-true",
    }),
    /owner must approve/,
  );
  const approvalId = await approve(s, preview);
  await call(s, "get_approval", { ...c, approvalId });
  await call(s, "get_operation", { ...c, operationId: preview.planId });
  const removed = await call(
    s,
    "delete_transaction",
    { ...c, expectedRevision: 1, planId: preview.planId, approvalId },
    agent,
    "synthetic-delete-once",
  );
  assert.equal(
    (await call(s, "cancel_operation", { ...c, operationId: preview.planId })).receipt.result
      .committed,
    true,
  );
  assert.deepEqual(
    await call(
      s,
      "delete_transaction",
      { ...c, expectedRevision: 1, planId: preview.planId, approvalId },
      agent,
      "synthetic-delete-once",
    ),
    removed,
  );
  const undo = await call(s, "prepare_undo", {
    ...c,
    expectedRevision: 2,
    operationId: preview.planId,
  });
  await call(s, "commit_undo", {
    ...c,
    expectedRevision: 2,
    planId: undo.planId,
    approvalId: await approve(s, undo),
  });
  assert.equal((await call(s, "get_ledger", c)).entryCount, 1);
  await assert.rejects(
    call(s, "prepare_undo", { ...c, expectedRevision: 3, operationId: preview.planId }),
    /changed/,
  );
  const batch = await call(s, "prepare_batch_changes", {
    ...c,
    expectedRevision: 3,
    changes: [
      { action: "create", transaction: tx },
      { action: "update", transactionId: entry.transaction.id, patch: { amountMinor: 99 } },
    ],
  });
  await call(s, "commit_batch_changes", {
    ...c,
    expectedRevision: 3,
    planId: batch.planId,
    approvalId: await approve(s, batch),
  });
  await assert.rejects(
    call(s, "prepare_batch_changes", {
      ...c,
      expectedRevision: 4,
      changes: [
        { action: "create", transaction: tx },
        { action: "delete", transactionId: "missing" },
      ],
    }),
    /not found/,
  );
  assert.equal((await call(s, "get_ledger", c)).entryCount, 2);
  await call(s, "list_audit_events", c);
  const samples = await call(s, "prepare_remove_sample_entries", { ...c, expectedRevision: 4 });
  await call(s, "remove_sample_entries", {
    ...c,
    expectedRevision: 4,
    planId: samples.planId,
    approvalId: await approve(s, samples),
  });
  const clear = await call(s, "prepare_clear_month", {
    ...c,
    month: "2026-10",
    expectedRevision: 5,
  });
  await call(s, "clear_month", {
    ...c,
    expectedRevision: 5,
    planId: clear.planId,
    approvalId: await approve(s, clear),
  });
  assert.equal((await call(s, "get_ledger", c)).entryCount, 0);
});
test("CSV mapping, row correction, custom categories, duplicate/currency protection, repeated imports", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  await call(s, "create_transaction", { ...c, expectedRevision: 0, transaction: tx });
  const file = await s.upload(
    agent,
    "INR",
    "synthetic.csv",
    "text/csv",
    Buffer.from(
      "Date,Amount,Currency,Description,Category\n2026-10-12,-12.00,INR,Synthetic groceries,Groceries\n2026-02-30,-5.00,USD,Correct me,Groceries",
    ),
  );
  const draft = await call(s, "stage_statement", { ...c, fileId: file.fileId });
  await call(s, "get_import", { ...c, importId: draft.importId });
  const mapping = {
    dateColumn: 0,
    descriptionColumn: 3,
    currencyColumn: 2,
    categoryColumn: 4,
    dateFormat: "auto",
    amount: { mode: "signed", amountColumn: 1, positiveAmounts: "income" },
  };
  await call(s, "set_import_mapping", { ...c, importId: draft.importId, mapping });
  const invalid = await call(s, "preview_import", {
    ...c,
    expectedRevision: 1,
    importId: draft.importId,
  });
  assert.equal(invalid.invalid, 1);
  assert.equal(invalid.duplicates, 1);
  assert.equal(invalid.planId, undefined);
  await call(s, "correct_import_rows", {
    ...c,
    importId: draft.importId,
    corrections: [
      { rowNumber: 3, values: ["2026-10-13", "-5.00", "USD", "Correct me", "Groceries"] },
    ],
  });
  assert.equal(
    (await call(s, "preview_import", { ...c, expectedRevision: 1, importId: draft.importId }))
      .invalid,
    1,
  );
  await call(s, "correct_import_rows", {
    ...c,
    importId: draft.importId,
    corrections: [
      { rowNumber: 3, values: ["2026-10-13", "-5.00", "INR", "Correct me", "Groceries"] },
    ],
  });
  const preview = await call(s, "preview_import", {
    ...c,
    expectedRevision: 1,
    importId: draft.importId,
  });
  assert.equal(preview.review.valid, 1);
  const approvalId = await approve(s, preview);
  const args = { ...c, expectedRevision: 1, planId: preview.planId, approvalId };
  await call(s, "commit_import", args, agent, "synthetic-import-key");
  await call(s, "commit_import", args, agent, "synthetic-import-key");
  assert.equal((await call(s, "get_ledger", c)).entryCount, 2);
  assert.equal(
    (await call(s, "cancel_import", { ...c, importId: draft.importId })).status,
    "committed",
  );
  assert.equal((await call(s, "get_ledger", { currency: "USD" })).entryCount, 0);
  const again = await call(s, "stage_statement", { ...c, fileId: file.fileId });
  await call(s, "set_import_mapping", { ...c, importId: again.importId, mapping });
  await call(s, "cancel_import", { ...c, importId: again.importId });
  await assert.rejects(
    call(s, "preview_import", { ...c, expectedRevision: 2, importId: again.importId }),
    /editable/,
  );
});
test("correcting an approved draft invalidates its frozen preview; foreign handles are hidden", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  const file = await s.upload(
    agent,
    "INR",
    "test.csv",
    "text/csv",
    Buffer.from("Date,Amount,Description\n2026-10-01,-1.00,Synthetic"),
  );
  await assert.rejects(
    call(s, "get_file", { ...c, fileId: file.fileId }, { ...agent, actorId: "foreign-agent" }),
    /not found/,
  );
  const draft = await call(s, "stage_statement", { ...c, fileId: file.fileId });
  await call(s, "set_import_mapping", {
    ...c,
    importId: draft.importId,
    mapping: {
      dateColumn: 0,
      descriptionColumn: 2,
      currencyColumn: null,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 1, positiveAmounts: "income" },
    },
  });
  const preview = await call(s, "preview_import", {
    ...c,
    expectedRevision: 0,
    importId: draft.importId,
  });
  const approvalId = await approve(s, preview);
  await call(s, "correct_import_rows", {
    ...c,
    importId: draft.importId,
    corrections: [{ rowNumber: 2, values: ["2026-10-01", "-2.00", "Changed"] }],
  });
  await assert.rejects(
    call(s, "commit_import", { ...c, expectedRevision: 0, planId: preview.planId, approvalId }),
    /cannot be committed/,
  );
});
test("private exports, backup restore, pre-restore backup, raw recovery and currency mismatches", async () => {
  const s = fixture();
  const c = { currency: "INR" };
  await call(s, "create_transaction", { ...c, expectedRevision: 0, transaction: tx });
  for (const tool of ["export_transactions_csv", "export_monthly_pdf", "export_backup"]) {
    const result = await call(s, tool, {
      ...c,
      ...(tool === "export_monthly_pdf" ? { month: "2026-10" } : {}),
    });
    await call(s, "get_file", { ...c, fileId: result.fileId });
    const download = await s.download(agent, "INR", result.fileId);
    assert.ok(download.bytes.length > 10);
    if (tool === "export_monthly_pdf")
      assert.equal(download.bytes.toString("ascii", 0, 5), "%PDF-");
    if (tool === "export_backup") {
      const upload = await s.upload(
        agent,
        "INR",
        "backup.json",
        "application/json",
        download.bytes,
      );
      await call(s, "create_transaction", { ...c, expectedRevision: 1, transaction: tx });
      const preview = await call(s, "preview_restore", {
        ...c,
        expectedRevision: 2,
        fileId: upload.fileId,
      });
      const restored = await call(s, "commit_restore", {
        ...c,
        expectedRevision: 2,
        planId: preview.planId,
        approvalId: await approve(s, preview),
      });
      assert.ok(restored.backupFileId);
      assert.equal((await call(s, "get_ledger", c)).entryCount, 1);
      const mismatch = await s.upload(agent, "USD", "inr.json", "application/json", download.bytes);
      await assert.rejects(
        call(s, "preview_restore", {
          currency: "USD",
          expectedRevision: 0,
          fileId: mismatch.fileId,
        }),
        /this currency/,
      );
      await call(s, "export_raw_recovery", { ...c, fileId: upload.fileId });
    }
  }
});
test("AI stays unconfigured, synthetic provider needs approval, bounded aggregates redact names, cancellation survives retries", async () => {
  const env = {
    TALLY_AI_PROVIDER: "deepseek",
    TALLY_AI_MODEL: "synthetic",
    TALLY_AI_API_KEY: "synthetic-test-not-a-credential",
  };
  const pending: Array<{ resolve: (value: string) => void }> = [];
  let shared: any;
  let calls = 0;
  const provider: ConstructorParameters<typeof AgentToolService>[2] = async (input, signal) => {
    calls += 1;
    shared = input;
    return new Promise<string>((resolve, reject) => {
      pending.push({ resolve });
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const s = fixture(env, provider);
  const c = { currency: "INR" };
  await call(s, "set_savings_goal", {
    ...c,
    month: "2026-10",
    expectedRevision: 0,
    name: "PRIVATE GOAL",
    targetMinor: 10000,
  });
  await call(s, "create_transaction", {
    ...c,
    expectedRevision: 1,
    transaction: { ...tx, note: "PRIVATE DESCRIPTION" },
  });
  const context = await call(s, "create_analysis_context", {
    ...c,
    month: "2026-10",
    question: "How much did I spend?",
  });
  assert.ok(!JSON.stringify(context).includes("PRIVATE"));
  const args = {
    ...c,
    contextId: context.contextId,
    question: "How much did I spend?",
    approvalId: "no-consent",
  };
  await assert.rejects(call(s, "ask_spending_question", args), /must approve/);
  args.approvalId = await approve(s, context);
  const job = await call(s, "ask_spending_question", args, agent, "synthetic-ai-once");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(shared.summary.remainingCents, -1200);
  assert.ok(!JSON.stringify(shared).includes("PRIVATE"));
  assert.equal(
    (await call(s, "get_ai_request", { ...c, requestId: job.requestId })).status,
    "pending",
  );
  assert.equal(
    (await call(s, "cancel_ai_request", { ...c, requestId: job.requestId })).status,
    "cancelled",
  );
  await call(s, "ask_spending_question", args, agent, "synthetic-ai-once");
  assert.equal(calls, 1);
  pending[0].resolve("Late synthetic answer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await call(s, "get_ai_request", { ...c, requestId: job.requestId })).status,
    "cancelled",
  );
  const unconfigured = fixture();
  await assert.rejects(call(unconfigured, "ask_spending_question", { ...args }), /not configured/);
});
test("every legacy budget tool has an exercised implementation", () => {
  assert.deepEqual(
    Object.keys(legacyCatalog).filter((t) => !exercised.has(t.slice(6))),
    [],
  );
  assert.ok(ToolError);
});
