# Tally

Tally is a local-first personal monthly budget planner. Transactions and settings are stored in this browser only. It has no account, bank connection, cloud sync, or network intake.

## Developer setup

- Node.js 22.13 or newer; the Docker deployment and CI use Node 22.
- npm 10 or newer.

```sh
npm ci
npm run dev
```

The app is served on `http://localhost:8080`. To start it in the background for a local preview, run `sh startup.sh`; the script resolves the repository directory from its own location and is safe to run again when the app is already responding.

## Checks

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

`npm run build` skips database migration when `DATABASE_URL` is unset. Tally's own data does not use a database. GitHub Actions runs typecheck, tests, lint, the default Vercel build, and the standalone `/finance/` build on Node 22.

## Data, currencies, and recovery

### Private Armbian deployment

`deploy/hub/` contains a standalone ARM64-compatible Docker build, a Compose service bound to loopback, and a Caddy route for `/finance/`. `npm run build:hub` produces the matching router, asset and server-function base path. Normal development and Vercel builds keep `/`.

Tailscale HTTPS forwards to Caddy at `127.0.0.1:9080`; Caddy forwards `/finance/` to Tally at `127.0.0.1:3001` and other paths to the existing Vaultwarden service at `127.0.0.1:8222`. Tally's manifest and install assets are scoped to `/finance/`. No provider secrets are included in the image or Compose configuration.

This hosts the current browser-local release. Hosting does not enable account sign-in, shared database persistence, agent HTTP endpoints, or cross-device sync. Export browser backups regularly; container backups do not contain browser-local financial records. Moving from a local preview to the hosted origin requires an explicit JSON backup export and restore.


- INR is the default for a new browser profile. USD is also supported.
- Switching currency switches to a separate ledger. No exchange rate is applied, and totals are never combined across currencies.
- Amounts remain integer minor units (paise for INR and cents for USD).
- The app saves versioned ledgers in browser `localStorage`. Each month's savings goal and category limits are independent. Empty category limits mean no limit; zero is rejected.
- Legacy `tally.budget.v1` data has no currency field, so migration treats it as USD, preserves its recorded integer cents and transactions, and carries its old single monthly goal into the months represented by the ledger. The original v1 value is left in place as a recovery copy.
- Use **Export backup** regularly. **Restore backup** replaces the backup's matching currency ledger on this device after a confirmation. If saved JSON cannot be read, Tally keeps the original value and offers a raw download or import of a valid backup instead of replacing it with sample data.
- **Import statement** reads CSV files locally in your browser. Text-based PDFs are also extracted on-device with a best-effort column layout, editable cell review, and explicit confirmation. Scanned/image-only PDFs, password-protected PDFs, mixed-currency statements, and layouts without recognizable date and amount columns are unsupported. Choose or confirm the date, description, currency, and signed-amount or debit/credit columns; ambiguous dates require an explicit month/day or day/month choice. Possible duplicates are shown and excluded by default, invalid rows stay out, and nothing is saved until you confirm. Amounts are never converted or relabelled when a statement's currency column or symbol conflicts with the selected ledger.
- **Export CSV** downloads every transaction in the selected currency ledger with date, direction, amount, currency, category, and description. JSON backup remains the full-fidelity recovery format.
- **Export monthly PDF** creates a Tally-branded report for the visible month. It is labeled for personal reference and not presented as a bank-issued statement.
- The **Spending chat** server path supports DeepSeek's OpenAI-compatible chat API and other explicitly configured compatible providers. For local macOS setup, first revoke the key previously pasted in chat, then add a replacement to Keychain Access as a generic password with service `com.tally.deepseek` and account `TALLY_AI_API_KEY`. Launch with `npm run dev:deepseek` to explicitly opt in to reading that item; ordinary `npm run dev` and preview startup do not inspect Keychain. For hosted setup, set server-only `TALLY_AI_PROVIDER=deepseek`, `TALLY_AI_MODEL=deepseek-flash` (or another current model from DeepSeek's official docs), and `TALLY_AI_API_KEY` in the host's secure secret manager. The endpoint defaults to `https://api.deepseek.com`; any override must use that exact host. No provider or credential is configured in this checkout. Do not put keys in `.env`, browser settings, source files, or agent prompts. When enabled, each question requires consent; only monthly totals, savings target, and up to 16 category totals/limits are sent. Transaction descriptions and individual entries stay local. Requests have a 500-character prompt cap, 500-token response cap, 15-second timeout, cancellation, and retryable errors. See [DeepSeek API quick start](https://api-docs.deepseek.com/) and [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/).

### Agent API status

An agent API is being prepared, but no HTTP API or server-side ledger is active yet. The canonical ledger remains in this browser's separate INR/USD `localStorage` records. A local server cannot safely update those records. The approved design proposal is one authenticated, loopback-only service backed by one local transactional store used by both the UI and agent API. Do not migrate data or enable remote writes until the user approves migration. Until then, adapter work and tests use synthetic fixtures only. The final API must validate currency and resource scope, enforce version preconditions, bound list responses, require durable idempotency for retries, and authenticate every read and write.

## Release scope

This release covers local ledger persistence/recovery and migration, monthly category budgets and warnings, INR/USD selection, local CSV and text-PDF statement import, CSV and monthly PDF export, and a provider-configurable consent-gated spending chat. AI answers remain inactive until a provider is chosen and securely configured; trends, reminders, bank connections, accounts, and cloud sync remain out of scope. See [PLAN.md](PLAN.md) for the later roadmap.
