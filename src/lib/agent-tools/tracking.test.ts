import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore, type Principal, type WorkspaceStore } from "./store.ts";
import { scopes } from "./catalog.ts";
import { accountBalance, incomeExpenseReport } from "../accounting.ts";
const p: Principal = {
  ownerId: "synthetic-tracking",
  actorId: "tailnet-shared",
  role: "owner",
  currencies: ["INR", "USD"],
  scopes,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
function fixture(store: WorkspaceStore = new MemoryWorkspaceStore()) {
  let service = new AgentToolService(store, {
    TALLY_AGENT_AUTH_MODE: "tailnet",
    TALLY_STATEMENTS_ENABLED: "true",
  });
  const call = async (
    tool: string,
    args: Record<string, any> = {},
    key = randomUUID(),
    actor = p,
  ) => {
    const r = await service.execute(actor, {
      version: 2,
      tool: `tally_${tool}`,
      args,
      idempotencyKey: key,
    });
    assert.ok(r.ok);
    return r;
  };
  const revision = async () =>
    Number((await call("get_ledger", { currency: "INR" })).result.revision);
  const prepare = async (change: Record<string, any>) =>
    (
      await call("prepare_investment_change", {
        currency: "INR",
        expectedRevision: await revision(),
        change,
      })
    ).result;
  const commitArgs = (v: Record<string, any>) => ({
    currency: "INR",
    expectedRevision: v.revision,
    planId: v.planId,
    previewHash: v.previewHash,
  });
  const commit = async (v: Record<string, any>, key = randomUUID()) =>
    call("commit_investment_change", commitArgs(v), key);
  const portfolio = async (asOf = "2026-10-14") =>
    (await call("get_investment_portfolio", { currency: "INR", asOf })).result as any;
  return {
    store,
    call,
    prepare,
    commit,
    commitArgs,
    revision,
    portfolio,
    restart() {
      service = new AgentToolService(store, {
        TALLY_AGENT_AUTH_MODE: "tailnet",
        TALLY_STATEMENTS_ENABLED: "true",
      });
    },
  };
}
const observation = {
  date: "2026-10-01",
  quantity: "1.125",
  costMinor: 10000,
  valueMinor: 12500,
  note: "Synthetic statement valuation",
};
test("four investment types retain dated corrections; currency, scope, replay and stale previews are enforced", async () => {
  const f = fixture();
  const a = await f.prepare({
    action: "account",
    name: "Synthetic broker",
    institution: "Fixture",
  });
  await f.commit(a);
  const accountId = (await f.portfolio()).accounts[0].id;
  for (const type of ["mutual_fund", "gold", "stock", "recurring_deposit"]) {
    const plan = await f.prepare({
      action: "holding",
      accountId,
      type,
      name: `Synthetic ${type}`,
      valuation: {
        ...observation,
        ...(type === "recurring_deposit"
          ? {
              rd: {
                instalmentMinor: 1000,
                maturityDate: "2027-10-01",
                expectedMaturityMinor: 15000,
              },
            }
          : {}),
      },
    });
    await assert.rejects(
      f.call("commit_investment_change", { ...f.commitArgs(plan), previewHash: "0".repeat(64) }),
      /frozen preview hash/,
    );
    await f.commit(plan);
  }
  const report = await f.portfolio();
  assert.equal(report.valueMinor, 50000);
  assert.equal(report.costMinor, 40000);
  assert.equal(report.gainMinor, 10000);
  const h = report.holdings[0].holding;
  const correction = await f.prepare({
    action: "valuation",
    holdingId: h.id,
    valuation: { ...observation, valueMinor: 13000 },
  });
  const key = randomUUID();
  await f.commit(correction, key);
  f.restart();
  assert.equal((await f.commit(correction, key)).replayed, true);
  assert.equal((await f.portfolio()).valueMinor, 50500);
  const history = (
    await f.call("list_investment_valuations", { currency: "INR", holdingId: h.id, limit: 1 })
  ).result as any;
  assert.equal(history.items[0].valueMinor, 13000);
  assert.ok(history.nextCursor);
  const page2 = (
    await f.call("list_investment_valuations", {
      currency: "INR",
      holdingId: h.id,
      limit: 1,
      cursor: history.nextCursor,
    })
  ).result as any;
  assert.equal(page2.items[0].valueMinor, 12500);
  assert.equal((await f.portfolio("2026-09-30")).valueMinor, null);
  await assert.rejects(
    f.call("prepare_investment_change", {
      currency: "USD",
      expectedRevision: 0,
      change: { action: "valuation", holdingId: h.id, valuation: observation },
    }),
    /active holding/,
  );
  await assert.rejects(
    f.call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" }, randomUUID(), {
      ...p,
      scopes: ["summary:read"],
    }),
    /does not allow/,
  );
  const stale = await f.prepare({ action: "archive_holding", holdingId: h.id, archived: true });
  await f.call("create_transaction", {
    currency: "INR",
    expectedRevision: await f.revision(),
    transaction: {
      kind: "expense",
      amountMinor: 100,
      date: "2026-10-14",
      category: "Personal",
      note: "Synthetic concurrent edit",
    },
  });
  await assert.rejects(f.commit(stale), /revision/);
  assert.equal((await f.portfolio()).holdings[0].holding.archived, false);
  assert.equal(
    (await f.call("get_investment_portfolio", { currency: "USD", asOf: "2026-10-14" })).result
      .valueMinor,
    0,
  );
});
test("RD validation, archive history, and legacy commits preserve the portfolio", async () => {
  const f = fixture();
  await f.commit(await f.prepare({ action: "account", name: "Synthetic RD bank" }));
  const accountId = (await f.portfolio()).accounts[0].id;
  await assert.rejects(
    f.prepare({
      action: "holding",
      accountId,
      type: "recurring_deposit",
      name: "Missing terms",
      valuation: observation,
    }),
    /instalment/,
  );
  await assert.rejects(
    f.prepare({
      action: "holding",
      accountId,
      type: "stock",
      name: "Wrong terms",
      valuation: { ...observation, rd: { instalmentMinor: 100, maturityDate: "2027-01-01" } },
    }),
    /only to recurring deposits/,
  );
  await f.commit(
    await f.prepare({
      action: "holding",
      accountId,
      type: "gold",
      name: "Synthetic gold",
      valuation: observation,
    }),
  );
  const legacy = (
    await f.call("prepare_clear_month", {
      currency: "INR",
      expectedRevision: await f.revision(),
      month: "2026-10",
    })
  ).result;
  await f.call("clear_month", {
    currency: "INR",
    expectedRevision: legacy.revision,
    planId: legacy.planId,
    previewHash: legacy.previewHash,
  });
  assert.equal((await f.portfolio()).valueMinor, 12500);
  await f.commit(await f.prepare({ action: "archive_account", accountId, archived: true }));
  assert.equal((await f.portfolio()).valueMinor, 0);
  assert.equal((await f.portfolio()).holdings.length, 1);
  await f.commit(await f.prepare({ action: "archive_account", accountId, archived: false }));
  assert.equal((await f.portfolio()).valueMinor, 12500);
});
test("card repayments reduce debt and bill dues once; reversal restores them without changing spending", async () => {
  const f = fixture();
  const commitAccount = async (args: Record<string, any>) => {
    const preview = (
      await f.call("prepare_account", {
        currency: "INR",
        expectedRevision: await f.revision(),
        ...args,
      })
    ).result;
    await f.call("commit_account_change", f.commitArgs(preview));
    return (preview.review as any).change.account.id;
  };
  const opening = { date: "2026-10-01", timing: "start_of_day", balanceMinor: 100000 };
  const bank = await commitAccount({
    name: "Synthetic bank",
    type: "bank",
    institution: "Fixture",
    lastFour: "1234",
    opening,
  });
  const card = await commitAccount({
    name: "Synthetic card",
    type: "credit_card",
    opening: { ...opening, balanceMinor: 10000 },
    cardTerms: { creditLimitMinor: 50000 },
  });
  const bill = (
    await f.call("prepare_account_update", {
      currency: "INR",
      expectedRevision: await f.revision(),
      accountId: card,
      cardBill: {
        statementDate: "2026-10-02",
        dueDate: "2026-10-10",
        totalDueMinor: 10000,
        minimumDueMinor: 1000,
      },
    })
  ).result;
  assert.equal((bill.review as any).positionAfter.asOf, "2026-10-02");
  assert.equal(
    (bill.review as any).positionAfter.accounts.find((row: any) => row.account.id === card).card
      .remainingDueMinor,
    10000,
  );
  await f.call("commit_account_change", f.commitArgs(bill));
  const pay = (
    await f.call("prepare_journal_event", {
      currency: "INR",
      expectedRevision: await f.revision(),
      event: {
        kind: "card_payment",
        fromAccountId: bank,
        toAccountId: card,
        amountMinor: 4000,
        date: "2026-10-05",
        note: "Synthetic settlement",
      },
    })
  ).result;
  await f.call("commit_journal_event", f.commitArgs(pay));
  let row = (
    await f.call("get_account_balance", { currency: "INR", accountId: card, asOf: "2026-10-14" })
  ).result as any;
  assert.equal(row.balanceMinor, 6000);
  assert.equal(row.card.remainingDueMinor, 6000);
  assert.equal(row.card.remainingMinimumMinor, 0);
  assert.equal(row.card.availableCreditMinor, 44000);
  assert.equal(row.card.overdue, true);
  const reversal = (
    await f.call("prepare_journal_reversal", {
      currency: "INR",
      expectedRevision: await f.revision(),
      eventId: (pay.review as any).change.event.id,
      date: "2026-10-06",
      note: "Synthetic reversal",
    })
  ).result;
  await f.call("commit_journal_event", f.commitArgs(reversal));
  row = (
    await f.call("get_account_balance", { currency: "INR", accountId: card, asOf: "2026-10-14" })
  ).result as any;
  assert.equal(row.balanceMinor, 10000);
  assert.equal(row.card.remainingDueMinor, 10000);
  assert.equal(row.card.paidSinceStatementMinor, 0);
  await f.store.transaction(p.ownerId, async (w) => {
    assert.equal(
      incomeExpenseReport(w.ledgers.INR.accounting!, "INR", "2026-10-01", "2026-10-14")
        .expenseMinor,
      0,
    );
    assert.equal(
      accountBalance(w.ledgers.INR.accounting!, bank, "2026-10-14").balanceMinor,
      100000,
    );
  });
  await assert.rejects(
    f.call("prepare_account_update", {
      currency: "INR",
      expectedRevision: await f.revision(),
      accountId: bank,
      cardTerms: { creditLimitMinor: 1000 },
    }),
    /only to credit cards/,
  );
  await assert.rejects(
    f.call("prepare_account_update", {
      currency: "INR",
      expectedRevision: await f.revision(),
      accountId: card,
      cardBill: {
        statementDate: "2026-10-14",
        dueDate: "2026-10-01",
        totalDueMinor: 100,
        minimumDueMinor: 101,
      },
    }),
    /bill dates/,
  );
});
test("actual SQL adapter persists portfolios and card metadata atomically across service restart", async () => {
  const db = new PGlite();
  try {
    for (const name of [
      "0001_workspace.sql",
      "0002_accounting.sql",
      "0003_opening_corrections.sql",
      "0004_statements.sql",
    ])
      await db.exec(
        await readFile(new URL(`../../../migrations/agent-tools/${name}`, import.meta.url), "utf8"),
      );
    const client = {
      query: async (sql: string, args?: unknown[]) => db.query(sql, args),
      release() {},
    };
    const pool = { connect: async () => client } as unknown as import("pg").Pool;
    const { PostgresWorkspaceStore } = await import("./store.server.ts");
    let f = fixture(new PostgresWorkspaceStore(pool, true));
    await f.commit(await f.prepare({ action: "account", name: "Synthetic persisted portfolio" }));
    const accountId = (await f.portfolio()).accounts[0].id;
    await f.commit(
      await f.prepare({
        action: "holding",
        accountId,
        type: "mutual_fund",
        name: "Synthetic fund",
        valuation: observation,
      }),
    );
    const card = (
      await f.call("prepare_account", {
        currency: "INR",
        expectedRevision: await f.revision(),
        type: "credit_card",
        name: "Synthetic persisted card",
        cardTerms: { creditLimitMinor: 100000 },
      })
    ).result;
    await f.call("commit_account_change", f.commitArgs(card));
    f = fixture(new PostgresWorkspaceStore(pool, true));
    assert.equal((await f.portfolio()).valueMinor, 12500);
    assert.equal(
      ((await f.call("list_accounts", { currency: "INR" })).result.accounts as any[])[0].cardTerms
        .creditLimitMinor,
      100000,
    );
    const stored = await db.query<{ document: any }>(
      "SELECT document FROM tally_agent_workspaces WHERE owner_id=$1",
      [p.ownerId],
    );
    assert.equal(stored.rows[0].document.ledgers.INR.investments.valuations.length, 1);
    assert.equal(stored.rows[0].document.ledgers.INR.accounting, undefined);
  } finally {
    await db.close();
  }
});
