# Private standalone deployment

These files build the Node target at `/finance/`. They are portable deployment templates, not a command to change an existing host. See the root [README](../../README.md) for features, runtime configuration and MCP setup.

## New installation

1. Choose protected persistent database/backup storage and secret files outside the checkout. Provision PostgreSQL 17 with a migration role and restricted runtime role. Do not expose its port on the host.
2. Review `compose.yaml`, `tailnet-access.compose.yaml` and `postgres.compose.yaml`. The base finance service publishes only a loopback host port. Reuse an existing authorized private HTTPS gateway; never enable public access as a setup shortcut.
3. Supply `TALLY_AGENT_PUBLIC_ORIGIN`, the stable workspace id, exact observed trusted proxy socket IPs, database root and other required Compose substitutions from a protected operator environment. No `.env` or credentials are committed.
4. Build using `deploy/hub/Dockerfile` (`npm run build:hub`). Keep the router/assets/server functions under `/finance/` consistently. Apply checksum-tracked agent migrations as a separate reviewed operator action, using migration credentials.
5. Start with the restricted runtime connection supplied through `TALLY_AGENT_DATABASE_URL_FILE`. The entrypoint `scripts/start-tally.mjs` reads selected secret files without logging their contents.
6. Verify health, canonical HTTPS redirects, assets/manifest, service readiness and tool discovery. Use a disposable database for write tests before any real import.
7. Verify database restart, backup and isolated restore. Preserve existing route/security configuration, unrelated services and release rollback assets.

The bearer override `agent-tools.compose.yaml` is an alternative scoped-access setup. Do not combine access modes blindly or overwrite a running configuration. A trusted socket IP must come from the actual proxy connection, not client-controlled forwarding headers.

## Existing installation / release

- Inspect the running image, effective Compose files and current release before changes. Take a protected backup before activation.
- Build and verify a candidate separately, with synthetic records and no production mounts/ports. A successful candidate test does not deploy it.
- Activate only the finance image after rollout authorization; preserve the database, private gateway and network settings. There is no schema migration for the manual tracking extension.
- Verify the actual private URL, desktop/mobile rendering and live discovery after activation. Refresh MCP clients independently.
- Never blindly restore an old database or select an older image after financial use; preserve later records and source history.

The current application stores finances in PostgreSQL. Historical notes describing browser-only hosting are superseded. Old browser records remain on their original devices until an explicitly reviewed migration; container/database backups do not contain that old browser storage.

No provider is configured by these templates. No secrets, personal records, live deployment inventory or host-specific addresses belong in public setup documentation.

## Runtime role on a new database

Create `tally_runtime` as a restricted login role before applying migrations, and set its password through the database operator’s protected channel (for example psql’s interactive `\password`, not a literal in shell history). Apply migrations as the database owner/migration role. Grant `CONNECT` on the chosen database and `USAGE` on its schema, then the application needs:

```sql
GRANT SELECT, INSERT, UPDATE ON tally_agent_workspaces, tally_financial_accounts TO tally_runtime;
GRANT SELECT, INSERT ON tally_journal_events, tally_journal_postings TO tally_runtime;
GRANT SELECT, INSERT ON tally_source_files, tally_statements,
  tally_statement_observations, tally_event_sources, tally_reconciliations,
  tally_migration_batches, tally_legacy_decisions TO tally_runtime;
```

Keep runtime `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` and revoke public schema-creation permissions where appropriate for this dedicated database. No runtime DELETE/DDL grant is needed. Migration 0004 conditionally grants its append-only tables if `tally_runtime` already exists; otherwise grant them deliberately after creating the role. Verify with synthetic operations using the runtime connection, not only the migration connection.

The historical `provision-database.py` script is tailored to the existing installation and older activation tooling. It is not a portable new-host installer and must not be run blindly from these instructions.
