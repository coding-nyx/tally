import { z } from "zod";
import { safeCategoryName } from "../budget.ts";

export const currency = z.enum(["INR", "USD"]);
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const date = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return (
      !v.startsWith("0000-") &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === v
    );
  }, "Invalid calendar date");
export const amount = z.number().int().positive().max(1_000_000_000_000);
export const id = z.string().min(1).max(128);
export const categoryName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(safeCategoryName, "Choose a non-reserved category name");
export const transaction = z.strictObject({
  kind: z.enum(["income", "expense"]),
  amountMinor: amount,
  category: z.string().max(40),
  note: z.string().max(80),
  date,
});
export const transactionPatch = z
  .strictObject({
    kind: z.enum(["income", "expense"]).optional(),
    amountMinor: amount.optional(),
    category: z.string().max(40).optional(),
    note: z.string().max(80).optional(),
    date: date.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Supply a change");
export const mapping = z.strictObject({
  dateColumn: z.number().int().nonnegative(),
  descriptionColumn: z.number().int().nonnegative().nullable(),
  currencyColumn: z.number().int().nonnegative().nullable(),
  dateFormat: z.enum(["auto", "mdy", "dmy"]),
  categoryColumn: z.number().int().nonnegative().nullable().optional(),
  amount: z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("signed"),
      amountColumn: z.number().int().nonnegative(),
      positiveAmounts: z.enum(["income", "expense"]),
    }),
    z.strictObject({
      mode: z.literal("debit-credit"),
      debitColumn: z.number().int().nonnegative(),
      creditColumn: z.number().int().nonnegative(),
    }),
  ]),
});
export const change = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), transaction }),
  z.strictObject({ action: z.literal("update"), transactionId: id, patch: transactionPatch }),
  z.strictObject({ action: z.literal("delete"), transactionId: id }),
]);
const c = { currency };
const cm = { ...c, month };
const revision = { expectedRevision: z.number().int().nonnegative() };
const paging = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2048).optional(),
};
const planCommit = {
  ...c,
  ...revision,
  planId: id,
  previewHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  approvalId: id.optional(),
};
export type ToolDefinition = {
  description: string;
  scope: string;
  effect: "read" | "write" | "prepare" | "external";
  schema: z.ZodObject;
};
export const catalog: Record<string, ToolDefinition> = Object.create(null);
function tool(
  name: string,
  description: string,
  scope: string,
  effect: ToolDefinition["effect"],
  shape: z.ZodRawShape,
) {
  if (shape === planCommit)
    description +=
      " When the preview returns approvalRequired=false, send planId, previewHash and expectedRevision directly; otherwise include an owner-approved approvalId.";
  catalog[`tally_${name}`] = { description, scope, effect, schema: z.strictObject(shape) };
}
tool(
  "get_capabilities",
  "Discover enabled operations, limits and required scopes. Amounts are integer minor units; currencies are separate.",
  "summary:read",
  "read",
  {},
);
tool(
  "get_service_status",
  "Read service and storage readiness without secrets.",
  "summary:read",
  "read",
  {},
);
tool("list_ledgers", "List ledgers authorized for this actor.", "summary:read", "read", {});
tool(
  "get_ledger",
  "Read a ledger revision and metadata, without transaction descriptions.",
  "summary:read",
  "read",
  c,
);
tool("list_months", "List months containing transactions or settings.", "summary:read", "read", c);
tool(
  "list_categories",
  "Read built-in and custom categories, including archived categories when requested.",
  "summary:read",
  "read",
  { ...c, includeArchived: z.boolean().default(false) },
);
tool(
  "create_category",
  "Create a unique income or expense category in this currency ledger.",
  "categories:write",
  "write",
  {
    ...c,
    ...revision,
    kind: z.enum(["income", "expense"]),
    name: categoryName,
  },
);
tool(
  "update_category",
  "Rename a category and atomically update transaction and budget references.",
  "categories:write",
  "write",
  { ...c, ...revision, categoryId: id, name: categoryName },
);
tool(
  "archive_category",
  "Archive a category while preserving historical entries and budgets.",
  "categories:write",
  "write",
  { ...c, ...revision, categoryId: id },
);
tool(
  "restore_category",
  "Make an archived category available for new entries again.",
  "categories:write",
  "write",
  { ...c, ...revision, categoryId: id },
);
tool(
  "get_preferences",
  "Read the owner's display currency preference.",
  "summary:read",
  "read",
  {},
);
tool(
  "update_preferences",
  "Set the display currency without moving money between ledgers.",
  "settings:write",
  "write",
  c,
);
tool(
  "list_transactions",
  "Read at most 100 entries. Cursors are bound to a query and revision; refresh after stale_cursor.",
  "transactions:read",
  "read",
  { ...c, ...paging, month: month.optional(), kind: z.enum(["income", "expense"]).optional() },
);
tool("get_transaction", "Read one transaction by opaque id.", "transactions:read", "read", {
  ...c,
  transactionId: id,
});
tool(
  "create_transaction",
  "Create a transaction using a durable idempotency key and expected ledger revision.",
  "transactions:write",
  "write",
  { ...c, ...revision, transaction },
);
tool(
  "update_transaction",
  "Patch a transaction; amounts are positive integer minor units.",
  "transactions:write",
  "write",
  { ...c, ...revision, transactionId: id, patch: transactionPatch },
);
tool(
  "prepare_delete_transaction",
  "Freeze a delete preview; inspect it before committing.",
  "transactions:write",
  "prepare",
  { ...c, ...revision, transactionId: id },
);
tool(
  "delete_transaction",
  "Commit the exact frozen delete preview.",
  "transactions:write",
  "write",
  planCommit,
);
tool(
  "prepare_batch_changes",
  "Preview at most 100 atomic transaction changes.",
  "transactions:write",
  "prepare",
  { ...c, ...revision, changes: z.array(change).min(1).max(100) },
);
tool(
  "commit_batch_changes",
  "Commit the exact reviewed batch atomically.",
  "transactions:write",
  "write",
  planCommit,
);
tool(
  "get_month_settings",
  "Read a month's savings goal and category budgets.",
  "summary:read",
  "read",
  cm,
);
tool("get_savings_goal", "Read a month's savings goal.", "summary:read", "read", cm);
tool(
  "set_savings_goal",
  "Set a positive monthly goal target and a name of at most 40 characters.",
  "settings:write",
  "write",
  { ...cm, ...revision, name: z.string().trim().min(1).max(40), targetMinor: amount },
);
tool("get_category_budget", "Read a category limit; null means no limit.", "summary:read", "read", {
  ...cm,
  category: z.string().min(1).max(40),
});
tool("set_category_budget", "Set a positive category budget.", "settings:write", "write", {
  ...cm,
  ...revision,
  category: z.string().min(1).max(40),
  limitMinor: amount,
});
tool(
  "clear_category_budget",
  "Remove a category limit. Zero is not a valid budget.",
  "settings:write",
  "write",
  { ...cm, ...revision, category: z.string().min(1).max(40) },
);
tool(
  "get_month_summary",
  "Calculate deterministic monthly totals; does not call an AI provider.",
  "summary:read",
  "read",
  cm,
);
tool(
  "get_category_totals",
  "Calculate monthly totals by expense category.",
  "summary:read",
  "read",
  cm,
);
tool("get_budget_status", "Calculate budget and savings progress.", "summary:read", "read", cm);
tool(
  "stage_statement",
  "Stage a legacy budget-only CSV or text PDF; no account balance, counterpart matching or reconciliation effects. Upload via the private file endpoint; never pass a server path or URL.",
  "imports:write",
  "prepare",
  { ...c, fileId: id },
);
tool(
  "get_import",
  "Read paginated staged statement rows for correction; no ledger changes.",
  "imports:write",
  "read",
  { ...c, importId: id, ...paging },
);
tool(
  "set_import_mapping",
  "Set explicit column and date mappings; invalidate prior previews.",
  "imports:write",
  "prepare",
  { ...c, importId: id, mapping },
);
tool(
  "correct_import_rows",
  "Correct up to 100 source rows, then preview again. Currency cells still undergo validation.",
  "imports:write",
  "prepare",
  {
    ...c,
    importId: id,
    corrections: z
      .array(
        z.strictObject({
          rowNumber: z.number().int().positive(),
          values: z.array(z.string().max(2000)).max(100),
        }),
      )
      .min(1)
      .max(100),
  },
);
tool(
  "preview_import",
  "Freeze an import preview; invalid rows block commit, duplicates are excluded.",
  "imports:write",
  "prepare",
  { ...c, ...revision, importId: id },
);
tool(
  "commit_import",
  "Commit the exact reviewed import once; duplicates remain excluded.",
  "imports:write",
  "write",
  planCommit,
);
tool(
  "cancel_import",
  "Cancel a draft; committed entries are not reversed.",
  "imports:write",
  "write",
  { ...c, importId: id },
);
tool(
  "export_transactions_csv",
  "Create an expiring private CSV download handle.",
  "exports:read",
  "prepare",
  { ...c, month: month.optional() },
);
tool(
  "export_monthly_pdf",
  "Create a Tally-branded monthly PDF from the canonical ledger.",
  "exports:read",
  "prepare",
  cm,
);
tool(
  "export_backup",
  "Create a versioned JSON ledger backup, keeping its currency explicit.",
  "exports:read",
  "prepare",
  c,
);
tool(
  "get_file",
  "Read metadata and private download path for an owned file handle, never arbitrary filesystem paths.",
  "files:read",
  "read",
  { ...c, fileId: id },
);
tool(
  "preview_restore",
  "Validate an uploaded backup and freeze replacement of this currency only. Current data is preserved in a private backup at commit.",
  "restore:write",
  "prepare",
  { ...c, ...revision, fileId: id },
);
tool(
  "commit_restore",
  "Commit the exact frozen restore; preserve the other ledger.",
  "restore:write",
  "write",
  planCommit,
);
tool(
  "get_recovery_status",
  "Read whether uploaded recovery material is available. Browser-local data must be explicitly uploaded.",
  "recovery:read",
  "read",
  c,
);
tool(
  "export_raw_recovery",
  "Copy an owned uploaded raw recovery file into a short-lived download handle.",
  "recovery:read",
  "prepare",
  { ...c, fileId: id },
);
tool(
  "verify_ledger_integrity",
  "Validate stored transaction dates, categories, ids and amounts.",
  "summary:read",
  "read",
  c,
);
tool(
  "prepare_clear_month",
  "Freeze deletion of all entries in one month.",
  "transactions:write",
  "prepare",
  { ...cm, ...revision },
);
tool(
  "clear_month",
  "Clear only entries in the reviewed month preview.",
  "transactions:write",
  "write",
  planCommit,
);
tool(
  "prepare_remove_sample_entries",
  "Freeze removal of entries explicitly marked as samples.",
  "transactions:write",
  "prepare",
  { ...c, ...revision },
);
tool(
  "remove_sample_entries",
  "Remove the reviewed sample entries only.",
  "transactions:write",
  "write",
  planCommit,
);
tool(
  "get_ai_status",
  "Read optional provider readiness and spending limits, without configuration secrets.",
  "summary:read",
  "read",
  {},
);
tool(
  "create_analysis_context",
  "Freeze aggregate monthly context for external-provider consent. No descriptions or custom goal names are included.",
  "ai:ask",
  "prepare",
  { ...cm, question: z.string().trim().min(1).max(500) },
);
tool(
  "ask_spending_question",
  "Start one bounded provider request using a trusted consent approval. Requires configured provider; never retries automatically.",
  "ai:ask",
  "external",
  { ...c, contextId: id, approvalId: id, question: z.string().trim().min(1).max(500) },
);
tool("get_ai_request", "Read a provider request result or interrupted state.", "ai:ask", "read", {
  ...c,
  requestId: id,
});
tool(
  "cancel_ai_request",
  "Cancel an in-flight provider call; a completed request remains completed.",
  "ai:ask",
  "write",
  { ...c, requestId: id },
);
tool(
  "request_approval",
  "Request trusted owner approval for an existing preview. This operation never grants approval.",
  "approvals:request",
  "prepare",
  { ...c, planId: id },
);
tool("get_approval", "Read approval status for your own operation.", "approvals:request", "read", {
  ...c,
  approvalId: id,
});
tool(
  "get_operation",
  "Read your operation/preview, or its durable commit receipt.",
  "summary:read",
  "read",
  { ...c, operationId: id },
);
tool(
  "cancel_operation",
  "Cancel an uncommitted preview. A committed receipt is returned unchanged.",
  "approvals:request",
  "write",
  { ...c, operationId: id },
);
tool(
  "list_audit_events",
  "Read paginated audit metadata for this currency; does not disclose transaction descriptions.",
  "audit:read",
  "read",
  { ...c, ...paging },
);
tool(
  "get_operation_receipt",
  "Read the immutable receipt of your committed operation after a disconnect.",
  "summary:read",
  "read",
  { ...c, operationId: id },
);
tool(
  "prepare_undo",
  "Preview a compensating operation, allowed only when the ledger still matches the committed after-state.",
  "transactions:write",
  "prepare",
  { ...c, ...revision, operationId: id },
);
tool(
  "commit_undo",
  "Commit a reviewed compensating operation; original audit events remain intact.",
  "transactions:write",
  "write",
  planCommit,
);

