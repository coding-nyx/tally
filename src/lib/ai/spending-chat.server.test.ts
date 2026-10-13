import assert from "node:assert/strict";
import { test } from "node:test";
import { answerSpendingQuestion } from "./spending-chat.server.ts";

const environment = {
  TALLY_AI_PROVIDER: "openai-compatible",
  TALLY_AI_BASE_URL: "https://provider.example/v1",
  TALLY_AI_MODEL: "synthetic-model",
  TALLY_AI_API_KEY: "synthetic-test-secret",
};

const request = {
  question: "How close am I to my goal?",
  summary: {
    currency: "INR" as const,
    month: "2026-10",
    incomeCents: 500_000,
    spendingCents: 125_000,
    remainingCents: 375_000,
    goal: { name: "Cushion", targetCents: 400_000 },
    categories: [{ name: "Groceries", spentCents: 125_000, budgetCents: 150_000 }],
  },
};

test("server chat sends bounded summary to a synthetic provider stub only", async () => {
  let url = "";
  let options: RequestInit | undefined;
  const answer = await answerSpendingQuestion(request, undefined, environment, async (input, init) => {
    url = String(input);
    options = init;
    return Response.json({ choices: [{ message: { content: "You have ₹3,750 left to save." } }] });
  });
  const sent = JSON.parse(String(options?.body)) as { max_tokens: number; model: string; messages: Array<{ content: string }> };
  assert.equal(answer, "You have ₹3,750 left to save.");
  assert.equal(url, "https://provider.example/v1/chat/completions");
  assert.equal(sent.model, "synthetic-model");
  assert.equal(sent.max_tokens, 500);
  assert.match(String((options?.headers as Record<string, string>).authorization), /^Bearer synthetic-test-secret$/);
  assert.match(sent.messages[1]?.content ?? "", /Groceries/);
  assert.doesNotMatch(sent.messages[1]?.content ?? "", /transaction|description|PRIVATE/);
});

test("DeepSeek uses its official compatible endpoint through a synthetic stub", async () => {
  const deepseekEnv = {
    TALLY_AI_PROVIDER: "deepseek",
    TALLY_AI_MODEL: "deepseek-flash",
    TALLY_AI_API_KEY: "synthetic-deepseek-key",
  };
  let requestUrl = "";
  let requestBody = "";
  const answer = await answerSpendingQuestion(request, undefined, deepseekEnv, async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return Response.json({ choices: [{ message: { content: "Synthetic DeepSeek answer." } }] });
  });
  assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(answer, "Synthetic DeepSeek answer.");
  assert.equal(JSON.parse(requestBody).model, "deepseek-flash");
});

test("server chat forwards caller cancellation to the provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(answerSpendingQuestion(request, controller.signal, environment, async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  }), /Aborted/);
});

test("provider failures and empty answers return user-facing retry guidance", async () => {
  await assert.rejects(answerSpendingQuestion(request, undefined, environment, async () =>
    Response.json({ error: "synthetic rate limit" }, { status: 429 }),
  ), /busy or rate limited.*retry/i);
  await assert.rejects(answerSpendingQuestion(request, undefined, environment, async () =>
    Response.json({ error: "synthetic provider failure" }, { status: 503 }),
  ), /could not answer right now.*retry/i);
  await assert.rejects(answerSpendingQuestion(request, undefined, environment, async () =>
    Response.json({ choices: [] }),
  ), /empty response.*retry/i);
});

test("a retried question succeeds after a synthetic provider rate-limit response", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ error: "synthetic rate limit" }, { status: 429 })
      : Response.json({ choices: [{ message: { content: "Synthetic retry answer." } }] });
  };
  await assert.rejects(answerSpendingQuestion(request, undefined, environment, fetcher), /rate limited/);
  assert.equal(await answerSpendingQuestion(request, undefined, environment, fetcher), "Synthetic retry answer.");
  assert.equal(calls, 2);
});
