import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore, type Principal } from "./store.ts";
import { scopes, catalog } from "./catalog.ts";
import { prepareAccount, applyAccountingChange, emptyAccounting } from "../accounting.ts";
const p: Principal = {
  ownerId: "synthetic-phase-b",
  actorId: "synthetic-agent",
  role: "agent",
  currencies: ["INR", "USD"],
  scopes: scopes.filter((s) => s !== "owner:approve"),
  expiresAt: Date.now() + 3600000,
};
const human: Principal = { ...p, actorId: "synthetic-human", role: "owner", scopes };
let sequence = 0;
async function fixture() {
  const store = new MemoryWorkspaceStore();
  const service = new AgentToolService(store, { TALLY_STATEMENTS_ENABLED: "true" });
  const ids = await store.transaction(p.ownerId, async (w) => {
    const l = w.ledgers.INR;
    l.accounting = emptyAccounting();
    for (const [name, type, balance] of [
      ["Bank", "bank", 10000],
      ["Card", "credit_card", 1000],
    ] as const)
      applyAccountingChange(
        l.accounting,
        prepareAccount(
          l.accounting,
          "INR",
          {
            name,
            type,
            opening: { date: "2026-10-01", timing: "start_of_day", balanceMinor: balance },
          },
          p.actorId,
        ),
        l.categories,
      );
    return l.accounting.accounts.map((a) => a.id);
  });
  async function call(tool: string, args: Record<string, unknown> = {}, key?: string) {
    const r = await service.execute(p, {
      version: 2,
      tool: `tally_${tool}`,
      args,
      ...(catalog[`tally_${tool}`].effect !== "read"
        ? { idempotencyKey: key ?? `phase-b-key-${++sequence}` }
        : {}),
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("Unexpected failure");
    return r.result as Record<string, any>;
  }
  const revision = async () => Number((await call("get_ledger", { currency: "INR" })).revision);
  async function commit(
    preview: Record<string, any>,
    tool = "commit_statement_changes",
    key?: string,
  ) {
    const approval = await call("request_approval", { currency: "INR", planId: preview.planId });
    await assert.rejects(
      service.decide(p, approval.approvalId, preview.previewHash, true),
      /does not allow|agent/,
    );
    await service.decide(human, approval.approvalId, preview.previewHash, true);
    const args = {
      currency: "INR",
      expectedRevision: preview.revision,
      planId: preview.planId,
      approvalId: approval.approvalId,
    };
    return { result: await call(tool, args, key), args };
  }
  async function stage(
    accountId: string,
    text: string,
    closingMinor: number,
    name = "fixture.csv",
  ) {
    const file = await service.upload(p, "INR", name, "text/csv", Buffer.from(text));
    const staged = await call("stage_account_statement", {
      currency: "INR",
      expectedRevision: await revision(),
      fileId: file.fileId,
      accountId,
      periodFrom: "2026-10-02",
      periodTo: "2026-10-31",
      closingMinor,
      closingTiming: "end_of_day",
    });
    const mapped = await call("revise_account_statement", {
      currency: "INR",
      expectedRevision: await revision(),
      statementId: staged.statementId,
      mapping: {
        dateColumn: 0,
        descriptionColumn: 1,
        currencyColumn: null,
        dateFormat: "auto",
        amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
        referenceColumn: 3,
      },
      reason: "Explicit signed convention: credit increases bank assets and reduces card debt.",
    });
    return {
      id: mapped.statementId,
      source: staged.sourceFileId,
      rows: (
        await call("get_account_statement", { currency: "INR", statementId: mapped.statementId })
      ).items,
    };
  }
  return { store, service, ids, call, revision, commit, stage };
}
test("Phase B is off by default and discovery leaves the 83-tool foundation available", async () => {
  const s = new AgentToolService(new MemoryWorkspaceStore());
  const r = await s.execute(p, { version: 2, tool: "tally_get_capabilities", args: {} });
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.result.tools as unknown[]).length, 83);
  await assert.rejects(
    s.execute(p, { version: 2, tool: "tally_list_account_statements", args: { currency: "INR" } }),
    /activation/,
  );
});
test("identical legitimate rows survive; reviewed source bytes persist; exact retry posts once; discrepant closes never plug", async () => {
  const f = await fixture(),
    bank = f.ids[0];
  const staged = await f.stage(
    bank,
    "Date,Description,Amount,Reference\n2026-10-03,Cafe,-5.00,one\n2026-10-03,Cafe,-5.00,two",
    9000,
  );
  const decisions = staged.rows.map((o: any) => ({
    action: "create",
    observationIds: [o.id],
    event: {
      kind: "expense",
      accountId: bank,
      date: o.date,
      allocations: [{ categoryId: "expense:Personal", amountMinor: 500 }],
      note: "Reviewed cafe",
    },
    reason: "Distinct references are separate purchases",
  }));
  const preview = await f.call("prepare_statement_changes", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementIds: [staged.id],
    decisions,
  });
  assert.equal(preview.review.change.events.length, 2);
  assert.equal(preview.review.positionAfter.assetsMinor, 9000);
  const committed = await f.commit(preview, "commit_statement_changes", "exact-commit-key");
  await f.call("commit_statement_changes", committed.args, "exact-commit-key");
  let coverage = await f.call("get_statement_coverage", {
    currency: "INR",
    accountId: bank,
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.deepEqual(coverage.gaps, [{ from: "2026-10-01", to: "2026-10-01" }]);
  assert.equal(coverage.statements[0].reconciliation.status, "matched");
  await f.store.transaction(p.ownerId, async (w) => {
    assert.equal(w.ledgers.INR.accounting!.events.filter((e) => e.kind === "expense").length, 2);
    assert.equal(w.ledgers.INR.statements!.files.length, 1);
    for (const file of Object.values(w.files)) file.expiresAt = 1;
  });
  const download = await f.call("get_statement_source", {
    currency: "INR",
    sourceFileId: staged.source,
  });
  assert.ok(download.fileId);
  const wrong = await f.stage(
    bank,
    "Date,Description,Amount,Reference\n2026-10-03,Cafe,-5.00,one",
    12345,
  );
  const link = await f.call("get_statement_matches", { currency: "INR", statementId: wrong.id });
  const eventId = link.items[0].candidates[0].eventId;
  const linked = await f.call("prepare_statement_changes", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementIds: [wrong.id],
    decisions: [
      {
        action: "link",
        observationIds: [wrong.rows[0].id],
        eventId,
        reason: "Overlapping evidence of a previously reviewed purchase",
      },
    ],
  });
  await f.commit(linked);
  const rec = await f.call("prepare_statement_reconciliation", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementId: wrong.id,
  });
  assert.equal(rec.review.snapshot.differenceMinor, 3345);
  assert.equal(rec.review.snapshot.status, "discrepancy");
  assert.equal(rec.review.change.events.length, 0);
  await f.commit(rec, "commit_statement_reconciliation");
  coverage = await f.call("get_statement_coverage", {
    currency: "INR",
    accountId: bank,
    from: "2026-10-02",
    to: "2026-10-31",
  });
  assert.equal(coverage.history.length, 1);
  const revised = await f.call("revise_account_statement", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementId: wrong.id,
    mapping: {
      dateColumn: 0,
      descriptionColumn: 1,
      currencyColumn: null,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
      referenceColumn: 3,
    },
    metadata: { closingMinor: 9000 },
    reason: "Corrected closing observation; retain reviewed source cells",
  });
  const recomputed = await f.call("get_statement_coverage", {
    currency: "INR",
    accountId: bank,
    from: "2026-10-02",
    to: "2026-10-31",
  });
  const current = recomputed.statements.find(
    (st: any) => st.statementId === revised.statementId,
  ).reconciliation;
  assert.equal(current.differenceMinor, 0);
  assert.equal(current.status, "incomplete");
  assert.equal(current.unobservedEventIds.length, 1);
  assert.equal(
    (await f.call("get_account_statement", { currency: "INR", statementId: revised.statementId }))
      .items[0].decision.disposition,
    "linked",
  );
});
test("bank/card counterparts link to one settlement across different booking dates", async () => {
  const f = await fixture();
  const bank = await f.stage(
    f.ids[0],
    "Date,Description,Amount,Reference\n2026-10-05,Card payment,-4.00,b1",
    9600,
  );
  const card = await f.stage(
    f.ids[1],
    "Date,Description,Amount,Reference\n2026-10-06,Payment,4.00,c1",
    600,
  );
  const preview = await f.call("prepare_statement_changes", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementIds: [bank.id, card.id],
    decisions: [
      {
        action: "create",
        observationIds: [bank.rows[0].id, card.rows[0].id],
        event: {
          kind: "card_payment",
          fromAccountId: f.ids[0],
          toAccountId: f.ids[1],
          date: "2026-10-05",
          amountMinor: 400,
        },
        reason: "Same payment: use the bank booking date; preserve card date in its source.",
      },
    ],
  });
  await f.commit(preview);
  const report = await f.call("get_income_expense_report", {
    currency: "INR",
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.equal(report.expenseMinor, 0);
  const matches = await f.call("get_statement_matches", { currency: "INR", statementId: card.id });
  assert.equal(matches.items[0].decision.disposition, "linked");
  await assert.rejects(
    f.call("prepare_statement_changes", {
      currency: "INR",
      expectedRevision: await f.revision(),
      statementIds: [card.id],
      decisions: [
        {
          action: "create",
          observationIds: [card.rows[0].id],
          event: {
            kind: "income",
            accountId: f.ids[0],
            date: "2026-10-06",
            allocations: [{ categoryId: "income:Salary", amountMinor: 400 }],
          },
          reason: "Wrong duplicate",
        },
      ],
    }),
    /already reviewed/,
  );
});
test("source correction invalidates a frozen plan without rewriting original evidence", async () => {
  const f = await fixture(),
    bank = f.ids[0];
  const st = await f.stage(
    bank,
    "Date,Description,Amount,Reference\n2026-10-03,Purchase,-5.00,one",
    9500,
  );
  const pre = await f.call("prepare_statement_changes", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementIds: [st.id],
    decisions: [{ action: "exclude", observationIds: [st.rows[0].id], reason: "Review pending" }],
  });
  const a = await f.call("request_approval", { currency: "INR", planId: pre.planId });
  await f.call("revise_account_statement", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementId: st.id,
    mapping: {
      dateColumn: 0,
      descriptionColumn: 1,
      currencyColumn: null,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
      referenceColumn: 3,
    },
    corrections: [{ rowNumber: 2, values: ["2026-10-03", "Purchase", "-6.00", "one"] }],
    reason: "Corrected selected source cells; original bytes retained",
  });
  await assert.rejects(
    f.service.decide(human, a.approvalId, pre.previewHash, true),
    /stale|changed/,
  );
  await f.store.transaction(p.ownerId, async (w) => {
    assert.equal(w.ledgers.INR.statements!.observations[0].movementMinor, -500);
    assert.equal(w.ledgers.INR.statements!.observations[1].movementMinor, -600);
  });
});
test("reviewed migration cutoff preserves history and removes converted shared entries from legacy totals", async () => {
  const f = await fixture();
  await f.store.transaction(p.ownerId, async (w) => {
    w.ledgers.INR.data.transactions = [
      {
        id: "before",
        kind: "expense",
        date: "2026-09-30",
        category: "Personal",
        amountCents: 500,
        note: "Historical",
        createdAt: 1,
        sample: false,
      },
      {
        id: "after",
        kind: "expense",
        date: "2026-10-03",
        category: "Personal",
        amountCents: 500,
        note: "Post opening",
        createdAt: 1,
        sample: false,
      },
    ];
  });
  const staged = await f.call("stage_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
  });
  const preview = await f.call("prepare_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
    batchId: staged.batchId,
    decisions: [
      {
        action: "cutoff",
        legacyIds: ["before"],
        accountId: f.ids[0],
        reason: "Already included in reviewed opening",
      },
      {
        action: "convert",
        legacyIds: ["after"],
        event: {
          kind: "expense",
          accountId: f.ids[0],
          date: "2026-10-03",
          allocations: [{ categoryId: "expense:Personal", amountMinor: 500 }],
        },
        reason: "Explicit bank mapping",
      },
    ],
  });
  await f.commit(preview, "commit_legacy_migration");
  assert.equal((await f.call("list_legacy_migrations", { currency: "INR" })).items[0].decided, 2);
  const original = await f.call("get_legacy_migration", {
    currency: "INR",
    batchId: staged.batchId,
  });
  assert.equal(original.items.length, 2);
  assert.equal(original.items[0].decision.disposition, "cutoff");
  const again = await f.call("prepare_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
    batchId: staged.batchId,
    decisions: [],
  });
  assert.equal(again.review.change.events.length, 0);
  assert.equal((await f.call("list_transactions", { currency: "INR" })).total, 0);
  assert.equal(
    (
      await f.call("get_account_balance", {
        currency: "INR",
        accountId: f.ids[0],
        asOf: "2026-10-31",
      })
    ).balanceMinor,
    9500,
  );
  await f.store.transaction(p.ownerId, async (w) =>
    assert.equal(w.ledgers.USD.data.transactions.length, 0),
  );
});
test("all four additive migrations parse in disposable embedded PostgreSQL", async () => {
  const db = new PGlite();
  try {
    for (const file of [
      "0001_workspace.sql",
      "0002_accounting.sql",
      "0003_opening_corrections.sql",
      "0004_statements.sql",
    ])
      await db.exec(
        await readFile(new URL(`../../../migrations/agent-tools/${file}`, import.meta.url), "utf8"),
      );
    const rows = await db.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name LIKE 'tally_%'",
    );
    assert.equal((rows.rows[0] as any).count, 11);
  } finally {
    await db.close();
  }
});
test("normalized SQL store retains sources/journals after reopening and rejects source rewrites transactionally", async () => {
  const { PostgresWorkspaceStore } = await import("./store.server.ts");
  const db = new PGlite();
  try {
    for (const file of [
      "0001_workspace.sql",
      "0002_accounting.sql",
      "0003_opening_corrections.sql",
      "0004_statements.sql",
    ])
      await db.exec(
        await readFile(new URL(`../../../migrations/agent-tools/${file}`, import.meta.url), "utf8"),
      );
    const client = {
      query: async (sql: string, args?: unknown[]) => db.query(sql, args),
      release: () => {},
    };
    const pool = { connect: async () => client } as unknown as import("pg").Pool;
    let store = new PostgresWorkspaceStore(pool, true);
    const accountId = await store.transaction(p.ownerId, async (w) => {
      const l = w.ledgers.INR;
      l.accounting ??= emptyAccounting();
      const change = prepareAccount(
        l.accounting,
        "INR",
        {
          name: "Database fixture",
          type: "bank",
          opening: { date: "2026-10-01", timing: "start_of_day", balanceMinor: 1000 },
        },
        p.actorId,
      );
      applyAccountingChange(l.accounting, change, l.categories);
      return change.account!.id;
    });
    let s = new AgentToolService(store, { TALLY_STATEMENTS_ENABLED: "true" });
    async function call(
      tool: string,
      args: Record<string, unknown>,
      key = `sql-phase-b-${++sequence}`,
    ) {
      const r = await s.execute(p, {
        version: 2,
        tool: `tally_${tool}`,
        args,
        ...(catalog[`tally_${tool}`].effect !== "read" ? { idempotencyKey: key } : {}),
      });
      if (!r.ok) throw new Error("Failure");
      return r.result as Record<string, any>;
    }
    const rev = async () => Number((await call("get_ledger", { currency: "INR" })).revision);
    const text = "Date,Description,Amount,Reference\n2026-10-03,Database purchase,-2.00,sql-one";
    const file = await s.upload(p, "INR", "sql.csv", "text/csv", Buffer.from(text));
    const staged = await call("stage_account_statement", {
      currency: "INR",
      expectedRevision: await rev(),
      fileId: file.fileId,
      accountId,
      periodFrom: "2026-10-02",
      periodTo: "2026-10-31",
      closingMinor: 800,
    });
    const mapped = await call("revise_account_statement", {
      currency: "INR",
      expectedRevision: await rev(),
      statementId: staged.statementId,
      mapping: {
        dateColumn: 0,
        descriptionColumn: 1,
        currencyColumn: null,
        dateFormat: "auto",
        amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
        referenceColumn: 3,
      },
      reason: "Reviewed SQL fixture mapping",
    });
    const row = (
      await call("get_account_statement", { currency: "INR", statementId: mapped.statementId })
    ).items[0];
    const preview = await call("prepare_statement_changes", {
      currency: "INR",
      expectedRevision: await rev(),
      statementIds: [mapped.statementId],
      decisions: [
        {
          action: "create",
          observationIds: [row.id],
          event: {
            kind: "expense",
            accountId,
            date: row.date,
            allocations: [{ categoryId: "expense:Personal", amountMinor: 200 }],
          },
          reason: "Reviewed source classification",
        },
      ],
    });
    const approval = await call("request_approval", { currency: "INR", planId: preview.planId });
    await s.decide(human, approval.approvalId, preview.previewHash, true);
    const args = {
      currency: "INR",
      expectedRevision: preview.revision,
      planId: preview.planId,
      approvalId: approval.approvalId,
    };
    await call("commit_statement_changes", args, "sql-fixed-commit");
    store = new PostgresWorkspaceStore(pool, true);
    s = new AgentToolService(store, { TALLY_STATEMENTS_ENABLED: "true" });
    await call("commit_statement_changes", args, "sql-fixed-commit");
    assert.equal(
      (await call("get_account_balance", { currency: "INR", accountId, asOf: "2026-10-31" }))
        .balanceMinor,
      800,
    );
    const source = await call("get_statement_source", {
      currency: "INR",
      sourceFileId: staged.sourceFileId,
    });
    assert.equal((await s.download(p, "INR", source.fileId)).bytes.toString(), text);
    await assert.rejects(
      store.transaction(p.ownerId, async (w) => {
        w.ledgers.INR.statements!.files[0].name = "rewritten.csv";
      }),
      /immutable/,
    );
    await store.transaction(p.ownerId, async (w) => {
      assert.equal(w.ledgers.INR.statements!.files[0].name, "sql.csv");
      assert.equal(w.ledgers.INR.statements!.decisions.length, 1);
      assert.equal(w.ledgers.INR.accounting!.events.length, 2);
    });
  } finally {
    await db.close();
  }
});
test("explicit unassigned legacy mappings can be completed later without deleting their review history", async () => {
  const f = await fixture();
  await f.store.transaction(p.ownerId, async (w) => {
    w.ledgers.INR.data.transactions = [
      {
        id: "waiting",
        kind: "expense",
        date: "2026-10-03",
        category: "Personal",
        amountCents: 200,
        note: "Awaiting account mapping",
        createdAt: 1,
        sample: false,
      },
    ];
  });
  const batch = await f.call("stage_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
  });
  let preview = await f.call("prepare_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
    batchId: batch.batchId,
    decisions: [
      { action: "unassigned", legacyIds: ["waiting"], reason: "No account selected yet" },
    ],
  });
  await f.commit(preview, "commit_legacy_migration");
  preview = await f.call("prepare_legacy_migration", {
    currency: "INR",
    expectedRevision: await f.revision(),
    batchId: batch.batchId,
    decisions: [
      {
        action: "convert",
        legacyIds: ["waiting"],
        event: {
          kind: "expense",
          accountId: f.ids[0],
          date: "2026-10-03",
          allocations: [{ categoryId: "expense:Personal", amountMinor: 200 }],
        },
        reason: "User explicitly selected the bank account",
      },
    ],
  });
  await f.commit(preview, "commit_legacy_migration");
  assert.equal(
    (await f.call("get_legacy_migration", { currency: "INR", batchId: batch.batchId })).items[0]
      .decision.disposition,
    "converted",
  );
  await f.store.transaction(p.ownerId, async (w) =>
    assert.equal(w.ledgers.INR.statements!.legacyDecisions.length, 2),
  );
});
test("raw cells and mapped observations paginate completely; a changed revision rejects old page cursors", async () => {
  const f = await fixture();
  const text = [
    "Date,Description,Amount,Reference",
    ...Array.from(
      { length: 201 },
      (_, i) => `2026-10-03,Repeated legitimate purchase,-1.00,ref-${i}`,
    ),
  ].join("\n");
  const file = await f.service.upload(p, "INR", "pages.csv", "text/csv", Buffer.from(text));
  const staged = await f.call("stage_account_statement", {
    currency: "INR",
    expectedRevision: await f.revision(),
    fileId: file.fileId,
    accountId: f.ids[0],
    periodFrom: "2026-10-02",
    periodTo: "2026-10-31",
  });
  const first = await f.call("get_account_statement", {
    currency: "INR",
    statementId: staged.statementId,
    limit: 100,
  });
  assert.equal(first.sourceMode, "raw");
  assert.equal(first.total, 201);
  assert.equal(first.items[0].unmapped, true);
  assert.equal(first.items[0].values[3], "ref-0");
  assert.equal(first.items[0].id, undefined);
  const second = await f.call("get_account_statement", {
    currency: "INR",
    statementId: staged.statementId,
    limit: 100,
    cursor: first.nextCursor,
  });
  const third = await f.call("get_account_statement", {
    currency: "INR",
    statementId: staged.statementId,
    limit: 100,
    cursor: second.nextCursor,
  });
  assert.equal(second.items[0].rowNumber, 102);
  assert.equal(third.items.length, 1);
  assert.equal(third.items[0].rowNumber, 202);
  assert.equal(third.nextCursor, null);
  const mapped = await f.call("revise_account_statement", {
    currency: "INR",
    expectedRevision: await f.revision(),
    statementId: staged.statementId,
    mapping: {
      dateColumn: 0,
      descriptionColumn: 1,
      currencyColumn: null,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
      referenceColumn: 3,
    },
    reason: "Explicit reviewed mapping",
  });
  await assert.rejects(
    f.call("get_account_statement", {
      currency: "INR",
      statementId: staged.statementId,
      limit: 100,
      cursor: first.nextCursor,
    }),
    /superseded/,
  );
  const page = await f.call("get_account_statement", {
    currency: "INR",
    statementId: mapped.statementId,
    limit: 100,
  });
  assert.equal(page.sourceMode, "observations");
  assert.equal(page.total, 201);
  assert.ok(page.items.every((o: any) => o.id && o.movementMinor === -100));
  await f.call("stage_legacy_migration", { currency: "INR", expectedRevision: await f.revision() });
  await assert.rejects(
    f.call("get_account_statement", {
      currency: "INR",
      statementId: mapped.statementId,
      limit: 100,
      cursor: page.nextCursor,
    }),
    /changed/,
  );
});