// Snapshot of the original 62-operation surface for compatibility coverage.
export const legacyCatalog = { ...catalog };

const opening = z.strictObject({
  date,
  timing: z.enum(["start_of_day", "end_of_day"]),
  balanceMinor: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
});
const allocations = z
  .array(z.strictObject({ categoryId: id, amountMinor: amount }))
  .min(1)
  .max(50);
const eventCommon = { date, note: z.string().max(80).default("") };
const journalEvent = z.discriminatedUnion("kind", [
  z.strictObject({ ...eventCommon, kind: z.literal("income"), accountId: id, allocations }),
  z.strictObject({ ...eventCommon, kind: z.literal("expense"), accountId: id, allocations }),
  z.strictObject({
    ...eventCommon,
    kind: z.literal("transfer"),
    fromAccountId: id,
    toAccountId: id,
    amountMinor: amount,
  }),
  z.strictObject({
    ...eventCommon,
    kind: z.literal("card_payment"),
    fromAccountId: id,
    toAccountId: id,
    amountMinor: amount,
  }),
  z.strictObject({
    ...eventCommon,
    kind: z.literal("loan_borrowing"),
    assetAccountId: id,
    loanAccountId: id,
    amountMinor: amount,
  }),
  z.strictObject({
    ...eventCommon,
    kind: z.literal("loan_payment"),
    assetAccountId: id,
    loanAccountId: id,
    principalMinor: z.number().int().min(0).max(1_000_000_000_000),
    allocations: z
      .array(
        z.strictObject({
          categoryId: id,
          amountMinor: amount,
          component: z.enum(["interest", "fee"]),
        }),
      )
      .min(1)
      .max(50)
      .optional(),
  }),
  z.strictObject({
    ...eventCommon,
    kind: z.literal("refund"),
    accountId: id,
    originalEventId: id,
    allocations,
  }),
]);
tool(
  "list_accounts",
  "List bank, cash, card and loan accounts. Legacy budget entries are separate.",
  "accounts:read",
  "read",
  c,
);
tool("get_account", "Read account metadata and reviewed opening cutoff.", "accounts:read", "read", {
  ...c,
  accountId: id,
});
const cardBill = z
  .strictObject({
    statementDate: date,
    dueDate: date,
    totalDueMinor: z.number().int().min(0).max(1_000_000_000_000),
    minimumDueMinor: z.number().int().min(0).max(1_000_000_000_000),
  })
  .refine(
    (v) => v.dueDate >= v.statementDate && v.minimumDueMinor <= v.totalDueMinor,
    "Check bill dates and minimum due",
  );
