---
name: tally
description: Operate Tally personal-finance ledgers through its scoped agent tools. Use for Tally transactions, custom categories, monthly budgets/goals, reviewed CSV/text-PDF imports, exports, recovery, audit/undo, or consent-gated spending questions. Use the connected Tally MCP service or private REST/CLI bridge; discover capabilities first.
---

# Tally

## Connect and discover

Call `tally_get_capabilities` and `tally_list_ledgers`. Use the discovered operations and currencies; missing operations mean the credential lacks access. Do not treat a private network connection as authorization. Ask for owner setup when the service is disabled or the grant is expired; do not invent records or credentials.

The repository's `agent:mcp` command provides a stdio MCP bridge. The operator supplies `TALLY_URL` and `TALLY_ACCESS_TOKEN` through protected runtime configuration. Remote HTTP MCP/OAuth is not implemented. For private REST requests and examples, read [references/workflows.md](references/workflows.md). Tool input schemas and scope requirements are in [references/tools.json](references/tools.json); read only the relevant operation.

## Financial rules

- Always choose an explicit authorized currency. INR and USD have independent records and revisions; no exchange-rate conversion or implicit cross-ledger move exists.
- Amounts are positive integer minor units: `1250` means ₹12.50 or $12.50. Never send floats. Dates are `YYYY-MM-DD`, months are `YYYY-MM`.
- Read `tally_list_categories` for the chosen currency and kind. Create a missing category with `tally_create_category` only when the user wants it. Renaming updates transaction and budget references atomically; archiving preserves history and blocks new entries.
- Read the ledger revision before a change. Pass `expectedRevision`. A conflict requires refreshed data and a new preview/intent; do not silently overwrite someone else's edit.
- Reuse the **same idempotency key and identical arguments** after a timeout or disconnect. New intents get new keys. A replay returns the original result even if the ledger changed later. Inspect the operation receipt before assuming a request failed.
- Missing budget means no limit. Use `tally_clear_category_budget`; zero is invalid. Savings targets and budgets must be positive.

## Imports and destructive changes

1. Upload an explicitly selected file using the operator's trusted attachment path or `agent:cli upload`. Tool arguments take an opaque `fileId`, never a server path or external URL. Files selected in the shared workspace are uploaded to the private Tally server; this differs from browser-local import.
2. Stage CSV or selectable-text PDF, read rows, and set explicit column/date/amount-direction mappings. Map the category column if custom categories are present. Currency cells must match the destination ledger.
3. Correct source rows and preview again. Corrections invalidate prior previews. Invalid rows block commit; duplicates are excluded. Scanned, encrypted, damaged or unsupported-layout PDFs require an unlocked text PDF, CSV or manual entry; no OCR/AI fallback exists.
4. Request approval for the frozen preview and give the owner its exact currency, count, changes and revision. The owner reviews and decides in the separate owner interface. An agent's `confirmed: true` or its own approval request is not approval.
5. Commit using the returned `planId`, owner-approved `approvalId`, matching revision and one durable key. After interruption, replay this request. Cancellation after commit does not undo entries.

Delete, batch, clear-month, remove-samples, restore and undo use the same prepare → owner approval → commit flow. A restore accepts only the matching currency, creates a pre-restore backup, and preserves the other ledger. Browser-local data requires an explicit uploaded backup; tools cannot read a browser's localStorage.

## Reports and analysis

Use deterministic month summary/category totals/budget status tools first. Reports return expiring private file handles; read them through `tally_get_file` and the `tally-file://{currency}/{fileId}` MCP resource. Financial descriptions require a detailed-read or export grant; summary access alone does not allow transaction-list reads.

For optional AI, check `tally_get_ai_status`. If unconfigured, explain that setup remains outstanding and use deterministic analysis. Create an analysis context **with the exact question**, request owner consent for its displayed aggregates/question/provider, then ask using that approved context. Editing the question or changing the provider invalidates consent. Poll the request handle. Cancellation is best effort once a provider has processed the request; never automatically retry an uncertain provider call or promise that cancellation avoids charges.

## Failure handling

- `revision_conflict` / `stale_cursor`: refresh; start pagination or review again.
- `idempotency_conflict`: resolve which intent owns the key; do not overwrite its receipt.
- `approval_required` / `stale_approval` / `stale_context`: obtain a new exact preview and owner decision.
- `expired`: prepare a new file/draft/preview; do not substitute a filesystem path.
- `forbidden`: stay within the current grant; owner setup may add an authorized scope.
- `unavailable`: preserve the request key and inspect/replay the receipt after service recovery.
- `interrupted` AI request: outcome is unknown. Report it and obtain a new deliberate request/consent if the user wants another call.

No tools manage bank credentials, host services, shell commands, SQL, transfers, recurring transactions, investments or tax advice. Such requests need a separate feature or owner administration task.
