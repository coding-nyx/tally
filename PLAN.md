# Tally plan

Roadmap for Tally. The current local-first release includes the manual monthly ledger, monthly category budgets and limit warnings, separate INR/USD ledgers, CSV and text-PDF statement import, CSV and monthly PDF export, JSON recovery, and a consent-gated spending-chat panel. DeepSeek is the chosen provider, but its key remains unset until the user configures a replacement securely. Trends, reminders, accounts, investments, tax tracking, and cloud sync are later work.

## What exists now

- Income and expense entries, with edit and delete.
- One month at a time: income, spending, and a live remaining balance.
- Spending by category: bar chart, share, and amount.
- One savings goal for the month (short, met, ahead, or overspent).
- Sample entries so a new month is not empty. Remove them to start your own.
- Monthly savings goals and category budgets, stored separately for each month.
- INR as the new-user default and a separate USD ledger, with integer paise/cents.
- Local CSV statement import with column mapping, direction/date interpretation, duplicate review, and an explicit import step; CSV transaction export and JSON backup/restore.
- Local text-PDF statement import with a review/correction step, plus a Tally-branded monthly transaction report PDF.
- Data stays in this browser (`localStorage`). No account, no database, no bank connection.
- A provider-configurable spending chat with explicit summary-sharing consent. DeepSeek is selected in code/docs, but no key is configured and no model calls are made.

## Stack and deployment

| Piece | Choice |
| --- | --- |
| UI | React 19, TypeScript, Tailwind CSS |
| App framework | TanStack Start (file routes) and TanStack Router |
| Build | Vite, production bundle via Nitro |
| Chart | Recharts |
| Dialogs | Radix |
| Icons | Lucide |
| Data today | Browser `localStorage` only; CSV files are parsed in the browser |
| Current host | Private Armbian hub: Docker, Caddy, and Tailscale HTTPS at `/finance/` |
| Other supported target | Vercel at `/`; selected independently at build time |

The hub hosts the app, but its financial records remain in each browser's `localStorage`. Hermes and OpenClaw are not connected. Automation must use a reviewed file import until an authenticated shared ledger and agent HTTP service are implemented. See `deploy/hub/README.md` for the live routing, boot settings, and operational limits.

## What is missing

- More than one month on screen: trends, averages, and a simple forecast.
- Intake handoff for files written by the mini PC.
- Segregation of new rows into categories, with a review step.
- Securely configuring the chosen DeepSeek provider after the user revokes the pasted key and enters a replacement through the host secret manager.
- Provider-backed month analysis, not of every single row. Consent remains required for each question.
- A versioned agent API. Proposal: one authenticated loopback service over a local transactional ledger shared by the UI and agents. The migration from browser `localStorage` is approval-gated and must preserve both currency ledgers and verify the source before switching the canonical store.
- Reminders for bills, the savings goal, and rows still waiting for a category.
- Multiple named bank accounts with account-level balances and transfers between accounts (deferred; not a first-release requirement).
- Investment holdings and performance tracking (deferred; not a first-release requirement).
- Tax tagging and tax-oriented summaries/reports (deferred; not a first-release requirement).

## Rules for the automation

- Do not give an agent a bank login, a saved bank password, or a browser session on the bank site.
- The only manual bank step is downloading a CSV into one folder on the mini PC.
- Strip each row to date, merchant, and amount before any model sees it. No account numbers.
- Rules first. A model only sees merchants the map does not already know.
- One writer. Hermes cron owns the ledger file. OpenClaw only sends the chat message. Both must not write the same file.
- Recurring items (salary, rent, known subscriptions) are templates. They never call a model.
- A person confirms low-confidence rows before they count as final.
- Do not send the same receipt to Grok, ChatGPT, MiniMax, and DeepSeek.

## Phase 1 — Budgets and spending analysis

The monthly trend and forecast work remains inside the app and uses no model. Category budgets and limit warnings are implemented.

- Completed: a budget amount per expense category for each month, with spent, limit, remaining amount, and near/at/over warnings.
- Keep the savings goal. It stays separate from category limits.
- A trend view for the last six months: income, spending, and remaining.
- Category totals compared with the same category last month.
- A plain forecast: pace of spending so far this month, projected month-end, and whether the savings goal still fits.
- Still planned: an alert when the month is on track to miss the savings goal.

## Phase 2 — Intake and segregation

- Implemented: local CSV import with user-reviewed date, description, currency, signed-amount or debit/credit mapping; ambiguous dates require a format choice, duplicates are reviewed and excluded by default, and import requires confirmation. JSON backup remains the full-fidelity export; CSV export is available for the selected currency ledger.
- Still planned: remember column mappings between imports and add intake for a file written by the mini PC.
- A merchant map stored with the ledger: exact or contains-match to a category. User corrections update the map.
- Rows the map knows are categorized with no model call.
- Unknown rows go to one cheap model (DeepSeek or MiniMax) with the fixed category list and a confidence score.
- Confidence under 0.8 stays in a review queue. Nothing in that queue changes the remaining balance until it is accepted.
- Hermes writes a reviewed CSV or JSON into the drop folder. The app import is the landing spot. Hermes does not drive the Tally screen.

Suggested reviewed-file shape:

```json
{
  "month": "2026-10",
  "entries": [
    {
      "date": "2026-10-03",
      "merchant": "Shell",
      "amount": 42.0,
      "kind": "expense",
      "category": "Transport",
      "confidence": 0.95,
      "source": "rule"
    }
  ]
}
```

## Phase 3 — AI chat and analysis

The in-app chat remains disabled until the chosen DeepSeek provider is securely configured. The implementation has a synthetic-testable provider path but no real key or API calls.

When enabled, use a user-started flow, once a month, or when they tap Analyze. Not on every keystroke and not on every CSV row.

- Input is totals only: income, spending, category shares, budget limits, goal, and the six-month trend. Not the raw statement.
- One stronger model (Grok or ChatGPT) writes a short read: what moved, which category broke its limit, and whether the savings goal is still realistic.
- The text is advisory. It does not change entries unless the user applies a suggestion.
- MiniMax and DeepSeek stay on bulk categorization in Phase 2. They do not also write the monthly narrative.

## Phase 4 — Reminders

Two layers.

In the app:

- Bills marked recurring, with a due day.
- A reminder row when a bill has no matching entry by its due day.
- A mid-month and end-of-month check against the savings goal.
- A nudge while the review queue is not empty.

On the mini PC:

- Hermes cron owns the schedule (morning digest, due-bill check, month-end summary).
- OpenClaw, or the Hermes gateway if that is already the chat app, delivers one message. Example: "14 new, 2 need a category. Rent is due in 2 days. Goal is $657 short."
- Reply in chat ("Shell is Transport") updates the merchant map. The next import is then a rule, not a model call.

## Build order

1. Completed: category budgets and in-app limit warnings. Next: six-month trend.
2. Completed: local CSV import and duplicate review. Next: saved column mappings, intake handoff, and the merchant map.
3. Review queue, then the single cheap-model categorizer behind it.
4. Monthly analysis on totals only.
5. Recurring bills and reminders, then the Hermes cron that writes the reviewed file and the chat digest.

## Explicitly not in this plan

- Connecting to a bank API or storing bank credentials.
- Letting Hermes and OpenClaw both mutate the ledger.
- Putting personal transactions in a world-readable database without accounts.
- Replacing the remaining balance with model guesses.
