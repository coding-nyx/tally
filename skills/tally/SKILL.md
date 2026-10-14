---
name: tally
description: Operate Tally personal-finance ledgers through its scoped agent tools. Use for Tally bank/cash/card/loan accounts, reviewed openings and balanced journals, transactions, custom categories, monthly budgets/goals, manual investment observations, reviewed CSV/text-PDF imports, exports, recovery, audit/undo, or consent-gated spending questions. Use the connected Tally MCP service or private REST/CLI bridge; discover capabilities first.
---

# Tally

## Connect and discover

Call `tally_get_capabilities` and `tally_list_ledgers`. Check `financialApprovalRequired` and each preview's `approvalRequired`; older servers without these flags still require owner approval. Use the discovered operations and currencies; missing operations mean the credential lacks access. Do not treat a private network connection as authorization. Ask for owner setup when the service is disabled or the grant is expired; do not invent records or credentials.

The repository's `agent:mcp` command provides a stdio MCP bridge. For private shared Tailscale mode, supply `TALLY_URL` and `TALLY_AUTH_MODE=tailnet`; no access token is needed. Bearer deployments still require `TALLY_ACCESS_TOKEN`. The server decides the configured mode and may expose all tool schemas before shared storage is configured; discovery alone does not prove that financial operations are ready. Remote HTTP MCP/OAuth is not implemented. For private REST requests and examples, read [references/workflows.md](references/workflows.md). Tool input schemas and scope requirements are in [references/tools.json](references/tools.json); read only the relevant operation.

## Account journals and legacy records

The account foundation provides bank, cash, credit-card and loan accounts through the same service as UI and MCP. Use `tally_list_accounts`, `tally_get_account_balance` and `tally_get_financial_position` with an explicit `asOf` date. Missing openings return an unknown balance, not zero. Statement coverage/reconciliation is available only when the Phase B operations appear in discovery; live bank connectivity is absent.

Create accounts/openings with `tally_prepare_account` / `tally_prepare_opening_balance`, inspect the frozen preview and commit with `tally_commit_account_change` using the mode-specific rules below. Opening amounts may be signed; positive card/loan openings mean debt, and the chosen start/end-of-day cutoff prevents double counting. Never infer an opening from income minus expenses. Type/currency and the original opening cannot be rewritten; archive preserves history. `tally_prepare_opening_correction` records an explicit signed delta and reason against opening equity, preserving the original. Never create a correction merely to force a statement close; opening-cutoff migration and reconciliation are separate reviewed Phase B workflows when enabled.

For account-aware activity use `tally_prepare_journal_event` followed by frozen review and `tally_commit_journal_event`. Income/expense allocations use category **ids**, while financial accounts have separate account ids. Salary is income, card purchases are expenses, card payments settle debt, transfers/ATM movements are not extra income/expense, loan borrowing is not income, and repayment separates principal from explicit interest/fee allocations. `loan_payment` expense allocations require a `component` of `interest` or `fee`. Refunds link an original purchase; posted events are corrected through `tally_prepare_journal_reversal`, not delete/legacy undo. No cross-currency transfer or inferred interest calculation exists.

`get_income_expense_report`, `get_cash_flow` and journal history are dated account reports. The older transaction/budget/import tools remain **legacy unassigned income/expense records**; they do not update account balances and are not added to journal totals. Existing CSV/text-PDF imports do not match transfers, reconcile account statements or migrate legacy entries. When discovered, use the separate Phase B workflows below for account-aware statement ingestion. Do not silently book a repayment as expense. Account/group budgets, statement dues, reminders and built-in tool-agent orchestration remain later phases.

`export_accounting_backup` includes account journals/categories and retained evidence when Phase B is enabled (subject to export size bounds). It is not accepted by the legacy `preview_restore`; whole-database restore is an operator action. The database preserves journals in normalized tables and receipts/audit in the existing canonical workspace. No agent manages database credentials, schema, host services or backups through financial tools.

## Account-aware statements and reviewed migration (Phase B)

