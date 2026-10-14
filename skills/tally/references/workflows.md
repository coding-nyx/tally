# Transport and examples

The operator installs this `skills/tally` directory in the agent's skill location and configures the repository's stdio bridge. Do not assume a specific client supports remote OAuth: this release supplies private REST and official-SDK stdio MCP only.

## Start the bridge

For private shared Tailscale mode, supply `TALLY_URL=https://finance.example.ts.net/finance/` and `TALLY_AUTH_MODE=tailnet`; leave `TALLY_ACCESS_TOKEN` unset. For bearer deployments, supply the URL and protected access token instead. Then run:

```sh
npm run agent:mcp
```

No token is passed in a URL or logged. A client can launch the equivalent Node command directly to keep stdout exclusively MCP:

```json
{
  "command": "node",
  "args": ["--experimental-strip-types", "/absolute/path/to/tally/scripts/tally-mcp.ts"]
}
```

Use the client's environment configuration to supply the private URL and auth mode; use its protected secret facility for bearer tokens. An installed Codex CLI can register the token-free stdio bridge with:

```sh
codex mcp add tally \
  --env TALLY_AUTH_MODE=tailnet \
  --env TALLY_URL=https://finance.example.ts.net/finance/ \
  -- node --experimental-strip-types \
  /path/to/tally-mcp.ts
```

Run this on the Tailscale-connected agent host with Node 22.18+ and this checkout/dependencies available. Adjust the checkout path for another machine. This registers stdio, not a hosted HTTP MCP endpoint. The server can advertise tools while storage is unconfigured; calls then return `storage_unconfigured`. The current runtime Docker image does not contain the source stdio bridge.

Do not paste live tokens into this JSON, skill files, chat history or git. Node 22.18+ is the release baseline. The SDK negotiates legacy clients as well as newer stdio protocol versions; actual Codex/Hermes/OpenClaw installation still requires a client-specific smoke check.

## Ordinary entry

1. `tally_get_ledger({"currency":"INR"})` → revision `7`.
2. `tally_list_categories({"currency":"INR"})` → active categories.
3. Call `tally_create_transaction`:

```json
{
  "currency": "INR",
  "expectedRevision": 7,
  "transaction": {
    "kind": "expense",
    "amountMinor": 1250,
    "category": "Groceries",
    "note": "User-selected description",
    "date": "2026-10-13"
  },
  "idempotencyKey": "unique-intent-key-at-least-eight-characters"
}
```

On a transport failure, replay exactly this call. Do not refresh the revision inside a retry: it changes the intent and breaks the receipt match.

## Private REST equivalent

POST `<TALLY_URL>/api/agent` with `X-Tally-Request: 1`, content type JSON (and `Authorization: Bearer <protected token>` only in bearer mode), and a maximum 16 KB legacy control body (Phase B statement/migration commands permit 1 MB when enabled):

```json
{
  "version": 2,
  "tool": "tally_create_transaction",
  "args": {
    "currency": "INR",
    "expectedRevision": 7,
    "transaction": {
      "kind": "expense",
      "amountMinor": 1250,
      "category": "Groceries",
      "note": "User-selected description",
      "date": "2026-10-13"
    }
  },
  "idempotencyKey": "unique-intent-key-at-least-eight-characters"
}
```

GET the same endpoint for schemas filtered by the grant. CLI discovery/calls use the same protected environment:

```sh
npm run agent:cli -- discover
npm run agent:cli -- call '<versioned JSON request>'
```

## File import

The human/operator selects the specific file for upload:

```sh
npm run agent:cli -- upload INR /explicit/user-selected/statement.csv
```

Alternatively POST binary bytes to `api/agent/files?currency=INR`, with content type CSV/PDF/JSON/text and `X-File-Name`. Maximum 10 MB. Upload requires `files:write`. The response's `fileId` is actor/currency-bound and expires after 24 hours.

Then stage → map → correct → preview → inspect → commit (owner approval only when the preview requires it). Suggested signed amount direction is not proof of the bank's debit/credit convention. A currency or invalid-date error must be corrected in source cells; it cannot be bypassed by a transaction override.

The owner reviews pending approvals in the shared workspace `/agents` (under `/finance/` on hub). Bearer mode restricts `GET/POST api/agent/approvals` to the owner credential. Shared Tailscale mode returns `approvalRequired: false` for financial previews. Commit directly with the returned `planId`, `previewHash`, matching `expectedRevision` and a durable key; omit `approvalId`. No approval request or separate browser click is needed. Older servers returning true (or omitting the flag) retain the owner gate. External AI sharing always retains explicit consent. Frozen transaction diffs can be paginated through `GET api/agent/approval-rows?approvalId=...&cursor=...`. The owner must decide the preview hash supplied by the service.

## Downloads

Export tools return file metadata, a relative private path and an opaque id. Read with the MCP `tally-file://INR/<fileId>` resource, or authenticated GET `api/agent/files/<fileId>?currency=INR`. Download files expire after 15 minutes. They are not public share links.

## Optional Phase B workflows

Discover availability first. Account statement sequence: selected upload → `stage_account_statement` with account/period/balances/cutoff → `revise_account_statement` with explicit mapping/reference column → read all `get_account_statement` / `get_statement_matches` pages → `prepare_statement_changes` → inspect frozen preview → `commit_statement_changes` (request/owner approval only when `approvalRequired` is true or absent). Create decisions include one typed journal event and source observation ids; link decisions include a recorded event id; exclusions require a reason. Counterparts may use one event across selected statements or arrive later. Similarity alone never excludes a row.

Then read `get_statement_coverage`; prepare/approve/commit a reconciliation snapshot if desired. A discrepancy is data, never an automatic financial correction. `get_statement_source` returns an expiring private download for retained bytes and their SHA-256.

Legacy sequence: `stage_legacy_migration` (shared snapshot, or an explicitly uploaded matching-currency backup file id) → read `get_legacy_migration` pages/original settings → explicit convert/cutoff/unassigned decisions → `prepare_legacy_migration` → inspect exact preview → `commit_legacy_migration` (owner approval only when required). The original batch stays available. Cutoffs require the reviewed account opening. Shared converted/cutoff rows leave legacy totals; uploaded unassigned rows stay separate. Later completion of unassigned mappings appends review history. No tool changes the deployment/schema or reads browser localStorage.