const cardTerms = z.strictObject({ creditLimitMinor: amount });
tool(
  "prepare_account",
  "Prepare an account and optional reviewed opening balance; no postings until reviewed commit.",
  "accounts:write",
  "prepare",
  {
    ...c,
    ...revision,
    type: z.enum(["bank", "cash", "credit_card", "loan"]),
    name: z.string().trim().min(1).max(80),
    opening: opening.optional(),
    institution: z.string().trim().max(80).optional(),
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    cardTerms: cardTerms.optional(),
  },
);
tool(
  "prepare_opening_balance",
  "Prepare the first opening; overlapping historical movements require migration review.",
  "accounts:write",
  "prepare",
  { ...c, ...revision, accountId: id, opening },
);
tool(
  "prepare_account_update",
  "Prepare account rename/archive/restore; type/currency and history stay immutable.",
  "accounts:write",
  "prepare",
  {
    ...c,
    ...revision,
    accountId: id,
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
    institution: z.string().trim().max(80).optional(),
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    cardTerms: cardTerms.optional(),
    cardBill: cardBill.optional(),
  },
);
tool(
  "prepare_opening_correction",
  "Prepare an explicit signed opening correction with a reason; never infer a plug from a closing-balance discrepancy.",
  "accounts:write",
  "prepare",
  {
    ...c,
    ...revision,
    accountId: id,
    date,
    deltaMinor: z
      .number()
      .int()
      .min(-1_000_000_000_000)
      .max(1_000_000_000_000)
      .refine((v) => v !== 0),
    note: z.string().trim().min(1).max(80),
  },
);
tool(
  "commit_account_change",
  "Commit a reviewed account/opening change atomically with receipt and audit.",
  "accounts:write",
  "write",
  planCommit,
);
tool(
  "prepare_journal_event",
  "Prepare balanced income, purchases, transfer/ATM, card settlement, loan principal/interest or refund; category allocations are separate from accounts.",
  "journal:write",
  "prepare",
  { ...c, ...revision, event: journalEvent },
);
tool(
  "prepare_journal_reversal",
  "Prepare compensating postings; never delete or silently rewrite a posted journal.",
  "journal:write",
  "prepare",
  { ...c, ...revision, eventId: id, date, note: z.string().min(1).max(80) },
);
tool(
  "commit_journal_event",
  "Commit the exact reviewed journal once; principal/transfers are not extra income or spending.",
  "journal:write",
  "write",
  planCommit,
);
tool(
  "list_journal_events",
  "Read paginated account journals, separate from unassigned legacy transactions.",
  "journal:read",
  "read",
  { ...c, ...paging, from: date.optional(), to: date.optional() },
);
tool(
  "get_journal_event",
  "Read a posted event and all balanced postings.",
  "journal:read",
  "read",
  { ...c, eventId: id },
);
tool(
  "get_account_balance",
  "Read recorded balance at a date; unknown opening means null, not zero. Dated statement metadata is included when Phase B is enabled.",
  "accounts:read",
  "read",
  { ...c, accountId: id, asOf: date },
);
tool(
  "get_financial_position",
  "Read scoped assets/liabilities; net position is unknown when openings are missing. No live bank data.",
  "accounts:read",
  "read",
  { ...c, asOf: date },
);
tool(
  "get_cash_flow",
  "Calculate dated bank/cash movement; transfers cancel in aggregate and openings are excluded.",
  "accounts:read",
  "read",
  { ...c, from: date, to: date },
);
tool(
  "get_income_expense_report",
  "Calculate dated journal income and net expense; legacy entries remain excluded until reviewed migration.",
  "accounts:read",
  "read",
  { ...c, from: date, to: date },
);
tool(
  "export_accounting_backup",
  "Export account metadata and immutable journals; does not restore or migrate legacy budget entries.",
  "exports:read",
  "prepare",
  c,
);

