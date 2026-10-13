import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetStatus,
  defaultMonthlySettings,
  formatMoney,
  loadBudget,
  makeBackup,
  monthKey,
  parseBackup,
  parseMoneyToCents,
  saveBudget,
  settingsForMonth,
  type BudgetData,
  type Currency,
} from "./budget.ts";

function withStorage(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, String(value)),
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  return items;
}

function sampleLedger(currency: Currency = "INR"): BudgetData {
  return {
    currency,
    transactions: [
      {
        id: "one",
        kind: "expense",
        amountCents: 1001,
        category: "Groceries",
        note: "fixture only",
        date: "2026-10-02",
        createdAt: 100,
        sample: false,
      },
    ],
    settingsByMonth: {
      "2026-10": {
        ...defaultMonthlySettings(currency),
        categoryBudgets: { Groceries: 5000 },
      },
    },
    sample: false,
  };
}

test("money parsing preserves integer paise/cents and currency formatting", () => {
  assert.equal(parseMoneyToCents("₹1,234.56"), 123456);
  assert.equal(parseMoneyToCents("$0.01"), 1);
  assert.equal(parseMoneyToCents("1.001"), null);
  assert.equal(parseMoneyToCents("0"), null);
  assert.equal(formatMoney(123456, "INR"), "₹1,234.56");
  assert.equal(formatMoney(123456, "USD"), "$1,234.56");
});

test("category thresholds treat 80%, exactly 100%, over, and no-limit safely", () => {
  assert.equal(budgetStatus(79, 100), "under");
  assert.equal(budgetStatus(80, 100), "near");
  assert.equal(budgetStatus(99, 100), "near");
  assert.equal(budgetStatus(100, 100), "at");
  assert.equal(budgetStatus(101, 100), "over");
  assert.equal(budgetStatus(100, undefined), "no-limit");
  assert.equal(budgetStatus(100, 0), "no-limit");
});

test("new browser data defaults to the INR ledger", () => {
  withStorage(() => {
    const result = loadBudget(new Date("2026-10-12T12:00:00Z"));
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.data.currency, "INR");
      assert.equal(result.data.settingsByMonth["2026-10"]?.goalTargetCents, 4_000_000);
    }
  });
});

test("legacy untagged storage migrates to USD without changing amounts and keeps the source copy", () => {
  const items = withStorage(() => {});
  items.set(
    "tally.budget.v1",
    JSON.stringify({
      transactions: [
        {
          id: "legacy",
          kind: "expense",
          amountCents: 12345,
          category: "Dining",
          note: "old amount",
          date: "2026-09-04",
          createdAt: 10,
          sample: false,
        },
      ],
      goalName: "Old goal",
      goalTargetCents: 56789,
      sample: false,
    }),
  );
  const legacyRaw = items.get("tally.budget.v1");
  let result!: ReturnType<typeof loadBudget>;
  // Install the same map into this test's localStorage instance.
  withStorage(() => {
    localStorage.setItem("tally.budget.v1", legacyRaw ?? "");
    result = loadBudget(new Date("2026-10-12T12:00:00Z"));
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.equal(result.data.currency, "USD");
      assert.equal(result.data.transactions[0]?.amountCents, 12345);
      assert.equal(result.data.settingsByMonth["2026-09"]?.goalTargetCents, 56789);
      assert.equal(result.data.settingsByMonth["2026-10"]?.goalName, "Old goal");
    }
    assert.equal(localStorage.getItem("tally.budget.v1"), legacyRaw);
  });
});

test("currency switching uses separate storage records rather than relabeling or adding entries", () => {
  withStorage(() => {
    const inr = sampleLedger("INR");
    saveBudget(inr);
    const usd = loadBudget(new Date("2026-10-12T12:00:00Z"), "USD");
    assert.equal(usd.status, "ready");
    if (usd.status === "ready") {
      assert.equal(usd.data.currency, "USD");
      assert.notEqual(usd.data.transactions[0]?.amountCents, 1001);
      saveBudget(usd.data);
    }
    const restoredInr = loadBudget(new Date("2026-10-12T12:00:00Z"), "INR");
    assert.equal(restoredInr.status, "ready");
    if (restoredInr.status === "ready") assert.equal(restoredInr.data.transactions[0]?.amountCents, 1001);
  });
});

test("month settings are isolated and unset months use currency-specific defaults", () => {
  const data = sampleLedger("INR");
  assert.equal(settingsForMonth(data, "2026-10").categoryBudgets.Groceries, 5000);
  assert.equal(settingsForMonth(data, "2026-11").categoryBudgets.Groceries, undefined);
  assert.equal(settingsForMonth(data, "2026-11").goalTargetCents, 4_000_000);
  assert.equal(monthKey(new Date("2026-10-01T12:00:00Z")), "2026-10");
});

test("malformed saved JSON is returned for recovery and is never replaced by seed data", () => {
  withStorage(() => {
    localStorage.setItem("tally.budget.v2.INR", "{broken ledger");
    const result = loadBudget(new Date("2026-10-12T12:00:00Z"));
    assert.equal(result.status, "error");
    assert.equal(localStorage.getItem("tally.budget.v2.INR"), "{broken ledger");
  });
});

test("browser storage write failures are surfaced to the caller", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === "tally.budget.v2.INR") throw new Error("synthetic quota exceeded");
        saved.set(key, String(value));
      },
    },
  });
  try {
    assert.throws(() => saveBudget(sampleLedger()), /synthetic quota exceeded/);
    assert.equal(saved.size, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("exported backups restore into the matching currency ledger and reject malformed payloads", () => {
  const data = sampleLedger();
  const backup = makeBackup(data);
  const restored = parseBackup(backup);
  assert.deepEqual(restored, data);
  withStorage(() => {
    saveBudget(restored!);
    const loaded = loadBudget(new Date("2026-10-12T12:00:00Z"), "INR");
    assert.equal(loaded.status, "ready");
    if (loaded.status === "ready") assert.deepEqual(loaded.data, data);
    assert.equal(localStorage.getItem("tally.budget.v2.USD"), null);
  });
  assert.equal(parseBackup('{"format":"other","ledger":{}}'), null);
});
