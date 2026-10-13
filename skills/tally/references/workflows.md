# Transport and examples

The operator installs this `skills/tally` directory in the agent's skill location and configures the repository's stdio bridge. Do not assume a specific client supports remote OAuth: this release supplies private REST and official-SDK stdio MCP only.

## Start the bridge

With protected `TALLY_URL` (the full app base, including `/finance/`) and `TALLY_ACCESS_TOKEN` already supplied, run:

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

Use the client's protected environment/secret facility to supply the two variables; do not paste live tokens into this JSON, skill files, chat history or git. Node 22.18+ is the release baseline. The SDK negotiates legacy clients as well as newer stdio protocol versions; actual Codex/Hermes/OpenClaw installation still requires a client-specific smoke check.

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

POST `<TALLY_URL>/api/agent` with `Authorization: Bearer <protected token>`, content type JSON and a maximum 16 KB control body:

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

Then stage → map → correct → preview → request approval → owner decision → commit. Suggested signed amount direction is not proof of the bank's debit/credit convention. A currency or invalid-date error must be corrected in source cells; it cannot be bypassed by a transaction override.

The owner reviews pending approvals in the shared workspace `/agents` (under `/finance/` on hub). Only the owner credential can use `GET/POST api/agent/approvals`. Frozen transaction diffs can be paginated through `GET api/agent/approval-rows?approvalId=...&cursor=...`. The owner must decide the preview hash supplied by the service.

## Downloads

Export tools return file metadata, a relative private path and an opaque id. Read with the MCP `tally-file://INR/<fileId>` resource, or authenticated GET `api/agent/files/<fileId>?currency=INR`. Download files expire after 15 minutes. They are not public share links.