// Manual portfolios share the canonical owner document and revision/receipt transaction.
const investmentName = z.string().trim().min(1).max(80);
const valuation = z.strictObject({
  date,
  quantity: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,8})?$/)
    .default("0"),
  costMinor: z.number().int().min(0).max(1_000_000_000_000),
  valueMinor: z.number().int().min(0).max(1_000_000_000_000),
  note: z.string().trim().max(500).default(""),
  rd: z
    .strictObject({
      instalmentMinor: amount,
      maturityDate: date,
      expectedMaturityMinor: amount.optional(),
    })
    .optional(),
});
const investmentChange = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("account"),
    name: investmentName,
    institution: z.string().trim().max(80).default(""),
  }),
  z.strictObject({
    action: z.literal("holding"),
    accountId: id,
    type: z.enum(["mutual_fund", "gold", "stock", "recurring_deposit"]),
    name: investmentName,
    identifier: z.string().trim().max(80).default(""),
    valuation,
  }),
  z.strictObject({ action: z.literal("valuation"), holdingId: id, valuation }),
  z.strictObject({ action: z.literal("archive_account"), accountId: id, archived: z.boolean() }),
  z.strictObject({ action: z.literal("archive_holding"), holdingId: id, archived: z.boolean() }),
]);
tool(
  "get_investment_portfolio",
  "Read manual mutual fund, gold, stock and RD positions at a date, separate from account journals; unknown values stay unknown.",
  "accounts:read",
  "read",
  { ...c, asOf: date, accountId: id.optional() },
);
tool(
  "list_investment_valuations",
  "Read immutable dated position observations, including corrections, with revision-bound paging.",
  "accounts:read",
  "read",
  { ...c, holdingId: id, ...paging },
);
tool(
  "prepare_investment_change",
  "Preview an investment account/holding, dated manual valuation or archive/restore. No bank posting, live quote or automatic trade.",
  "accounts:write",
  "prepare",
  { ...c, ...revision, change: investmentChange },
);
tool(
  "commit_investment_change",
  "Commit the exact frozen investment preview once with revision, hash, receipt and audit checks.",
  "accounts:write",
  "write",
  planCommit,
);

