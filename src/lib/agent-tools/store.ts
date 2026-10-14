import type { InvestmentBook, InvestmentChange } from "../investments.ts";
import type { BudgetData, Currency, TxKind, Transaction, MonthlySettings } from "../budget.ts";
import type { CsvTable, StatementMapping } from "../bank-statement.ts";
import type { SpendingSummary } from "../ai/spending-chat.ts";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../budget.ts";
import type { StatementLedger, StatementChange } from "../statements.ts";
import type { AccountingLedger, AccountingChange } from "../accounting.ts";

export type Principal = {
  ownerId: string;
  actorId: string;
  role: "owner" | "agent";
  currencies: Currency[];
  scopes: string[];
  expiresAt: number;
};
export type Category = {
  id: string;
  kind: TxKind;
  name: string;
  archived: boolean;
  builtIn: boolean;
};
export type Ledger = {
  revision: number;
  data: BudgetData;
  categories: Category[];
  accounting?: AccountingLedger;
  statements?: StatementLedger;
  investments?: InvestmentBook;
};
export type Plan = {
  id: string;
  actorId: string;
  currency: Currency;
  operation: string;
  revision: number;
  hash: string;
  expiresAt: number;
  status: "pending" | "cancelled" | "committed";
  before?: Ledger;
  after?: Ledger;
  review: unknown;
  context?: SpendingSummary;
  question?: string;
  requiredScope?: string;
  providerIdentity?: string;
  importId?: string;
  receiptId?: string;
  investmentChange?: InvestmentChange;
  accountingChange?: AccountingChange;
  statementChange?: StatementChange;
};
export type Approval = {
  id: string;
  planId: string;
  actorId: string;
  hash: string;
  expiresAt: number;
  status: "requested" | "approved" | "rejected" | "consumed";
  decidedBy?: string;
};
export type PrivateFile = {
  id: string;
  actorId: string;
  currency: Currency;
  name: string;
  mime: string;
  bytes: string;
  expiresAt: number;
  purpose: "upload" | "download";
};
export type Draft = {
  id: string;
  actorId: string;
  currency: Currency;
  table: CsvTable;
  mapping?: StatementMapping & { categoryColumn?: number | null };
  generation: number;
  expiresAt: number;
  status: "draft" | "cancelled" | "committed";
  warnings: string[];
  receiptId?: string;
};
export type UndoDelta = {
  transactions: Record<string, Transaction | null>;
  settings: Record<string, MonthlySettings | null>;
  categories?: Category[];
  sample: boolean;
  previousRevision: number;
};
export type Receipt = {
  id: string;
  actorId: string;
  currency?: Currency;
  key: string;
  fingerprint: string;
  tool: string;
  requiredScope?: string;
  committedAt: number;
  result: Record<string, unknown>;
  undo?: UndoDelta;
  afterHash?: string;
  revision?: number;
};
export type Audit = {
  id: string;
  currency?: Currency;
  actorId: string;
  tool: string;
  operationId: string;
  at: number;
  revision?: number;
};
export type AiRequest = {
  id: string;
  actorId: string;
  currency: Currency;
  contextId: string;
  status: "pending" | "completed" | "cancelled" | "failed" | "interrupted";
  instance: string;
  startedAt: number;
  answer?: string;
  error?: string;
};
export type Workspace = {
  version: 2;
  preferences: { currency: Currency };
  ledgers: Record<Currency, Ledger>;
  plans: Record<string, Plan>;
  approvals: Record<string, Approval>;
  files: Record<string, PrivateFile>;
  imports: Record<string, Draft>;
  receipts: Record<string, Receipt>;
  audit: Audit[];
  ai: Record<string, AiRequest>;
};
export function emptyWorkspace(): Workspace {
  const ledger = (currency: Currency): Ledger => ({
    revision: 0,
    data: { currency, transactions: [], settingsByMonth: {}, sample: false },
    categories: [
      ...EXPENSE_CATEGORIES.map((name) => ({
        id: `expense:${name}`,
        name,
        kind: "expense" as const,
        archived: false,
        builtIn: true,
      })),
      ...INCOME_CATEGORIES.map((name) => ({
        id: `income:${name}`,
        name,
        kind: "income" as const,
        archived: false,
        builtIn: true,
      })),
    ],
  });
  return {
    version: 2,
    preferences: { currency: "INR" },
    ledgers: { INR: ledger("INR"), USD: ledger("USD") },
    plans: {},
    approvals: {},
    files: {},
    imports: {},
    receipts: {},
    audit: [],
    ai: {},
  };
}
/** The callback and its receipts commit together, or neither commits. */
export interface WorkspaceStore {
  transaction<T>(ownerId: string, work: (workspace: Workspace) => Promise<T>): Promise<T>;
}
/** Synthetic test store only. Production never silently falls back to memory. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private data = new Map<string, Workspace>();
  private queue: Promise<unknown> = Promise.resolve();
  async transaction<T>(ownerId: string, work: (workspace: Workspace) => Promise<T>): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(async () => {
        const draft = structuredClone(this.data.get(ownerId) ?? emptyWorkspace());
        const result = await work(draft);
        this.data.set(ownerId, draft);
        return structuredClone(result);
      });
    this.queue = run;
    return run;
  }
}
