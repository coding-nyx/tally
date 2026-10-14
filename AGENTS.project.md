# Tally project instructions

This is an existing private finance application with a standalone Node/PostgreSQL deployment. Generic Linux app-builder instructions do not authorize changing its network model or starting servers here.

- Read README.md and docs/RESUME-CHECKPOINT.md, inspect Git changes and check for duplicate work before editing. Preserve all saved work.
- Keep local Tally dev/preview servers off unless the owner explicitly asks to start them. Use isolated synthetic remote QA without published host ports when available.
- Preserve the current dashboard design and platform shell/branding. Consult local design guidance if available, but do not re-scaffold the application.
- One person's finances use one canonical server workspace. Do not create a browser-local financial store or automatically read/import/delete old browser storage. INR and USD remain separate.
- Preserve existing private ingress, trusted-proxy validation, loopback bindings and database isolation. No public exposure, Funnel, LAN listener or authentication-policy change by inference.
- Financial inputs use integer minor units. Openings may be unknown. Transfers/borrowing/principal are not extra income/spending. Posted history uses corrections/reversals, not destructive rewriting.
- UI, REST and MCP must use the same typed service. Keep preview hashes, original intent revisions, idempotency/replay and audit atomicity. Private financial commits do not need the old extra owner click; bearer policy and external AI consent still apply.
- Never import or mutate real financial records for QA. Use synthetic data, verify add/read/update/delete or compensating/archive behavior as appropriate, and clean disposable resources by exact name.
- Do not inspect or change unrelated agent installations. Respect the operator browser selection. Never reuse an exposed provider credential or call/configure external AI as part of maintenance/testing.
- Manual investments are dated observations, not a price feed/trade ledger. Do not imply live NAV, bank/broker integration, EMI amortisation, tax, reminders or automatic payments without implementing and verifying them.
- Verify applicable tests/typecheck/lint/build and real browser output. Inspect desktop and mobile evidence and report unavailable UI/features honestly. An advanced JSON tool console is not a designed consumer form.
- Keep secrets, database dumps, live figures, screenshots and private operational evidence out of Git. Publish portable setup instructions with placeholders. A source sync, merge and deployment are separate actions; preserve saved work; any history rewrite requires explicit owner authorization and a private recovery backup.