// Phase B is activated deliberately after migration 0004; legacy imports stay separate.
export const foundationCatalog = { ...catalog };
const signedMinor = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
const reason = z.string().trim().min(1).max(500);
const statementMetadata = {
  periodFrom: date,
  periodTo: date,
  openingMinor: signedMinor.optional(),
  closingMinor: signedMinor.optional(),
  closingTiming: z.enum(["start_of_day", "end_of_day"]).default("end_of_day"),
};
const sourceIds = z.array(id).min(1).max(100);
const sourceDecision = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    observationIds: sourceIds,
    event: journalEvent,
    reason,
  }),
  z.strictObject({ action: z.literal("link"), observationIds: sourceIds, eventId: id, reason }),
  z.strictObject({ action: z.literal("exclude"), observationIds: sourceIds, reason }),
]);
tool(
  "stage_account_statement",
  "Retain selected CSV/text-PDF bytes and account/period metadata privately; stage only, no financial posting.",
  "statements:write",
  "write",
  { ...c, ...revision, accountId: id, fileId: id, ...statementMetadata },
);
tool(
  "revise_account_statement",
  "Append an immutable mapping/correction revision. Original bytes and rows remain; linked source rows cannot be rewritten.",
  "statements:write",
  "write",
  {
    ...c,
    ...revision,
    statementId: id,
    mapping: mapping.extend({ referenceColumn: z.number().int().nonnegative().nullable() }),
    corrections: z
      .array(
        z.strictObject({
          rowNumber: z.number().int().positive(),
          values: z.array(z.string().max(10000)).max(100),
        }),
      )
      .max(100)
      .optional(),
    metadata: z
      .strictObject({
        periodFrom: date.optional(),
        periodTo: date.optional(),
        openingMinor: signedMinor.optional(),
        closingMinor: signedMinor.optional(),
        closingTiming: z.enum(["start_of_day", "end_of_day"]).optional(),
      })
      .optional(),
    reason,
  },
);
tool(
  "list_account_statements",
  "Read persistent latest statement revisions; currency and account scoped.",
  "statements:read",
  "read",
  { ...c, ...paging, accountId: id.optional() },
);
tool(
  "get_account_statement",
  "Read statement metadata, paginated original cells before mapping, or mapped source observations with reviewed decisions.",
  "statements:read",
  "read",
  { ...c, ...paging, statementId: id },
);
tool(
  "get_statement_source",
  "Create a private expiring download for retained immutable source bytes.",
  "statements:read",
  "prepare",
  { ...c, sourceFileId: id },
);
tool(
  "get_statement_matches",
  "Suggest provider/date/amount matches; similarities never merge or discard rows automatically.",
  "statements:read",
  "read",
  { ...c, ...paging, statementId: id },
);
tool(
  "prepare_statement_changes",
  "Freeze explicit source classification/link/exclusion decisions and balanced events; select all rows of chosen statements. Multiple account counterparts share one journal.",
  "statements:write",
  "prepare",
  {
    ...c,
    ...revision,
    statementIds: z.array(id).min(1).max(10),
    decisions: z.array(sourceDecision).max(1000),
  },
);
tool(
  "commit_statement_changes",
  "Commit the exact reviewed statement/source/journal diff with revision, receipt and audit.",
  "statements:write",
  "write",
  planCommit,
);
tool(
  "prepare_statement_reconciliation",
  "Freeze observed-versus-recorded closing and unresolved reasons; never creates a balancing plug.",
  "statements:write",
  "prepare",
  { ...c, ...revision, statementId: id },
);
tool(
  "commit_statement_reconciliation",
  "Record the reviewed reconciliation snapshot; discrepancies remain visible and are recomputed on later reads.",
  "statements:write",
  "write",
  planCommit,
);
tool(
  "get_statement_coverage",
  "Read missing periods, overlaps, current reconciliation and saved history for an explicit account/date scope.",
  "statements:read",
  "read",
  { ...c, accountId: id, from: date, to: date },
);
tool(
  "stage_legacy_migration",
  "Snapshot shared legacy entries or an explicitly uploaded backup without posting; preserve originals/settings and keep unassigned evidence separate.",
  "migration:write",
  "write",
  { ...c, ...revision, fileId: id.optional() },
);
tool(
  "get_legacy_migration",
  "Read original staged legacy entries/settings and decisions, including cutoff-excluded and unassigned history.",
  "migration:read",
  "read",
  { ...c, ...paging, batchId: id },
);
tool(
  "list_legacy_migrations",
  "Read staged legacy migration metadata without silently migrating browser data.",
  "migration:read",
  "read",
  { ...c, ...paging },
);
tool(
  "prepare_legacy_migration",
  "Freeze per-entry convert/cutoff/unassigned decisions; openings are explicit, dates and integer components must match. Shared converted entries leave legacy totals atomically.",
  "migration:write",
  "prepare",
  {
    ...c,
    ...revision,
    batchId: id,
    decisions: z
      .array(
        z.discriminatedUnion("action", [
          z.strictObject({
            action: z.literal("convert"),
            legacyIds: sourceIds,
            event: journalEvent,
            reason,
          }),
          z.strictObject({
            action: z.literal("cutoff"),
            legacyIds: sourceIds,
            accountId: id,
            reason,
          }),
          z.strictObject({ action: z.literal("unassigned"), legacyIds: sourceIds, reason }),
        ]),
      )
      .max(1000),
  },
);
tool(
  "commit_legacy_migration",
  "Commit reviewed legacy conversion once, retaining snapshot/decisions and settings with journal/receipt/audit.",
  "migration:write",
  "write",
  planCommit,
);

export const requestSchema = z.strictObject({
  version: z.literal(2),
  tool: z.string().max(80),
  args: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export const scopes = [
  ...new Set(Object.values(catalog).map((t) => t.scope)),
  "files:write",
  "owner:approve",
];
