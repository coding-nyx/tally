import { z } from "zod";

export const currency = z.enum(["INR", "USD"]);
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const date = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .refine(
    (v) => new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
    "Invalid calendar date",
  );
export const amount = z.number().int().positive().max(1_000_000_000_000);
export const id = z.string().min(1).max(128);
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
const planCommit = { ...c, ...revision, planId: id, approvalId: id };
export type ToolDefinition = {
  description: string;
  scope: string;
  effect: "read" | "write" | "prepare" | "external";
  schema: z.ZodObject;
};
export const catalog: Record<string, ToolDefinition> = {};
function tool(
  name: string,
  description: string,
  scope: string,
  effect: ToolDefinition["effect"],
  shape: z.ZodRawShape,
) {
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
    name: z.string().trim().min(1).max(40),
  },
);
tool(
  "update_category",
  "Rename a category and atomically update transaction and budget references.",
  "categories:write",
  "write",
  { ...c, ...revision, categoryId: id, name: z.string().trim().min(1).max(40) },
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
  "Freeze a delete preview for trusted owner approval.",
  "transactions:write",
  "prepare",
  { ...c, ...revision, transactionId: id },
);
tool(
  "delete_transaction",
  "Commit an approved delete preview. An agent cannot approve its own preview.",
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
  "Commit the exact approved batch atomically.",
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
  "Stage an owned uploaded CSV or text PDF. Upload via the private file endpoint; never pass a server path or URL.",
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
  "Commit the exact approved import once; duplicates remain excluded.",
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
  "Commit the owner's approved restore; preserve the other ledger.",
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
  "Clear only entries in the approved month preview.",
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
  "Remove the approved sample entries only.",
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
  "Commit an approved compensating operation; original audit events remain intact.",
  "transactions:write",
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
