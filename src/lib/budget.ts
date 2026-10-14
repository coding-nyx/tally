export type TxKind = "income" | "expense";
export type Currency = "INR" | "USD";

export type Transaction = {
  id: string;
  kind: TxKind;
  amountCents: number;
  category: string;
  note: string;
  date: string;
  createdAt: number;
  sample: boolean;
};

export type MonthlySettings = {
  goalName: string;
  goalTargetCents: number;
  categoryBudgets: Record<string, number>;
};

export type BudgetData = {
  currency: Currency;
  transactions: Transaction[];
  settingsByMonth: Record<string, MonthlySettings>;
  sample: boolean;
};

export type SpendRow = {
  category: string;
  cents: number;
  share: number;
};

export type BudgetLoadResult =
  | { status: "ready"; data: BudgetData; migrated: boolean }
  | { status: "error"; message: string; raw: string | null };

export type BudgetStatus = "no-limit" | "under" | "near" | "at" | "over";

export function safeCategoryName(name: string) {
  return !Object.hasOwn(Object.prototype, name.trim());
}
export function categoryBudget(
  budgets: Record<string, number>,
  category: string,
): number | undefined {
  if (!Object.hasOwn(budgets, category)) return undefined;
  const value = budgets[category];
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export const EXPENSE_CATEGORIES = [
  "Housing",
  "Groceries",
  "Transport",
  "Dining",
  "Utilities",
  "Health",
  "Subscriptions",
  "Personal",
] as const;

export const INCOME_CATEGORIES = ["Pay", "Freelance", "Other"] as const;

const ACTIVE_CURRENCY_KEY = "tally.currency.v2";
const LEGACY_STORAGE_KEY = "tally.budget.v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_LIMIT = 10_000_000_000;

export function categoriesFor(kind: TxKind): readonly string[] {
  return kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(key: string, delta: number): string {
  const [year, month] = key.split("-").map(Number);
  return monthKey(new Date(year, month - 1 + delta, 1));
}

export function monthTitle(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function inMonth(date: string, key: string): boolean {
  return date.slice(0, 7) === key;
}

export function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function defaultDateForMonth(key: string, now = new Date()): string {
  if (monthKey(now) === key) {
    return isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  }
  return `${key}-01`;
}

export function formatMoney(cents: number, currency: Currency = "INR"): string {
  const safe = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const formatter = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formatted = formatter.format(Math.abs(safe) / 100);
  return safe < 0 ? `−${formatted}` : formatted;
}

export function formatSigned(kind: TxKind, cents: number, currency: Currency = "INR"): string {
  const body = formatMoney(Math.abs(cents), currency);
  return kind === "income" ? `+${body}` : `−${body}`;
}

export function centsToInput(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[₹$\s,]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MONEY_LIMIT) return null;
  return cents;
}

/** Backwards-compatible name for callers that still use the original parser. */
export const parseDollarsToCents = parseMoneyToCents;

export function shares(cents: number[]): number[] {
  const total = cents.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return cents.map(() => 0);
  const exact = cents.map((value) => (value / total) * 100);
  const base = exact.map((value) => Math.floor(value));
  let left = 100 - base.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const item of order) {
    if (left <= 0) break;
    base[item.index] += 1;
    left -= 1;
  }
  return base;
}

export function spendingByCategory(transactions: Transaction[]): SpendRow[] {
  const totals = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.kind !== "expense") continue;
    totals.set(tx.category, (totals.get(tx.category) ?? 0) + tx.amountCents);
  }
  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = shares(entries.map(([, cents]) => cents));
  return entries.map(([category, cents], index) => ({
    category,
    cents,
    share: parts[index] ?? 0,
  }));
}

export function defaultMonthlySettings(currency: Currency): MonthlySettings {
  return {
    goalName: "Emergency cushion",
    goalTargetCents: currency === "INR" ? 4_000_000 : 400_000,
    categoryBudgets: {},
  };
}

export function settingsForMonth(data: BudgetData, month: string): MonthlySettings {
  return data.settingsByMonth[month] ?? defaultMonthlySettings(data.currency);
}

export function budgetStatus(spent: number, limit: number | undefined): BudgetStatus {
  if (!Number.isSafeInteger(limit) || (limit ?? 0) <= 0) return "no-limit";
  const safeSpent = Math.max(0, spent);
  if (safeSpent > limit!) return "over";
  if (safeSpent === limit) return "at";
  if (safeSpent >= limit! * 0.8) return "near";
  return "under";
}

