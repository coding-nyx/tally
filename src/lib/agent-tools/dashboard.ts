import type { BudgetData, Currency, Transaction } from "../budget.ts";
import { TallyClient, TallyClientError } from "./client.ts";
export type DashboardCategory = {
  id: string;
  name: string;
  kind: "income" | "expense";
  archived: boolean;
};
/** A month is a read model of the canonical service, never a browser-stored ledger. */
export async function readDashboard(
  client: TallyClient,
  currency: Currency,
  month: string,
  signal?: AbortSignal,
) {
  const args = { currency, month };
  const [meta, settings, categories] = await Promise.all([
    client.call("tally_get_ledger", { currency }, undefined, signal),
    client.call("tally_get_month_settings", args, undefined, signal),
    client.call("tally_list_categories", { currency, includeArchived: true }, undefined, signal),
  ]);
  const revision = meta.revision;
  const transactions: Transaction[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.call(
      "tally_list_transactions",
      { ...args, limit: 100, ...(cursor ? { cursor } : {}) },
      undefined,
      signal,
    );
    if (page.revision !== revision)
      throw new TallyClientError(
        "revision_conflict",
        "The ledger changed while loading. Refresh to read the current month.",
        409,
      );
    for (const { amountMinor, ...item } of page.items)
      transactions.push({ ...item, amountCents: amountMinor } as Transaction);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const after = await client.call("tally_get_ledger", { currency }, undefined, signal);
  if (
    after.revision !== revision ||
    settings.revision !== revision ||
    (categories.revision !== undefined && categories.revision !== revision)
  )
    throw new TallyClientError(
      "revision_conflict",
      "The ledger changed while loading. Refresh to read the current month.",
      409,
    );
  const data: BudgetData = {
    currency,
    transactions,
    settingsByMonth: { [month]: settings.settings },
    sample: transactions.some((t) => t.sample),
  };
  return {
    data,
    revision: revision as number,
    categories: categories.categories as DashboardCategory[],
  };
}

export function dashboardSearch(search: Record<string, unknown>): {
  currency?: Currency;
  month?: string;
  section?: string;
} {
  return {
    ...(["INR", "USD"].includes(search.currency as string)
      ? { currency: search.currency as Currency }
      : {}),
    ...(typeof search.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(search.month)
      ? { month: search.month }
      : {}),
    ...(typeof search.section === "string" &&
    [
      "accounts",
      "statements",
      "ledger",
      "categories",
      "imports",
      "approvals",
      "chat",
      "tools",
    ].includes(search.section)
      ? { section: search.section }
      : {}),
  };
}
