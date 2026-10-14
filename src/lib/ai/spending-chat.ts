import {
  inMonth,
  settingsForMonth,
  spendingByCategory,
  type BudgetData,
  type Currency,
  type Transaction,
} from "../budget.ts";

export type SpendingSummary = {
  currency: Currency;
  month: string;
  incomeCents: number;
  spendingCents: number;
  remainingCents: number;
  goal: { name: string; targetCents: number };
  categories: Array<{ name: string; spentCents: number; budgetCents: number | null }>;
};

export type SpendingChatAvailability = {
  state: "unconfigured" | "ready";
  message: string;
  provider?: string;
};

export type SpendingChatRequest = {
  question: string;
  summary: SpendingSummary;
};

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Configuration is read only on the server; credentials never enter client bundles. */
export function spendingChatConfig(env: Record<string, string | undefined>) {
  const provider = env.TALLY_AI_PROVIDER?.trim().toLocaleLowerCase("en-US");
  const configuredEndpoint = env.TALLY_AI_BASE_URL?.trim().replace(/\/+$/, "");
  const endpoint =
    provider === "deepseek" ? configuredEndpoint || DEEPSEEK_BASE_URL : configuredEndpoint;
  const model = env.TALLY_AI_MODEL?.trim();
  const apiKey = env.TALLY_AI_API_KEY?.trim();
  if (
    (provider !== "deepseek" && provider !== "openai-compatible") ||
    !endpoint ||
    !model ||
    !apiKey
  )
    return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    if (provider === "deepseek" && url.hostname !== "api.deepseek.com") return null;
    return {
      provider,
      endpoint: `${url.toString().replace(/\/+$/, "")}/chat/completions`,
      model,
      apiKey,
    };
  } catch {
    return null;
  }
}

export function spendingChatAvailability(configured: boolean): SpendingChatAvailability {
  return configured
    ? {
        state: "ready",
        provider: "Configured AI provider",
        message: "Chat is ready. Review the data-sharing notice before sending a question.",
      }
    : {
        state: "unconfigured",
        message:
          "No AI provider is configured. Chat is disabled and no financial data is being sent.",
      };
}

/** Future model context is restricted to monthly aggregates; transaction notes and rows stay local. */
export function buildSpendingSummary(data: BudgetData, month: string): SpendingSummary {
  const transactions = data.transactions.filter((transaction) => inMonth(transaction.date, month));
  const incomeCents = sumKind(transactions, "income");
  const spendingCents = sumKind(transactions, "expense");
  const settings = settingsForMonth(data, month);
  return {
    currency: data.currency,
    month,
    incomeCents,
    spendingCents,
    remainingCents: incomeCents - spendingCents,
    goal: { name: settings.goalName, targetCents: settings.goalTargetCents },
    categories: spendingByCategory(transactions)
      .slice(0, 16)
      .map((row) => ({
        name: row.category,
        spentCents: row.cents,
        budgetCents:
          Object.hasOwn(settings.categoryBudgets, row.category) &&
          Number.isSafeInteger(settings.categoryBudgets[row.category])
            ? settings.categoryBudgets[row.category]
            : null,
      })),
  };
}

export function validateSpendingChatRequest(value: unknown): SpendingChatRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SpendingChatRequest>;
  const question = typeof candidate.question === "string" ? candidate.question.trim() : "";
  const summary = candidate.summary;
  if (!question || question.length > 500 || !summary || typeof summary !== "object") return null;
  if (summary.currency !== "INR" && summary.currency !== "USD") return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(summary.month)) return null;
  if (![summary.incomeCents, summary.spendingCents, summary.goal?.targetCents].every(isSafeCents))
    return null;
  if (
    !Number.isSafeInteger(summary.remainingCents) ||
    Math.abs(summary.remainingCents) > 100_000_000_000 ||
    summary.remainingCents !== summary.incomeCents - summary.spendingCents
  )
    return null;
  if (typeof summary.goal?.name !== "string" || summary.goal.name.length > 40) return null;
  if (!Array.isArray(summary.categories) || summary.categories.length > 16) return null;
  const categories = summary.categories.map((category) => {
    if (
      !category ||
      typeof category !== "object" ||
      typeof category.name !== "string" ||
      category.name.length > 40
    )
      return null;
    if (
      !isSafeCents(category.spentCents) ||
      (category.budgetCents !== null && !isSafeCents(category.budgetCents))
    )
      return null;
    return {
      name: category.name,
      spentCents: category.spentCents,
      budgetCents: category.budgetCents,
    };
  });
  if (categories.some((category) => category === null)) return null;
  return {
    question,
    summary: {
      currency: summary.currency,
      month: summary.month,
      incomeCents: summary.incomeCents,
      spendingCents: summary.spendingCents,
      remainingCents: summary.remainingCents,
      goal: { name: summary.goal.name, targetCents: summary.goal.targetCents },
      categories: categories as SpendingSummary["categories"],
    },
  };
}

function isSafeCents(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000_000_000
  );
}

function sumKind(transactions: Transaction[], kind: "income" | "expense"): number {
  return transactions
    .filter((transaction) => transaction.kind === kind)
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
}
