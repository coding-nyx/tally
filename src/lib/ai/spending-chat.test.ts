import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpendingSummary,
  spendingChatAvailability,
  spendingChatConfig,
  validateSpendingChatRequest,
} from "./spending-chat.ts";

test("spending chat stays disabled until a provider is deliberately configured", () => {
  assert.deepEqual(spendingChatAvailability(false), {
    state: "unconfigured",
    message: "No AI provider is configured. Chat is disabled and no financial data is being sent.",
  });
  assert.equal(spendingChatConfig({}), null);
  assert.equal(
    spendingChatConfig({ TALLY_AI_PROVIDER: "deepseek", TALLY_AI_MODEL: "deepseek-flash" }),
    null,
  );
  assert.equal(
    spendingChatConfig({
      TALLY_AI_PROVIDER: "openai-compatible",
      TALLY_AI_BASE_URL: "http://example.com",
      TALLY_AI_MODEL: "model",
      TALLY_AI_API_KEY: "secret",
    }),
    null,
  );
  assert.equal(
    spendingChatConfig({
      TALLY_AI_PROVIDER: "openai-compatible",
      TALLY_AI_BASE_URL: "https://api.example.com/v1",
      TALLY_AI_MODEL: "model",
      TALLY_AI_API_KEY: "secret",
    })?.endpoint,
    "https://api.example.com/v1/chat/completions",
  );
  assert.deepEqual(
    spendingChatConfig({
      TALLY_AI_PROVIDER: "deepseek",
      TALLY_AI_MODEL: "deepseek-flash",
      TALLY_AI_API_KEY: "synthetic-key",
    }),
    {
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash",
      apiKey: "synthetic-key",
    },
  );
  assert.equal(
    spendingChatConfig({
      TALLY_AI_PROVIDER: "deepseek",
      TALLY_AI_BASE_URL: "https://example.com",
      TALLY_AI_MODEL: "deepseek-flash",
      TALLY_AI_API_KEY: "synthetic-key",
    }),
    null,
  );
});

test("future AI context contains monthly totals and budgets, not transaction details", () => {
  const summary = buildSpendingSummary(
    {
      currency: "INR",
      sample: false,
      transactions: [
        {
          id: "one",
          kind: "income",
          amountCents: 500_000,
          category: "Pay",
          note: "PRIVATE employer detail",
          date: "2026-10-02",
          createdAt: 1,
          sample: false,
        },
        {
          id: "two",
          kind: "expense",
          amountCents: 12_345,
          category: "Groceries",
          note: "PRIVATE shop detail",
          date: "2026-10-03",
          createdAt: 2,
          sample: false,
        },
        {
          id: "three",
          kind: "expense",
          amountCents: 90_000,
          category: "Housing",
          note: "Different month",
          date: "2026-09-30",
          createdAt: 3,
          sample: false,
        },
      ],
      settingsByMonth: {
        "2026-10": {
          goalName: "Cushion",
          goalTargetCents: 100_000,
          categoryBudgets: { Groceries: 20_000 },
        },
      },
    },
    "2026-10",
  );

  assert.equal(summary.incomeCents, 500_000);
  assert.equal(summary.spendingCents, 12_345);
  assert.equal(summary.remainingCents, 487_655);
  assert.deepEqual(summary.categories, [
    { name: "Groceries", spentCents: 12_345, budgetCents: 20_000 },
  ]);
  assert.equal(JSON.stringify(summary).includes("PRIVATE"), false);
  assert.equal("transactions" in summary, false);
  const valid = validateSpendingChatRequest({ question: "Where did I spend?", summary });
  assert.equal(valid?.summary.month, "2026-10");
  assert.equal(validateSpendingChatRequest({ question: "x".repeat(501), summary }), null);
  assert.equal(
    validateSpendingChatRequest({
      question: "Question",
      summary: {
        ...summary,
        categories: Array(17).fill({ name: "x", spentCents: 1, budgetCents: null }),
      },
    }),
    null,
  );
});

test("overspent months accept a signed remaining balance and reject inconsistent totals", () => {
  const summary = {
    currency: "INR",
    month: "2026-10",
    incomeCents: 100,
    spendingCents: 300,
    remainingCents: -200,
    goal: { name: "Goal", targetCents: 500 },
    categories: [],
  };
  assert.equal(
    validateSpendingChatRequest({ question: "How can I reduce spending?", summary })?.summary
      .remainingCents,
    -200,
  );
  assert.equal(
    validateSpendingChatRequest({
      question: "Question",
      summary: { ...summary, remainingCents: 0 },
    }),
    null,
  );
});