These 16 operations are optional. Discover them and `get_service_status.statementsEnabled`; disabled deployments retain the 79-tool foundation. Static schemas do not authorize unavailable features. Do not activate storage/features or apply SQL through financial tools.

1. Upload only selected files. `stage_account_statement` retains source bytes/digest with an explicit account, period and observed opening/closing/cutoff. Staging posts nothing. `revise_account_statement` appends the explicit column/date/sign/reference mapping and any unreviewed corrections. Positive bank credit increases assets; positive card payment credit reduces debt. Retain original source dates/cells. Use the actual parser's convention, never an inferred description.
2. Read `get_account_statement` (original cells before mapping, observations afterward) and `get_statement_matches`, including every page. Provider/date/amount suggestions never prove duplication. Exact file-row identity protects replay; equal merchant/date/amount rows may be separate legitimate purchases. `prepare_statement_changes` requires explicit create/link/exclude decisions for all rows of selected latest statements. Group counterpart account observations onto one balanced journal; later statements can link to that journal. Link decisions must match signed account movement, with a reason explaining canonical versus source dates. Erroneous rows need correction or explicit reasoned exclusion. Linked source cells cannot be silently changed.
3. Show the frozen source rows/journals/position diff and commit with `commit_statement_changes` within the user's authorized task, following the preview's `approvalRequired` flag. Private shared mode requires no separate approval click. Retain the key and identical arguments on interruption. A new revision invalidates older plans.
4. Use `get_statement_coverage` and reviewed `prepare_statement_reconciliation` / `commit_statement_reconciliation`. Closing observations are dated evidence. Missing openings, gaps, unresolved/excluded rows and differences remain visible; never create an opening correction or journal to force agreement. Reconciliation history is preserved and current results recomputed.
5. `stage_legacy_migration` snapshots shared legacy data or an explicitly selected uploaded backup. Inspect originals/settings with `get_legacy_migration`. `prepare_legacy_migration` freezes convert/cutoff/unassigned mappings for every original entry. Cutoff requires an explicit reviewed account opening; preserve date/kind/category/amount and give reasons for reclassification. Converted shared entries leave legacy totals atomically; uploaded unassigned entries remain separate source history. `commit_legacy_migration` requires the exact frozen plan. Unassigned decisions can be completed later without deleting earlier reviews. No browser is read automatically; no inferred opening, duplicate dual-write or live cutover by inference.

Bounds: 1,000 rows/statement or legacy batch, 100 rows/page, 40 MB retained sources/currency. Phase B control requests can use up to 1 MB when enabled; legacy commands retain 16 KB. Group/paginate carefully and do not omit unseen rows from review. Whole-database evidence restore and retention maintenance are operator actions. Bank-specific parsers, PDF page coordinates, rules/clearing/dues/reminders remain outside this first foundation.

## Financial rules

- Always choose an explicit authorized currency. INR and USD have independent records and revisions; no exchange-rate conversion or implicit cross-ledger move exists.
- Transaction/posting amounts are positive integer minor units; reviewed opening balances and opening-correction deltas can be signed: `1250` means ₹12.50 or $12.50. Never send floats. Dates are `YYYY-MM-DD`, months are `YYYY-MM`.
- Read `tally_list_categories` for the chosen currency and kind. Create a missing category with `tally_create_category` only when the user wants it. Renaming updates transaction and budget references atomically; archiving preserves history and blocks new entries.
- Read the ledger revision before a change. Pass `expectedRevision`. A conflict requires refreshed data and a new preview/intent; do not silently overwrite someone else's edit.
- Reuse the **same idempotency key and identical arguments** after a timeout or disconnect. New intents get new keys. A replay returns the original result even if the ledger changed later. Inspect the operation receipt before assuming a request failed.
- Missing budget means no limit. Use `tally_clear_category_budget`; zero is invalid. Savings targets and budgets must be positive.

## Imports and destructive changes