export function loadBudget(now = new Date(), requestedCurrency?: Currency): BudgetLoadResult {
  let raw: string | null = null;
  try {
    const activeCurrency =
      requestedCurrency ?? parseCurrency(localStorage.getItem(ACTIVE_CURRENCY_KEY)) ?? "INR";
    const key = storageKey(activeCurrency);
    raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = parseBudgetData(JSON.parse(raw), activeCurrency);
      if (!parsed)
        return {
          status: "error",
          message: "The saved ledger is invalid or from an unsupported version.",
          raw,
        };
      return { status: "ready", data: parsed, migrated: false };
    }

    if (!requestedCurrency) {
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw !== null) {
        let legacy: unknown;
        try {
          legacy = JSON.parse(legacyRaw);
        } catch {
          return {
            status: "error",
            message:
              "The older saved ledger could not be read. Its original value has been kept for recovery.",
            raw: legacyRaw,
          };
        }
        const migrated = migrateLegacyBudget(legacy, now);
        if (!migrated) {
          return {
            status: "error",
            message:
              "The older saved ledger could not be validated. Its original value has been kept for recovery.",
            raw: legacyRaw,
          };
        }
        return { status: "ready", data: migrated, migrated: true };
      }
    }

    return { status: "ready", data: seedBudget(now, activeCurrency), migrated: false };
  } catch {
    return {
      status: "error",
      message: "Tally could not read browser storage. Your saved value has not been replaced.",
      raw,
    };
  }
}

export function saveBudget(data: BudgetData): void {
  const normalized = parseBudgetData(data, data.currency);
  if (!normalized) throw new Error("This ledger is not valid and was not saved.");
  const serialized = JSON.stringify(normalized);
  localStorage.setItem(storageKey(normalized.currency), serialized);
  localStorage.setItem(ACTIVE_CURRENCY_KEY, normalized.currency);
}

export function parseBackup(text: string): BudgetData | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.format !== "tally-budget-backup/v2") return null;
    return parseBudgetData(record.ledger, parseCurrency(record.currency));
  } catch {
    return null;
  }
}

export function makeBackup(data: BudgetData): string {
  return JSON.stringify(
    { format: "tally-budget-backup/v2", currency: data.currency, ledger: data },
    null,
    2,
  );
}

export function makeRawRecovery(raw: string): string {
  return raw;
}

function storageKey(currency: Currency): string {
  return `tally.budget.v2.${currency}`;
}

function parseCurrency(value: unknown): Currency | null {
  return value === "INR" || value === "USD" ? value : null;
}

function parseBudgetData(value: unknown, expectedCurrency?: Currency | null): BudgetData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const currency = parseCurrency(record.currency);
  if (!currency || (expectedCurrency && currency !== expectedCurrency)) return null;
  if (!Array.isArray(record.transactions) || !isMonthSettingsMap(record.settingsByMonth))
    return null;
  const transactions: Transaction[] = [];
  for (const item of record.transactions) {
    const tx = parseTransaction(item, record.sample === true);
    if (!tx) return null;
    transactions.push(tx);
  }
  const settingsByMonth: Record<string, MonthlySettings> = {};
  for (const [month, settings] of Object.entries(record.settingsByMonth)) {
    if (!isMonthKey(month)) return null;
    const clean = parseMonthlySettings(settings);
    if (!clean) return null;
    settingsByMonth[month] = clean;
  }
  return {
    currency,
    transactions,
    settingsByMonth,
    sample: transactions.some((tx) => tx.sample),
  };
}

function isMonthSettingsMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMonthlySettings(value: unknown): MonthlySettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Record<string, unknown>;
  if (typeof settings.goalName !== "string" || settings.goalName.trim().length === 0) return null;
  if (!Number.isSafeInteger(settings.goalTargetCents) || (settings.goalTargetCents as number) <= 0)
    return null;
  if (
    !settings.categoryBudgets ||
    typeof settings.categoryBudgets !== "object" ||
    Array.isArray(settings.categoryBudgets)
  )
    return null;
  const categoryBudgets: Record<string, number> = {};
  for (const [category, amount] of Object.entries(settings.categoryBudgets)) {
    if (
      !category.trim() ||
      !safeCategoryName(category) ||
      !Number.isSafeInteger(amount) ||
      (amount as number) <= 0 ||
      (amount as number) > MONEY_LIMIT
    )
      return null;
    categoryBudgets[category.trim()] = amount as number;
  }
  return {
    goalName: settings.goalName.trim().slice(0, 40),
    goalTargetCents: settings.goalTargetCents as number,
    categoryBudgets,
  };
}

