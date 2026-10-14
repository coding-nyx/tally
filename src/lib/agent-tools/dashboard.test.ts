import assert from "node:assert/strict";
import test from "node:test";
import { readDashboard, dashboardSearch } from "./dashboard.ts";
import { TallyClient } from "./client.ts";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore } from "./store.ts";
import { handleAgentRequest } from "./http.server.ts";
import { syntheticEnvironment, SYNTHETIC_AGENT_TOKEN } from "./test-fixtures.ts";

test("dashboard reads all pages of canonical records and matching settings without browser storage", async (t) => {
  const store = new MemoryWorkspaceStore();
  await store.transaction("synthetic-owner", async (w) => {
    const ledger = w.ledgers.INR;
    ledger.revision = 8;
    ledger.data.transactions = Array.from({ length: 201 }, (_, i) => ({
      id: `synthetic-${i}`,
      kind: "expense",
      amountCents: 1250,
      category: "Personal",
      date: "2026-10-14",
      note: "Synthetic shared dashboard",
      createdAt: i,
      sample: false,
    }));
    ledger.data.settingsByMonth["2026-10"] = {
      goalName: "Shared goal",
      goalTargetCents: 50000,
      categoryBudgets: { Personal: 2000 },
    };
  });
  const service = new AgentToolService(store);
  const env = syntheticEnvironment();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string).tool);
    return handleAgentRequest(new Request(url, init), service, env);
  });
  const snapshot = await readDashboard(
    new TallyClient("http://127.0.0.1:8080/api/agent", SYNTHETIC_AGENT_TOKEN),
    "INR",
    "2026-10",
  );
  assert.equal(snapshot.revision, 8);
  assert.equal(snapshot.data.transactions.length, 201);
  assert.equal(
    snapshot.data.transactions.reduce((n, t) => n + t.amountCents, 0),
    251250,
  );
  assert.equal(snapshot.data.settingsByMonth["2026-10"].goalName, "Shared goal");
  assert.equal(snapshot.data.sample, false);
  assert.equal(calls.filter((n) => n === "tally_list_transactions").length, 3);
  assert.ok(
    calls.every((n) =>
      [
        "tally_get_ledger",
        "tally_list_transactions",
        "tally_list_categories",
        "tally_get_month_settings",
      ].includes(n),
    ),
  );
});
test("dashboard rejects a mixed-revision read rather than showing inconsistent totals", async (t) => {
  const client = new TallyClient("http://127.0.0.1:8080/api/agent");
  let metaCalls = 0;
  t.mock.method(client, "call", async (tool: string) => {
    if (tool === "tally_get_ledger") return { revision: ++metaCalls === 1 ? 1 : 2 };
    if (tool === "tally_list_transactions") return { revision: 1, items: [], nextCursor: null };
    if (tool === "tally_list_categories") return { categories: [], revision: 1 };
    return {
      revision: 1,
      settings: { goalName: "Synthetic", goalTargetCents: 100, categoryBudgets: {} },
    };
  });
  await assert.rejects(readDashboard(client, "INR", "2026-10"), /changed while loading/);
});
test("navigation carries only valid explicit currency, month and section values", () => {
  assert.deepEqual(
    dashboardSearch({ currency: "USD", month: "2026-09", section: "imports", data: "ignored" }),
    { currency: "USD", month: "2026-09", section: "imports" },
  );
  assert.deepEqual(
    dashboardSearch({ currency: "EUR", month: "2026-99", section: "browser-local" }),
    {},
  );
});
