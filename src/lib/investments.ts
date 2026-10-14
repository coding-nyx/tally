import { randomUUID } from "node:crypto";
import { AccountingError } from "./accounting.ts";
export type InvestmentType = "mutual_fund" | "gold" | "stock" | "recurring_deposit";
export type InvestmentAccount = {
  id: string;
  name: string;
  institution: string;
  archived: boolean;
};
export type Holding = {
  id: string;
  accountId: string;
  type: InvestmentType;
  name: string;
  identifier: string;
  archived: boolean;
};
export type Valuation = {
  id: string;
  holdingId: string;
  date: string;
  quantity: string;
  costMinor: number;
  valueMinor: number;
  note: string;
  actorId: string;
  createdAt: number;
  rd?: { instalmentMinor: number; maturityDate: string; expectedMaturityMinor?: number };
};
export type InvestmentBook = {
  accounts: InvestmentAccount[];
  holdings: Holding[];
  valuations: Valuation[];
};
export type InvestmentChange = {
  account?: InvestmentAccount;
  holding?: Holding;
  valuation?: Valuation;
};
export function emptyInvestments(): InvestmentBook {
  return { accounts: [], holdings: [], valuations: [] };
}
function reject(message: string): never {
  throw new AccountingError("invalid_investment", message);
}
function sum(values: number[]) {
  const result = values.reduce((a, b) => a + BigInt(b), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER))
    reject("Portfolio total exceeds safe precision.");
  return Number(result);
}
export function investmentChange(
  book: InvestmentBook,
  input: any,
  actorId: string,
): InvestmentChange {
  const change = input.change;
  if (change.action === "account") {
    if (book.accounts.length >= 100) reject("At most 100 investment accounts per currency.");
    if (book.accounts.some((a) => a.name.toLocaleLowerCase() === change.name.toLocaleLowerCase()))
      reject("Investment account name already exists.");
    return {
      account: {
        id: randomUUID(),
        name: change.name,
        institution: change.institution,
        archived: false,
      },
    };
  }
  const account = book.accounts.find((a) => a.id === change.accountId);
  if (change.action === "archive_account") {
    if (!account) reject("Investment account not found in this currency.");
    return { account: { ...account, archived: change.archived } };
  }
  const existing = book.holdings.find((h) => h.id === change.holdingId);
  if (change.action === "archive_holding") {
    if (!existing) reject("Holding not found in this currency.");
    return { holding: { ...existing, archived: change.archived } };
  }
  let holding = existing;
  if (change.action === "holding") {
    if (!account || account.archived)
      reject("Choose an active investment account in this currency.");
    if (book.holdings.length >= 1000) reject("At most 1,000 holdings per currency.");
    if (
      book.holdings.some(
        (h) =>
          h.accountId === account.id &&
          h.name.toLocaleLowerCase() === change.name.toLocaleLowerCase(),
      )
    )
      reject("Holding name already exists in this account.");
    holding = {
      id: randomUUID(),
      accountId: account.id,
      type: change.type,
      name: change.name,
      identifier: change.identifier,
      archived: false,
    };
  }
  if (
    !holding ||
    holding.archived ||
    book.accounts.find((a) => a.id === holding.accountId)?.archived
  )
    reject("Choose an active holding and account in this currency.");
  if (book.valuations.length >= 10000)
    reject("At most 10,000 valuation observations per currency.");
  const v = change.valuation;
  if (!v) reject("Supply an explicit dated valuation.");
  if (holding.type === "recurring_deposit" && !v.rd)
    reject("Recurring deposits need instalment and maturity details.");
  if (holding.type !== "recurring_deposit" && v.rd)
    reject("RD details apply only to recurring deposits.");
  if (holding.type !== "recurring_deposit" && v.valueMinor > 0 && Number(v.quantity) <= 0)
    reject("A valued holding needs a positive unit or gram quantity.");
  const valuation: Valuation = {
    ...v,
    id: randomUUID(),
    holdingId: holding.id,
    actorId,
    createdAt: Date.now(),
  };
  return { ...(change.action === "holding" ? { holding } : {}), valuation };
}
export function applyInvestmentChange(book: InvestmentBook, change: InvestmentChange) {
  for (const [key, item] of [
    ["accounts", change.account],
    ["holdings", change.holding],
  ] as const) {
    if (!item) continue;
    const rows = book[key] as Array<InvestmentAccount | Holding>;
    const index = rows.findIndex((v) => v.id === item.id);
    if (index < 0) rows.push(structuredClone(item));
    else rows[index] = structuredClone(item);
  }
  if (change.valuation) {
    if (book.valuations.some((v) => v.id === change.valuation!.id))
      reject("Valuation already recorded.");
    book.valuations.push(structuredClone(change.valuation));
  }
}
export function investmentPortfolio(book: InvestmentBook, asOf: string, accountId?: string) {
  if (accountId && !book.accounts.some((a) => a.id === accountId))
    reject("Investment account not found in this currency.");
  const accounts = book.accounts.filter((a) => !accountId || a.id === accountId);
  const holdings = book.holdings
    .filter((h) => accounts.some((a) => a.id === h.accountId))
    .map((holding) => {
      // Last appended observation wins on the same effective date, preserving correction history.
      const history = book.valuations.filter((v) => v.holdingId === holding.id && v.date <= asOf);
      const valuation = history.reduce<Valuation | null>(
        (last, v) => (!last || v.date >= last.date ? v : last),
        null,
      );
      return {
        holding,
        valuation,
        gainMinor: valuation ? sum([valuation.valueMinor, -valuation.costMinor]) : null,
      };
    });
  const active = holdings.filter(
    (h) => !h.holding.archived && !accounts.find((a) => a.id === h.holding.accountId)?.archived,
  );
  const complete = active.every((h) => h.valuation !== null);
  return {
    asOf,
    accounts,
    holdings,
    complete,
    valueMinor: complete ? sum(active.map((h) => h.valuation!.valueMinor)) : null,
    costMinor: complete ? sum(active.map((h) => h.valuation!.costMinor)) : null,
    gainMinor: complete ? sum(active.map((h) => h.gainMinor!)) : null,
    basis:
      "Manual position snapshots, not live prices or a trade ledger. Cost is remaining cost basis; gain excludes realised returns, dividends and tax. Portfolio values are separate from bank/card journal balances.",
  };
}
