# Multiple accounts, credit cards and investments

Requested next scope: one person's multiple financial accounts, credit cards, mutual funds, gold, stocks and recurring deposits (RDs). This extends the existing shared server workspace. No account login, real financial records, provider connection or market-data credential is introduced.

## Account and card tracking

Existing bank/cash/card/loan accounts and balanced journals remain authoritative for recorded balances. Optional institution and last-four identifiers help distinguish multiple accounts without requesting full account/card numbers. Openings remain explicit and unknown openings remain unknown. Transfers and card repayments move assets/settle debt without becoming spending again.

Credit card limits and immutable dated bill observations are added to account metadata. A bill records end-of-day statement date, payment due date, total due and minimum due. The selected as-of date uses the latest recorded statement date; later observations for the same date correct its displayed values while keeping prior observations. Remaining due/minimum subtract recorded card-payment journals strictly after statement day, including reversals of those payments. Negative due is clamped to zero. A refund or unrecorded bank transaction is not automatically assumed to satisfy a bill. Available credit is a recorded limit minus known recorded debt; pending/unknown bank activity is excluded. Due data is distinct from account outstanding debt.

## Investment tracking

The Investments workspace groups holdings under named investment accounts/institutions. Supported holding types are mutual funds, gold (grams), stocks and RDs. Stable holding ids, optional symbol/ISIN/reference, manual quantity, remaining cost basis and total observed market/deposit value are recorded. Monetary amounts use bounded integer minor units; quantities are decimal strings with at most eight fraction digits, not floating-point money.

Dated valuation observations are append-only, including corrections. As-of views choose the latest effective date; on the same date the last recorded observation wins. A holding with no observation by that date has unknown value, and the active portfolio total stays unknown. Archived accounts/holdings retain their history and are excluded from current tracked-scope totals; this is a valuation date view of the current tracking scope, not a historical lifecycle reconstruction. Gains are observed value minus remaining cost basis. They are not total return, realised gain or tax calculations. Portfolio values are separate from bank/card journal assets to avoid silently double-counting manually recorded positions.

RD observations also retain monthly instalment, maturity date and optional expected maturity value. Expected maturity is a manual estimate; no interest rate, tax model, auto-debit, missed-instalment inference or reminder is invented. Contributions/redemptions are recorded by updating the dated position snapshot and separately recording actual bank journal activity as appropriate. There is no automatic bank posting, order placement, price/NAV feed, SIP schedule, corporate-action or trade/capital-gains ledger in this first manual tracking slice.

## Service and persistence

Four additive scoped operations expose portfolio reads, paginated valuation history, prepare and explicit commit through the same website/REST/MCP service. They reuse accounts read/write scopes and the existing revision, frozen hash, actor, currency, expiry, receipt/replay and audit checks. Private shared mode requires explicit commit of the exact preview; bearer approval behavior is retained. Detailed entries never fall back to browser storage. New financial inputs preserve their starting revision or frozen preview revision rather than rebasing a stale intent on refresh.

Investment metadata/history lives in the canonical locked workspace JSONB document; existing account/card documents remain in normalized account rows. Both are committed in the same database transaction as receipts/audit. No database migration is required. Legacy prepare/restore/undo paths preserve the investment extension. Accounting exports include investment accounts, positions and all observations. The export format is additive; this does not introduce an investment-backup restore workflow. Existing persistent database backups retain all of it.

Bounds: 100 investment accounts, 1,000 holdings and 10,000 observations per currency; 500 bill observations per card. The two native currency ledgers stay separate. No implicit FX/consolidated valuation is provided.

## Verification status

The following records the earlier focused tracking milestone. The subsequent full application audit is recorded in the [UI/UX review](ui-ux-review.md).

The focused local suite passed **42 tests**, including actual SQL adapter persistence/restart with embedded PostgreSQL, immutable corrections, as-of unknowns, history paging, replay, stale previews, currency/scope rejection, RD validation, archive/restore preservation, legacy preview isolation, card settlement/reversal arithmetic, bill-preview date and unchanged expense totals. Typecheck and targeted lint pass with zero warnings/errors. Runtime/check source verification covered 150 files with zero mismatches.

The standalone ARM64 candidate build passed; exact image/source hashes are retained with private local QA evidence. The final isolated integration session exited 0. Real SDK MCP stdio calls passed through verified fixture TLS and synthetic private ingress into the compiled runtime and PostgreSQL 17. Financial records were created through MCP/browser operations rather than SQL seeds.

Actual checks covered MCP account/four-type holding creation, durable exact replay and bridge restart; a browser valuation preview without posting followed by explicit commit; two-browser portfolio agreement; paginated original/corrected observations; rejection and cancellation of a stale MCP archive preview; currency isolation; a browser card-bill commit; MCP card repayment reducing both debt and statement due without increasing expenses; zero owner approval objects; and zero financial browser-storage accesses. Both desktop and mobile rendered without unexpected console/page errors or horizontal overflow. All four screenshots were visually inspected. The mobile card capture shows the header revision still loading, with controls disabled as designed; it confirms figures/layout, not post-refresh input readiness. Desktop input/commit and the revision guard have separate verification.

The isolated run identified and fixed explicit selector names, an account/report revision-loading race, readable investment previews and card-bill preview dates. Earlier failing runs are retained as failure evidence. Disposable containers/network were removed, and production container identities/start times/images and current release were unchanged. Mac dev/preview servers remain off.

Evidence is retained locally under ignored `artifacts/investment-tracking/final/` and `screenshots/investment-tracking/`. This was a synthetic ingress test, not a real Tailscale hop. Public fonts and the platform extension script were cached unchanged for the outbound-isolated browser; no ledger or MCP response was mocked. Installed agent clients, exhaustive load/concurrency and full backup restore were not tested.

## Rollout status and boundaries

The deployed dashboard fix and its GitHub synchronization (`4c6ca23` on `feature/agent-tools`) are separate completed milestones. **The tracking extension is candidate source and is not deployed. Production still runs the earlier server-dashboard release.** The subsequent documentation/UX task authorizes source synchronization; see the resume checkpoint for its final status. Before rollout, take a protected backup, activate only the tested finance candidate image and verify the actual private URL/tool discovery. No database migration or network/access-policy change is needed.

Values are manually entered dated observations. Live quotes/NAV, broker/bank connections, orders/trades, SIP or RD auto-debits, reminders, investment cash-journal linkage, realised returns and tax calculations are outside this slice. No real financial records were imported or altered in these tests.