1. Upload an explicitly selected file using the operator's trusted attachment path or `agent:cli upload`. Tool arguments take an opaque `fileId`, never a server path or external URL. Files selected in the shared workspace are uploaded to the private Tally server; this differs from browser-local import.
2. Stage CSV or selectable-text PDF, read rows, and set explicit column/date/amount-direction mappings. Map the category column if custom categories are present. Currency cells must match the destination ledger.
3. Correct source rows and preview again. Corrections invalidate prior previews. Invalid rows block commit; duplicates are excluded. Scanned, encrypted, damaged or unsupported-layout PDFs require an unlocked text PDF, CSV or manual entry; no OCR/AI fallback exists.
4. Show the frozen preview with its currency, count, changes and revision. In private shared Tailscale mode, `approvalRequired: false` means the authorized task can proceed directly to commit; do not request an approval or direct the user to the approvals page. Preparing a preview never commits automatically. If `approvalRequired` is true or absent, request owner approval and wait for its decision; do not self-approve.
5. Commit using the returned `planId`, exact `previewHash`, matching `expectedRevision` and one durable key. Include the owner-approved `approvalId` only when required. After interruption, replay the identical request/key. Cancellation after commit does not undo entries.

Delete, batch, clear-month, remove-samples, restore and undo use the same prepare → inspect frozen preview → commit flow, with separate owner approval only when `approvalRequired` is true or absent. A restore accepts only the matching currency, creates a pre-restore backup, and preserves the other ledger. Browser-local data requires an explicit uploaded backup; tools cannot read a browser's localStorage.

## Reports and analysis

Use deterministic month summary/category totals/budget status tools first. Reports return expiring private file handles; read them through `tally_get_file` and the `tally-file://{currency}/{fileId}` MCP resource. Financial descriptions require a detailed-read or export grant; summary access alone does not allow transaction-list reads.

For optional AI, check `tally_get_ai_status`. If unconfigured, explain that setup remains outstanding and use deterministic analysis. Create an analysis context **with the exact question**, request owner consent for its displayed aggregates/question/provider, then ask using that approved context. Editing the question or changing the provider invalidates consent. Poll the request handle. Cancellation is best effort once a provider has processed the request; never automatically retry an uncertain provider call or promise that cancellation avoids charges.

## Failure handling

- `revision_conflict` / `stale_cursor`: refresh; start pagination or review again.
- `idempotency_conflict`: resolve which intent owns the key; do not overwrite its receipt.
- `preview_required` / `preview_mismatch`: send the exact hash returned with the frozen preview; do not invent one.
- `approval_required` / `stale_approval` / `stale_context`: check the discovered mode and obtain a new exact preview/required owner decision. External AI consent always remains required.
- `expired`: prepare a new file/draft/preview; do not substitute a filesystem path.
- `forbidden`: stay within the current grant; owner setup may add an authorized scope.
- `storage_unconfigured`: discovery is enabled but durable shared storage setup is still required; do not invent or mutate records.
- `unavailable`: preserve the request key and inspect/replay the receipt after service recovery.
- `interrupted` AI request: outcome is unknown. Report it and obtain a new deliberate request/consent if the user wants another call.

No tools manage bank credentials, host services, shell commands, SQL, recurring transactions, live investment quotes/trades or tax advice. Such requests need a separate feature or owner administration task. Manual investment observations are available only when the operations below appear in discovery.

## Manual investments and card bills

When discovery lists the investment tools, use `tally_get_investment_portfolio` and `tally_list_investment_valuations` for dated mutual-fund/gold/stock/RD observations. `tally_prepare_investment_change` and `tally_commit_investment_change` use the same frozen preview policy as account changes. Investment account/holding ids are currency scoped. Value is a manually observed total, not price per unit; cost is remaining cost basis. Do not invent quotes, returns, tax, maturity values or financial records. RD terms are explicit monthly instalment, maturity date and optional manual maturity estimate. Valuations append corrections without deleting evidence; archive instead of erasing holdings.

Account create/update accepts optional institution/last-four metadata; credit cards can also record credit limits and dated bill observations. Statement due and recorded debt are different values. Only recorded settlements after the statement day reduce calculated remaining due, including reversals; do not assume bank activity or refunds were imported. Use accounting exports for the investment history.
