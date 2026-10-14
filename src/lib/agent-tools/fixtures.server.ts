import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore } from "./store.ts";
/** Imported only by the development-only synthetic QA branch. Never a production fallback. */
export async function syntheticQaService() {
  const store = new MemoryWorkspaceStore();
  await store.transaction("synthetic-owner", async (w) => {
    const ledger = w.ledgers.INR;
    ledger.categories.push({
      id: "synthetic-pets",
      name: "Pets",
      kind: "expense",
      archived: false,
      builtIn: false,
    });
    ledger.data.transactions = [
      {
        id: "synthetic-pay",
        kind: "income",
        amountCents: 9500000,
        category: "Pay",
        note: "Synthetic monthly pay",
        date: "2026-10-01",
        createdAt: 1,
        sample: false,
      },
      {
        id: "synthetic-rent",
        kind: "expense",
        amountCents: 2400000,
        category: "Housing",
        note: "Synthetic rent",
        date: "2026-10-02",
        createdAt: 2,
        sample: false,
      },
      {
        id: "synthetic-groceries",
        kind: "expense",
        amountCents: 432000,
        category: "Groceries",
        note: "Synthetic weekly groceries",
        date: "2026-10-10",
        createdAt: 3,
        sample: false,
      },
      {
        id: "synthetic-pets-entry",
        kind: "expense",
        amountCents: 185000,
        category: "Pets",
        note: "Synthetic pet supplies",
        date: "2026-10-12",
        createdAt: 4,
        sample: false,
      },
    ];
    ledger.data.settingsByMonth["2026-10"] = {
      goalName: "Rainy-day fund",
      goalTargetCents: 2000000,
      categoryBudgets: { Housing: 2400000, Groceries: 800000, Pets: 250000 },
    };
  });
  const environment = {
    TALLY_AI_PROVIDER: "deepseek",
    TALLY_AI_MODEL: "synthetic-fixture",
    TALLY_AI_API_KEY: "synthetic-test-not-a-real-credential",
  };
  return new AgentToolService(store, environment, async (_input, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    return "Synthetic QA response: this is a local test fixture, not a provider answer.";
  });
}
