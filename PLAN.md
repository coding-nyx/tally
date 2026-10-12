# Tally plan

Plan only. None of this is built yet. The app today is a manual monthly ledger.

## What exists now

- Income and expense entries, with edit and delete.
- One month at a time: income, spending, and a live remaining balance.
- Spending by category: bar chart, share, and amount.
- One savings goal for the month (short, met, ahead, or overspent).
- Sample entries so a new month is not empty. Remove them to start your own.
- Data stays in this browser (`localStorage`). No account, no database, no bank connection.

## Stack and deployment

| Piece | Choice |
| --- | --- |
| UI | React 19, TypeScript, Tailwind CSS |
| App framework | TanStack Start (file routes) and TanStack Router |
| Build | Vite, production bundle via Nitro |
| Chart | Recharts |
| Dialogs | Radix |
| Icons | Lucide |
| Data today | Browser `localStorage` only |
| Host | Vercel. Publishing from the Grok app builder serves it as a `grok.me` app |

The mini PC, Hermes, and OpenClaw are not part of this deploy. They cannot read `localStorage`. Any automation has to land in a file or an import the app accepts.

## What is missing

- Per-category budgets (for example Groceries $400).
- More than one month on screen: trends, averages, and a simple forecast.
- Alerts when a category or the month crosses its limit.
- Intake that is not hand-typed: CSV, and later a file written by the mini PC.
- Segregation of new rows into categories, with a review step.
- AI analysis of the month, not of every single row.
- Reminders for bills, the savings goal, and rows still waiting for a category.

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

Still inside the app. No model.

- A budget amount per expense category, for the month. Show spent, limit, and what is left.
- Keep the savings goal. It stays separate from category limits.
- A trend view for the last six months: income, spending, and remaining.
- Category totals compared with the same category last month.
- A plain forecast: pace of spending so far this month, projected month-end, and whether the savings goal still fits.
- Alerts in the app when a category hits 80% and when it passes 100%, and when the month is on track to miss the savings goal.

## Phase 2 — Intake and segregation

- CSV import in the app. Columns mapped once (date, description, amount, optional type). Duplicates skipped by date + amount + merchant.
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

## Phase 3 — AI analysis

User-started, once a month, or when they tap Analyze. Not on every keystroke and not on every CSV row.

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

1. Category budgets, six-month trend, and in-app limit warnings.
2. CSV import, duplicate detection, and the merchant map.
3. Review queue, then the single cheap-model categorizer behind it.
4. Monthly analysis on totals only.
5. Recurring bills and reminders, then the Hermes cron that writes the reviewed file and the chat digest.

## Explicitly not in this plan

- Connecting to a bank API or storing bank credentials.
- Letting Hermes and OpenClaw both mutate the ledger.
- Putting personal transactions in a world-readable database without accounts.
- Replacing the remaining balance with model guesses.
