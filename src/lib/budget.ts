export type TxKind = "income" | "expense";

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

export type BudgetData = {
  transactions: Transaction[];
  goalName: string;
  goalTargetCents: number;
  sample: boolean;
};

export type SpendRow = {
  category: string;
  cents: number;
  share: number;
};

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

const STORAGE_KEY = "tally.budget.v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

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

export function formatMoney(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const formatted = money.format(Math.abs(safe) / 100);
  return safe < 0 ? `−${formatted}` : formatted;
}

export function formatSigned(kind: TxKind, cents: number): string {
  const body = formatMoney(Math.abs(cents));
  return kind === "income" ? `+${body}` : `−${body}`;
}

export function centsToInput(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 10_000_000_000) return null;
  return cents;
}

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
  const entries = [...totals.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const parts = shares(entries.map(([, cents]) => cents));
  return entries.map(([category, cents], index) => ({
    category,
    cents,
    share: parts[index] ?? 0,
  }));
}

export function loadBudget(now = new Date()): BudgetData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedBudget(now);
    const parsed: unknown = JSON.parse(raw);
    const data = parseBudget(parsed);
    return data ?? seedBudget(now);
  } catch {
    return seedBudget(now);
  }
}

export function saveBudget(data: BudgetData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function parseBudget(value: unknown): BudgetData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.transactions)) return null;
  if (typeof record.goalName !== "string" || record.goalName.trim().length === 0) return null;
  if (
    typeof record.goalTargetCents !== "number" ||
    !Number.isSafeInteger(record.goalTargetCents) ||
    record.goalTargetCents <= 0
  ) {
    return null;
  }
  const transactions: Transaction[] = [];
  for (const item of record.transactions) {
    const tx = parseTransaction(item, record.sample === true);
    if (!tx) return null;
    transactions.push(tx);
  }
  return {
    transactions,
    goalName: record.goalName.trim().slice(0, 40),
    goalTargetCents: record.goalTargetCents,
    sample: transactions.some((tx) => tx.sample),
  };
}

function parseTransaction(value: unknown, legacySample: boolean): Transaction | null {
  if (!value || typeof value !== "object") return null;
  const tx = value as Record<string, unknown>;
  if (typeof tx.id !== "string" || tx.id.length === 0) return null;
  if (tx.kind !== "income" && tx.kind !== "expense") return null;
  if (typeof tx.amountCents !== "number" || !Number.isSafeInteger(tx.amountCents) || tx.amountCents <= 0) {
    return null;
  }
  if (typeof tx.category !== "string" || tx.category.trim().length === 0) return null;
  if (typeof tx.note !== "string") return null;
  if (typeof tx.date !== "string" || !DATE_RE.test(tx.date)) return null;
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

function isoDate(year: number, monthIndex: number, day: number): string {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  const clamped = Math.min(Math.max(1, day), last);
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

function seedBudget(now: Date): BudgetData {
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const today = now.getDate();
  const on = (day: number) => isoDate(year, monthIndex, Math.min(day, today));
  const base = now.getTime();
  const rows: Array<Omit<Transaction, "id" | "createdAt" | "sample">> = [
    { kind: "income", amountCents: 480000, category: "Pay", note: "Salary", date: on(1) },
    { kind: "income", amountCents: 64000, category: "Freelance", note: "Studio invoice", date: on(8) },
    { kind: "expense", amountCents: 165000, category: "Housing", note: "Rent", date: on(1) },
    { kind: "expense", amountCents: 8640, category: "Groceries", note: "Sunday market", date: on(2) },
    { kind: "expense", amountCents: 4200, category: "Transport", note: "Transit card", date: on(3) },
    { kind: "expense", amountCents: 2850, category: "Dining", note: "Lunch", date: on(4) },
    { kind: "expense", amountCents: 1599, category: "Subscriptions", note: "Music", date: on(5) },
    { kind: "expense", amountCents: 9420, category: "Utilities", note: "Electric and water", date: on(6) },
    { kind: "expense", amountCents: 6215, category: "Groceries", note: "Corner store", date: on(7) },
    { kind: "expense", amountCents: 4100, category: "Dining", note: "Dinner out", date: on(9) },
    { kind: "expense", amountCents: 3500, category: "Health", note: "Pharmacy", date: on(10) },
    { kind: "expense", amountCents: 1800, category: "Transport", note: "Rideshare", date: on(11) },
    { kind: "expense", amountCents: 2400, category: "Personal", note: "Household", date: on(12) },
  ];

  return {
    sample: true,
    goalName: "Emergency cushion",
    goalTargetCents: 400000,
    transactions: rows.map((row, index) => ({
      ...row,
      id: `sample-${index + 1}`,
      createdAt: base - (rows.length - index) * 1000,
      sample: true,
    })),
  };
}