function parseTransaction(value: unknown, legacySample: boolean): Transaction | null {
  if (!value || typeof value !== "object") return null;
  const tx = value as Record<string, unknown>;
  if (typeof tx.id !== "string" || tx.id.length === 0) return null;
  if (tx.kind !== "income" && tx.kind !== "expense") return null;
  if (
    typeof tx.amountCents !== "number" ||
    !Number.isSafeInteger(tx.amountCents) ||
    tx.amountCents <= 0
  )
    return null;
  if (typeof tx.category !== "string" || tx.category.trim().length === 0) return null;
  if (typeof tx.note !== "string") return null;
  if (typeof tx.date !== "string" || !isValidDate(tx.date)) return null;
  if (typeof tx.createdAt !== "number" || !Number.isFinite(tx.createdAt)) return null;
  return {
    id: tx.id,
    kind: tx.kind,
    amountCents: tx.amountCents,
    category: tx.category.trim(),
    note: tx.note.slice(0, 80),
    date: tx.date,
    createdAt: tx.createdAt,
    sample: tx.sample === true || (legacySample && tx.sample !== false),
  };
}

function migrateLegacyBudget(value: unknown, now: Date): BudgetData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.transactions)) return null;
  if (typeof record.goalName !== "string" || record.goalName.trim().length === 0) return null;
  if (!Number.isSafeInteger(record.goalTargetCents) || (record.goalTargetCents as number) <= 0)
    return null;
  const transactions: Transaction[] = [];
  for (const item of record.transactions) {
    const tx = parseTransaction(item, record.sample === true);
    if (!tx) return null;
    transactions.push(tx);
  }
  const months = new Set(transactions.map((tx) => tx.date.slice(0, 7)));
  months.add(monthKey(now));
  const settings: MonthlySettings = {
    goalName: record.goalName.trim().slice(0, 40),
    goalTargetCents: record.goalTargetCents as number,
    categoryBudgets: {},
  };
  const settingsByMonth = Object.fromEntries(
    [...months].map((month) => [month, { ...settings, categoryBudgets: {} }]),
  );
  return {
    currency: "USD",
    transactions,
    settingsByMonth,
    sample: transactions.some((tx) => tx.sample),
  };
}

function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isoDate(year: number, monthIndex: number, day: number): string {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  const clamped = Math.min(Math.max(1, day), last);
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

function seedBudget(now: Date, currency: Currency): BudgetData {
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const today = now.getDate();
  const on = (day: number) => isoDate(year, monthIndex, Math.min(day, today));
  const base = now.getTime();
  const multiplier = currency === "INR" ? 10 : 1;
  const rows: Array<Omit<Transaction, "id" | "createdAt" | "sample">> = [
    {
      kind: "income",
      amountCents: 480000 * multiplier,
      category: "Pay",
      note: "Salary",
      date: on(1),
    },
    {
      kind: "income",
      amountCents: 64000 * multiplier,
      category: "Freelance",
      note: "Studio invoice",
      date: on(8),
    },
    {
      kind: "expense",
      amountCents: 165000 * multiplier,
      category: "Housing",
      note: "Rent",
      date: on(1),
    },
    {
      kind: "expense",
      amountCents: 8640 * multiplier,
      category: "Groceries",
      note: "Sunday market",
      date: on(2),
    },
    {
      kind: "expense",
      amountCents: 4200 * multiplier,
      category: "Transport",
      note: "Transit card",
      date: on(3),
    },
    {
      kind: "expense",
      amountCents: 2850 * multiplier,
      category: "Dining",
      note: "Lunch",
      date: on(4),
    },
    {
      kind: "expense",
      amountCents: 1599 * multiplier,
      category: "Subscriptions",
      note: "Music",
      date: on(5),
    },
    {
      kind: "expense",
      amountCents: 9420 * multiplier,
      category: "Utilities",
      note: "Electric and water",
      date: on(6),
    },
    {
      kind: "expense",
      amountCents: 6215 * multiplier,
      category: "Groceries",
      note: "Corner store",
      date: on(7),
    },
    {
      kind: "expense",
      amountCents: 4100 * multiplier,
      category: "Dining",
      note: "Dinner out",
      date: on(9),
    },
    {
      kind: "expense",
      amountCents: 3500 * multiplier,
      category: "Health",
      note: "Pharmacy",
      date: on(10),
    },
    {
      kind: "expense",
      amountCents: 1800 * multiplier,
      category: "Transport",
      note: "Rideshare",
      date: on(11),
    },
    {
      kind: "expense",
      amountCents: 2400 * multiplier,
      category: "Personal",
      note: "Household",
      date: on(12),
    },
  ];
  const month = monthKey(now);
  return {
    currency,
    sample: true,
    settingsByMonth: { [month]: defaultMonthlySettings(currency) },
    transactions: rows.map((row, index) => ({
      ...row,
      id: `sample-${currency}-${index + 1}`,
      createdAt: base - (rows.length - index) * 1000,
      sample: true,
    })),
  };
}
