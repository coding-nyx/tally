import { randomUUID } from "node:crypto";

export type AccountType = "bank" | "cash" | "credit_card" | "loan";
export type Account = {
  id: string;
  currency: "INR" | "USD";
  type: AccountType;
  name: string;
  archived: boolean;
  createdAt: number;
  opening?: {
    date: string;
    timing: "start_of_day" | "end_of_day";
    balanceMinor: number;
    eventId?: string;
  };
};
export type Posting = {
  accountId?: string;
  role?: "income" | "expense" | "opening_equity";
  categoryId?: string;
  component?: "interest" | "fee";
  side: "debit" | "credit";
  amountMinor: number;
};
export type JournalEvent = {
  id: string;
  currency: "INR" | "USD";
  kind: string;
  date: string;
  note: string;
  createdAt: number;
  actorId: string;
  postings: Posting[];
  relatedEventId?: string;
};
export type AccountingLedger = { accounts: Account[]; events: JournalEvent[] };
export type AccountingChange = { account?: Account; event?: JournalEvent };
export class AccountingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function reject(message: string): never {
  throw new AccountingError("invalid_accounting", message);
}
function exact(values: number[]) {
  const result = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value)) reject("Amounts must be integer minor units.");
    return sum + BigInt(value);
  }, 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER))
    reject("The total exceeds safe integer precision.");
  return Number(result);
}
export function liability(account: Account) {
  return ["credit_card", "loan"].includes(account.type);
}
export function emptyAccounting(): AccountingLedger {
  return { accounts: [], events: [] };
}
function accountFor(ledger: AccountingLedger, id: string, date?: string, allowArchived = false) {
  const account = ledger.accounts.find((a) => a.id === id);
  if (!account) reject("Account not found in this currency ledger.");
  if (account.archived && !allowArchived) reject("Choose an active account.");
  if (
    date &&
    account.opening &&
    (date < account.opening.date ||
      (date === account.opening.date && account.opening.timing === "end_of_day"))
  )
    reject("This event is already before or within the account opening cutoff.");
  return account;
}
function pnl(ledger: AccountingLedger, role: "income" | "expense", from?: string, to?: string) {
  return exact(
    ledger.events
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .flatMap((e) =>
        e.postings
          .filter((p) => p.role === role)
          .map(
            (p) => p.amountMinor * (p.side === (role === "income" ? "credit" : "debit") ? 1 : -1),
          ),
      ),
  );
}
export function accountBalance(ledger: AccountingLedger, id: string, asOf: string) {
  const account = accountFor(ledger, id, undefined, true);
  const events = ledger.events.filter(
    (e) => e.date <= asOf && e.postings.some((p) => p.accountId === id),
  );
  const movementMinor = exact(
    events.flatMap((e) =>
      e.postings
        .filter((p) => p.accountId === id)
        .map(
          (p) => p.amountMinor * (p.side === (liability(account) ? "credit" : "debit") ? 1 : -1),
        ),
    ),
  );
  const openingKnown = !!account.opening && account.opening.date <= asOf;
  return {
    account,
    asOf,
    openingKnown,
    balanceMinor: openingKnown ? movementMinor : null,
    recordedMovementMinor: movementMinor,
    reconciliation: "not_reconciled",
    statementCoverage: "not_available",
    lastRecordedDate:
      events
        .map((e) => e.date)
        .sort()
        .at(-1) ?? null,
    freshness: "Recorded journal only; no live bank connection or statement reconciliation.",
  };
}
export function financialPosition(
  ledger: AccountingLedger,
  currency: Account["currency"],
  asOf: string,
) {
  const accounts = ledger.accounts.map((a) => accountBalance(ledger, a.id, asOf));
  const assetsMinor = exact(
    accounts.filter((a) => !liability(a.account)).map((a) => a.balanceMinor ?? 0),
  );
  const liabilitiesMinor = exact(
    accounts.filter((a) => liability(a.account)).map((a) => a.balanceMinor ?? 0),
  );
  const complete = accounts.every((a) => a.openingKnown);
  return {
    currency,
    asOf,
    accounts,
    assetsMinor,
    liabilitiesMinor,
    netPositionMinor: complete ? exact([assetsMinor, -liabilitiesMinor]) : null,
    complete,
    unknownOpeningAccountIds: accounts.filter((a) => !a.openingKnown).map((a) => a.account.id),
    trackedScope: "Only listed accounts; legacy budget entries are unassigned and excluded.",
    reconciliation: "not_reconciled",
  };
}
export function incomeExpenseReport(
  ledger: AccountingLedger,
  currency: Account["currency"],
  from: string,
  to: string,
) {
  if (from > to) reject("The report start must precede its end.");
  const incomeMinor = pnl(ledger, "income", from, to),
    expenseMinor = pnl(ledger, "expense", from, to);
  return {
    currency,
    from,
    to,
    incomeMinor,
    expenseMinor,
    surplusMinor: exact([incomeMinor, -expenseMinor]),
    sourceEventIds: ledger.events.filter((e) => e.date >= from && e.date <= to).map((e) => e.id),
    trackedScope: "Account journals only; legacy budget entries are excluded.",
    reconciliation: "not_reconciled",
  };
}
export function cashFlow(
  ledger: AccountingLedger,
  currency: Account["currency"],
  from: string,
  to: string,
) {
  if (from > to) reject("The report start must precede its end.");
  const accounts = ledger.accounts
    .filter((a) => !liability(a))
    .map((account) => {
      const postings = ledger.events
        .filter(
          (e) =>
            e.date >= from && e.date <= to && !["opening", "opening_correction"].includes(e.kind),
        )
        .flatMap((e) => e.postings.filter((p) => p.accountId === account.id));
      const inMinor = exact(postings.filter((p) => p.side === "debit").map((p) => p.amountMinor));
      const outMinor = exact(postings.filter((p) => p.side === "credit").map((p) => p.amountMinor));
      return {
        accountId: account.id,
        inMinor,
        outMinor,
        netMovementMinor: exact([inMinor, -outMinor]),
      };
    });
  return {
    currency,
    from,
    to,
    accounts,
    netAssetMovementMinor: exact(accounts.map((a) => a.netMovementMinor)),
    note: "Internal transfers appear on individual accounts and cancel in net asset movement. Openings are excluded.",
    statementCoverage: "not_available",
  };
}
export function prepareAccount(
  ledger: AccountingLedger,
  currency: Account["currency"],
  args: any,
  actorId: string,
): AccountingChange {
  if (ledger.accounts.length >= 100) reject("A currency ledger can have at most 100 accounts.");
  if (
    ledger.accounts.some(
      (a) => a.name.toLocaleLowerCase("en-US") === args.name.toLocaleLowerCase("en-US"),
    )
  )
    reject("An account with this name already exists.");
  const account: Account = {
    id: randomUUID(),
    currency,
    name: args.name,
    type: args.type,
    archived: false,
    createdAt: Date.now(),
  };
  if (!args.opening) return { account };
  return openingChange(
    { ...ledger, accounts: [...ledger.accounts, account] },
    account.id,
    args.opening,
    actorId,
  );
}
export function openingChange(
  ledger: AccountingLedger,
  id: string,
  opening: Account["opening"],
  actorId: string,
): AccountingChange {
  const account = structuredClone(accountFor(ledger, id));
  if (!opening) reject("Supply an opening date, cutoff and reviewed balance.");
  if (account.opening)
    reject("Opening is already recorded. Use a reviewed correction instead of resetting history.");
  if (
    ledger.events.some(
      (e) =>
        e.postings.some((p) => p.accountId === id) &&
        (e.date < opening.date || (e.date === opening.date && opening.timing === "end_of_day")),
    )
  )
    reject("Existing movements overlap the proposed opening cutoff. Review migration first.");
  const balanceMinor = opening.balanceMinor;
  if (!Number.isSafeInteger(balanceMinor) || Math.abs(balanceMinor) > 1_000_000_000_000)
    reject("Invalid opening amount.");
  if (!balanceMinor) {
    account.opening = { ...opening };
    return { account };
  }
  const side = balanceMinor > 0 !== liability(account) ? "debit" : "credit";
  const event: JournalEvent = {
    id: randomUUID(),
    currency: account.currency,
    date: opening.date,
    kind: "opening",
    note: "Reviewed opening balance",
    actorId,
    createdAt: Date.now(),
    postings: [
      { accountId: account.id, side, amountMinor: Math.abs(balanceMinor) },
      {
        role: "opening_equity",
        side: side === "debit" ? "credit" : "debit",
        amountMinor: Math.abs(balanceMinor),
      },
    ],
  };
  account.opening = { ...opening, eventId: event.id };
  return { account, event };
}
export function updateAccount(ledger: AccountingLedger, args: any): AccountingChange {
  const account = structuredClone(accountFor(ledger, args.accountId, undefined, true));
  if (args.name !== undefined) {
    if (
      ledger.accounts.some(
        (a) =>
          a.id !== account.id &&
          a.name.toLocaleLowerCase("en-US") === args.name.toLocaleLowerCase("en-US"),
      )
    )
      reject("An account with this name already exists.");
    account.name = args.name;
  }
  if (args.archived !== undefined) account.archived = args.archived;
  return { account };
}
export function openingCorrection(
  ledger: AccountingLedger,
  args: any,
  actorId: string,
): AccountingChange {
  const account = accountFor(ledger, args.accountId, undefined, true);
  if (!account.opening) reject("Record a reviewed opening first.");
  if (args.date < account.opening.date) reject("An opening correction cannot precede the opening.");
  const delta = args.deltaMinor;
  if (!Number.isSafeInteger(delta) || !delta || Math.abs(delta) > 1_000_000_000_000)
    reject("Supply a bounded nonzero opening correction delta.");
  const side = delta > 0 !== liability(account) ? "debit" : "credit";
  return {
    event: {
      id: randomUUID(),
      currency: account.currency,
      kind: "opening_correction",
      date: args.date,
      note: args.note,
      createdAt: Date.now(),
      actorId,
      ...(account.opening.eventId ? { relatedEventId: account.opening.eventId } : {}),
      postings: [
        { accountId: account.id, side, amountMinor: Math.abs(delta) },
        {
          role: "opening_equity",
          side: side === "debit" ? "credit" : "debit",
          amountMinor: Math.abs(delta),
        },
      ],
    },
  };
}
export function prepareEvent(
  ledger: AccountingLedger,
  currency: Account["currency"],
  args: any,
  categories: Array<{ id: string; kind: string; archived: boolean }>,
  actorId: string,
): AccountingChange {
  const value = args.event;
  const event: JournalEvent = {
    id: randomUUID(),
    currency,
    date: value.date,
    kind: value.kind,
    note: value.note,
    createdAt: Date.now(),
    actorId,
    postings: [],
  };
  const add = (side: Posting["side"], amountMinor: number, target: Partial<Posting>) => {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 1_000_000_000_000)
      reject("Posting amounts must be positive bounded integer minor units.");
    event.postings.push({ side, amountMinor, ...target });
  };
  const account = (id: string, types: AccountType[]) => {
    const a = accountFor(ledger, id, value.date);
    if (!types.includes(a.type)) reject("The account type does not support this event.");
    return a;
  };
  const allocations = (
    side: Posting["side"],
    role: "income" | "expense",
    rows: any[],
    historical = false,
  ) => {
    for (const row of rows) {
      const category = categories.find(
        (c) => c.id === row.categoryId && c.kind === role && (historical || !c.archived),
      );
      if (!category) reject("Choose an active category matching the income or expense kind.");
      add(side, row.amountMinor, {
        role,
        categoryId: category.id,
        ...(row.component ? { component: row.component } : {}),
      });
    }
    return exact(rows.map((r) => r.amountMinor));
  };
  if (value.kind === "income") {
    account(value.accountId, ["bank", "cash"]);
    add("debit", allocations("credit", "income", value.allocations), {
      accountId: value.accountId,
    });
  } else if (value.kind === "expense") {
    account(value.accountId, ["bank", "cash", "credit_card"]);
    add("credit", allocations("debit", "expense", value.allocations), {
      accountId: value.accountId,
    });
  } else if (value.kind === "transfer" || value.kind === "card_payment") {
    account(value.fromAccountId, ["bank", "cash"]);
    account(value.toAccountId, value.kind === "transfer" ? ["bank", "cash"] : ["credit_card"]);
    if (value.fromAccountId === value.toAccountId) reject("A transfer needs distinct accounts.");
    add("credit", value.amountMinor, { accountId: value.fromAccountId });
    add("debit", value.amountMinor, { accountId: value.toAccountId });
  } else if (value.kind === "loan_borrowing") {
    account(value.assetAccountId, ["bank", "cash"]);
    account(value.loanAccountId, ["loan"]);
    add("debit", value.amountMinor, { accountId: value.assetAccountId });
    add("credit", value.amountMinor, { accountId: value.loanAccountId });
  } else if (value.kind === "loan_payment") {
    account(value.assetAccountId, ["bank", "cash"]);
    account(value.loanAccountId, ["loan"]);
    const expenses = value.allocations?.length
      ? allocations("debit", "expense", value.allocations)
      : 0;
    if (value.principalMinor > 0)
      add("debit", value.principalMinor, { accountId: value.loanAccountId });
    add("credit", exact([value.principalMinor, expenses]), { accountId: value.assetAccountId });
  } else if (value.kind === "refund") {
    account(value.accountId, ["bank", "cash", "credit_card"]);
    const original = ledger.events.find(
      (e) => e.id === value.originalEventId && e.kind === "expense",
    );
    if (
      !original ||
      ledger.events.some((e) => e.kind === "reversal" && e.relatedEventId === original.id)
    )
      reject("Choose an unreversed original expense event.");
    const refunded = ledger.events.filter(
      (e) =>
        e.kind === "refund" &&
        e.relatedEventId === original.id &&
        !ledger.events.some((r) => r.kind === "reversal" && r.relatedEventId === e.id),
    );
    for (const row of value.allocations) {
      const originalAmount = exact(
        original.postings
          .filter((p) => p.role === "expense" && p.categoryId === row.categoryId)
          .map((p) => p.amountMinor),
      );
      const priorAmount = exact(
        refunded.flatMap((e) =>
          e.postings
            .filter((p) => p.role === "expense" && p.categoryId === row.categoryId)
            .map((p) => p.amountMinor),
        ),
      );
      const requested = exact(
        value.allocations
          .filter((r: any) => r.categoryId === row.categoryId)
          .map((r: any) => r.amountMinor),
      );
      if (requested + priorAmount > originalAmount)
        reject("Refund allocations exceed the original category expense.");
    }
    if (value.date < original.date) reject("A refund cannot precede its original event.");
    add("debit", allocations("credit", "expense", value.allocations, true), {
      accountId: value.accountId,
    });
    event.relatedEventId = original.id;
  } else reject("Unsupported journal event kind.");
  validateEvent(ledger, event, categories);
  return { event };
}
export function prepareReversal(
  ledger: AccountingLedger,
  args: any,
  actorId: string,
): AccountingChange {
  const original = ledger.events.find((e) => e.id === args.eventId);
  if (!original || ["opening", "opening_correction", "reversal"].includes(original.kind))
    reject("Choose a recorded non-opening event to reverse.");
  if (args.date < original.date) reject("A reversal cannot precede its original event.");
  if (ledger.events.some((e) => e.kind === "reversal" && e.relatedEventId === original.id))
    reject("This event is already reversed.");
  if (
    ledger.events.some(
      (e) =>
        e.kind === "refund" &&
        e.relatedEventId === original.id &&
        !ledger.events.some((r) => r.kind === "reversal" && r.relatedEventId === e.id),
    )
  )
    reject("Reverse linked refunds first so the correction does not double count them.");
  return {
    event: {
      ...structuredClone(original),
      id: randomUUID(),
      kind: "reversal",
      date: args.date,
      note: args.note,
      createdAt: Date.now(),
      actorId,
      relatedEventId: original.id,
      postings: original.postings.map((p) => ({
        ...p,
        side: p.side === "debit" ? "credit" : "debit",
      })),
    },
  };
}
export function validateEvent(
  ledger: AccountingLedger,
  event: JournalEvent,
  categories: Array<{ id: string; kind: string }>,
) {
  if (event.postings.length < 2 || event.postings.length > 100)
    reject("A journal needs 2–100 postings.");
  for (const p of event.postings) {
    if (
      !Number.isSafeInteger(p.amountMinor) ||
      p.amountMinor <= 0 ||
      p.amountMinor > 1_000_000_000_000
    )
      reject("Invalid posting amount.");
    if (!!p.accountId === !!p.role) reject("A posting needs exactly one account or internal role.");
    if (p.accountId) {
      const a = accountFor(
        ledger,
        p.accountId,
        ["opening", "opening_correction"].includes(event.kind) ? undefined : event.date,
        ["reversal", "opening_correction"].includes(event.kind),
      );
      if (a.currency !== event.currency) reject("Cross-currency postings are unsupported.");
    }
    if (
      ["income", "expense"].includes(p.role ?? "") &&
      !categories.some((c) => c.id === p.categoryId && c.kind === p.role)
    )
      reject("A financial allocation needs a category matching its role.");
    if (!p.role && p.categoryId)
      reject("Account identity and category allocation are separate fields.");
  }
  if (exact(event.postings.map((p) => p.amountMinor * (p.side === "debit" ? 1 : -1))) !== 0)
    reject("Journal debits and credits must balance exactly.");
}
export function applyAccountingChange(
  ledger: AccountingLedger,
  change: AccountingChange,
  categories: Array<{ id: string; kind: string }>,
) {
  if (change.account) {
    const existing = ledger.accounts.findIndex((a) => a.id === change.account!.id);
    if (existing >= 0) ledger.accounts[existing] = structuredClone(change.account);
    else ledger.accounts.push(structuredClone(change.account));
  }
  if (change.event) {
    if (ledger.events.length >= 10000)
      reject("The foundation release supports at most 10,000 journal events per currency.");
    if (ledger.events.some((e) => e.id === change.event!.id))
      reject("This journal event already exists.");
    validateEvent(ledger, change.event, categories);
    ledger.events.push(structuredClone(change.event));
  }
  const currency = ledger.accounts[0]?.currency ?? change.event?.currency ?? "INR";
  financialPosition(ledger, currency, "9999-12-31");
  incomeExpenseReport(ledger, currency, "0000-01-01", "9999-12-31");
}
