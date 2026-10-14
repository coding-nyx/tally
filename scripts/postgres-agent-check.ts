import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { PostgresWorkspaceStore } from "../src/lib/agent-tools/store.server.ts";
const url = process.env.TALLY_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== "tally-agent-test-db")
  throw new Error(
    "This check requires the isolated tally-agent-test-db fixture container, never a live database.",
  );
const pool = new Pool({ connectionString: url, max: 4 });
const owner = "synthetic-postgres-owner";
try {
  await pool.query(
    await readFile(
      new URL("../migrations/agent-tools/0001_workspace.sql", import.meta.url),
      "utf8",
    ),
  );
  const first = new PostgresWorkspaceStore(pool);
  const second = new PostgresWorkspaceStore(pool);
  const writes = await Promise.allSettled(
    [first, second].map((store) =>
      store.transaction(owner, async (w) => {
        if (w.ledgers.INR.revision !== 0) throw new Error("synthetic-revision-conflict");
        await new Promise((resolve) => setTimeout(resolve, 20));
        w.ledgers.INR.revision = 1;
        w.ledgers.INR.data.transactions.push({
          id: "synthetic-only",
          kind: "expense",
          category: "Groceries",
          amountCents: 1200,
          date: "2026-10-13",
          note: "Synthetic PostgreSQL fixture",
          sample: false,
          createdAt: 1,
        });
        w.receipts.synthetic = {
          id: "synthetic-op",
          actorId: "synthetic-agent",
          currency: "INR",
          key: "synthetic-fixed-key",
          fingerprint: "synthetic-fingerprint",
          tool: "tally_create_transaction",
          committedAt: 1,
          result: { revision: 1, transactionId: "synthetic-only", committed: true },
        };
      }),
    ),
  );
  assert.equal(writes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(writes.filter((r) => r.status === "rejected").length, 1);
  await assert.rejects(
    first.transaction(owner, async (w) => {
      w.ledgers.INR.revision = 99;
      delete w.receipts.synthetic;
      throw new Error("synthetic rollback");
    }),
    /rollback/,
  );
  await pool.end();
  const restartedPool = new Pool({ connectionString: url, max: 2 });
  try {
    const restarted = new PostgresWorkspaceStore(restartedPool);
    const result = await restarted.transaction(owner, async (w) => {
      assert.equal(w.ledgers.INR.revision, 1);
      assert.equal(w.ledgers.INR.data.transactions.length, 1);
      assert.equal(w.ledgers.USD.revision, 0);
      return w.receipts.synthetic.result;
    });
    assert.deepEqual(result, { revision: 1, transactionId: "synthetic-only", committed: true });
    console.log(
      "PostgreSQL integration passed: independent clients serialize, conflict rollback is atomic, ledger/receipts survive a pool restart, USD remains unchanged.",
    );
  } finally {
    await restartedPool.end();
  }
} finally {
  await pool.end().catch(() => undefined);
}
