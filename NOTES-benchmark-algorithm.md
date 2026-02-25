# S&P 500 Benchmark — Algorithm Deep Dive

## The Question It Answers

"What if every euro I put into my portfolio had gone into the S&P 500 instead?"

## The "S&P Units" Algorithm

Imagine a parallel universe where, instead of buying Bitcoin, ETFs, and keeping cash
in bank accounts, you put every single dollar into an S&P 500 Total Return index fund.

Every time you do something in the real world — deposit money into an exchange, buy
crypto, add stocks, fund a bank account — the algorithm does the equivalent in the
parallel universe: it looks up the S&P 500 price **on that day** and "buys"
hypothetical units.

**Example:** You deposit $10,000 on a day when the S&P 500 TR index is at 13,500.
The algorithm buys `10,000 / 13,500 = 0.741 units`. If you later deposit another
$5,000 when the index is at 13,600, it buys `5,000 / 13,600 = 0.368 more units`.
You now hold `1.109 units` total.

On any given day, your hypothetical S&P value is: `units * today's S&P price`.

This is the same math a real index fund would use — it's essentially dollar-cost
averaging into the S&P 500 with the exact same timing as your actual investments.

## Why This Is Fairer Than a Simple Comparison

A naive benchmark scales the S&P 500 line to start at the same value as your
portfolio on day 1. But that ignores **when** you added money. If you deposited
EUR 50K in week 1 and another EUR 50K in week 2, a naive comparison assumes all
EUR 100K was invested from day 1 — making the S&P look artificially better or worse
depending on market direction.

The cash-flow-adjusted version tracks the actual timing of every deposit, purchase,
and withdrawal.

## What Counts as a "Cash Flow"

The algorithm tracks activity from the history log:

| Entity Type      | How Value Is Derived                                      |
|------------------|-----------------------------------------------------------|
| Bank accounts    | Balance delta in local currency, converted to USD via FX  |
| Exchange deposits| Direct cash amount, converted to USD via FX               |
| Broker deposits  | Direct cash amount, converted to USD via FX               |
| Crypto positions | quantity * historical crypto price (CoinGecko daily)      |
| Stock positions  | quantity * historical stock price (Yahoo Finance daily)    |

All amounts are converted to USD using the actual EUR/USD (or other FX) rate on the
specific date of each event, not a fixed approximation.

## Currency Handling

- Cash flows are computed in USD (since the S&P 500 TR index is USD-denominated)
- The hypothetical S&P value (`units * sp500Price`) is in USD
- For EUR display: converted using the implicit EUR/USD rate from portfolio snapshots
  (`total_value_eur / total_value_usd`), which gives the actual rate on each date
- This means the benchmark accounts for EUR/USD fluctuations over time

## How It Will Improve Over Time

The activity log was initially backfilled from the current portfolio state. It knows
**what** you hold and approximately **when** each position was created, but treats
each position as a single "created" event.

**Going forward**, every change is logged with full before/after snapshots:
- Edit a crypto quantity? The log captures the exact delta
- Add a new deposit? Logged with the exact amount and date
- Remove a position? Logged as a withdrawal

Over months, the backfilled "day 1" approximation becomes a smaller fraction of the
total picture, and precisely-tracked changes dominate. After a year of use, the
benchmark will be very close to what a dedicated cash flow ledger would provide.

## The "adjusted*" / "naive*" Label

- **adjusted***: Cash-flow-adjusted algorithm is active (activity history available)
- **naive***: Fallback — no activity history. Both lines simply start at the same value.

## Key Files

- `src/lib/actions/benchmark.ts` — `deriveCashFlows()` server action
- `src/components/dashboard/portfolio-chart.tsx` — S&P units algorithm + chart rendering
- `src/lib/prices/yahoo.ts` — `fetchIndexHistory()` for S&P 500 TR + FX rates
- `src/lib/prices/coingecko.ts` — `fetchCoinHistory()` for historical crypto prices
