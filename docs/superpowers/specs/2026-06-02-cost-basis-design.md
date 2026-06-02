# Cost Basis & Realized/Unrealized P&L — Design Spec

**Status:** Reviewed — round 2 incorporated · **Date:** 2026-06-02
**Branch:** `feat/cost-basis` (stacked on `feat/historical-prices-chart` / PR #94)
**Decision:** Scope **A + B** (total P&L + benchmark **and** average-cost / realized-unrealized split)

---

## 1. Summary

Let the user record the **actual amount paid/received** (incl. fees) and the **date** for every
transaction of an asset — on existing entries as well as new ones — so the app can:

1. compute **accurate gains/losses** (total, and split into realized vs. unrealized, with average buy price), and
2. feed the **S&P benchmark** the correct cash-flow amount at the correct (possibly backdated) date.

The chart's value line is **untouched** — it always uses market price. Cost feeds only P&L and the
benchmark. The feature is a thin, mostly-additive layer over the existing `activity_log` (which already
records every mutation): a new per-transaction **Transactions drawer**, a **cost field**, a **yield**
classifier, and a pure **average-cost engine**.

---

## 2. Goals / Non-goals

**Goals**
- Capture/edit **amount paid (buys) / received (sells)** + **date** per transaction, on new and **existing** entries.
- Classify income as **Yield** (cost €0, excluded from benchmark contributions).
- Per-asset **average cost · unrealized · realized · total P&L**; portfolio totals; corrected benchmark.
- A per-asset **Transactions drawer** (a lens on `activity_log`) reachable from each holdings row.
- **Split** an existing lot into multiple dated **cost** legs (extends the existing split feature).
- Fix the latent **backdate-stale-amount** benchmark bug.
- Work **uniformly** across crypto, stocks, and cash; consistent, **self-explanatory** modals.
- **Uniform treatment of existing + new entries** — older imports/transactions behave identically to new
  ones, with no two-tier system and (almost) no migration (§7.6).
- A faint **cost-basis overlay line** on the dashboard chart (the gap to the value line = unrealized gain,
  visualized over time) — additive, cheap (no price lookups; §12 Phase 5). The *value* line is untouched.

**Non-goals (explicitly parked / rejected — see §14)**
- Bulk **auto-detect**-and-reclassify of recurring interest (parked; v1 ships *manual* multi-select Mark-as-Yield).
- FIFO / specific-lot / tax-lot accounting (rejected — average-cost only; rationale §4.4).
- Dedicated per-asset detail pages (later; the drawer covers v1).
- Changing how the **value** (truth) line is drawn — it stays market-price. *(The new cost-basis overlay is a
  separate, additive line; the value line itself is out of scope.)*

---

## 3. Background: what already exists (and is reused)

- **`activity_log`** records every mutation (created/updated/removed) with before/after snapshots,
  `effective_date`, `is_adjustment`, `transfer_group_id`, `split_from_id`, and **pre-computed cashflows**
  (`cashflow_amount_usd/eur`, `cashflow_status`) + deltas (`delta_*`).
- **`logActivity()`** already accepts `cashflow_amount_usd/eur` + `cashflow_status` as params
  (currently filled by the auto-computed `computeActivityFx()`), so "override the amount" is **threading a
  user number into an existing param**, not a schema change.
- **S&P benchmark** (`deriveCashFlows` in `benchmark.ts`) reads `cashflow_status='complete'` rows; backdated
  lots are handled by PR #94's `buildBenchmarkCashFlows` + `^SP500TR` extension; seed in `chart-enrichment.ts`.
- **Transfers** (`transfers.ts`) are two-legged, both legs `is_adjustment=true` → **benchmark-neutral**
  (models internal moves; prevents double-counting).
- **Splits** (`splitActivityEntry` in `splits.ts`) already divide one entry into ≥2 dated child legs
  (conserving quantity); `backdateActivityEntry` sets `effective_date` on an existing entry.
- Holdings rows already **expand** to show the **wallet/broker distribution** (`crypto-table.tsx`); the
  position editor edits **per-wallet quantities**. → Both own the *where-held* (wallet) axis.

---

## 4. Domain model & core concepts

### 4.1 The two axes of an asset
- **Where held** — wallet / broker. Owned by the row expansion + position editor. *Untouched by this feature.*
- **When/how acquired** — the transactions (buys, sells, yield). Lives in `activity_log`; surfaced by the
  new **Transactions drawer**. *This is the cost/date axis.*

### 4.2 The portfolio-boundary model (drives benchmark inclusion)
The benchmark counts only crossings of the **portfolio boundary**; everything internal is excluded.

| Event | Nature | Benchmark | Cost-basis effect |
|---|---|---|---|
| **Buy** (new external money → asset) | external **in** | counts (+contribution) | adds units at **cost = amount paid** |
| **Deposit** (salary/savings → cash) | external **in** | counts (+contribution) | adds cash at face value |
| **Sell** (asset → proceeds) | disposal | see §7.3 | **realizes gain** (`proceeds − avg-cost×units`) |
| **Withdrawal** (cash → spent/out) | external **out** | counts (−contribution) | removes cash |
| **Yield** (interest/staking/airdrop) | internal **return** | **excluded** | adds units at **cost €0** (full value is gain) |
| **Transfer** (asset ↔ cash, wallet ↔ wallet) | internal **move** | **excluded** (`is_adjustment=true`) | cost-neutral at asset level (§7.4) |

**Rationale for Yield exclusion** (a user challenged "yield could've been in the S&P"): yield is money the
*portfolio generated* (internal return), not money brought in from outside. The benchmark seeds **both**
worlds with the same external contributions and lets each grow on its **own** internal returns (your yield;
the S&P's dividends via `^SP500TR`). Counting yield as a contribution would hand the S&P side capital that
only existed because you held the yielding asset → double-count. The *opportunity cost* of low-yield assets
is captured automatically by the value comparison over time. (Withdrawing yield to spend **is** a counted
outflow; earning it is not a flow.)

### 4.3 Cost is **date-independent**; only the benchmark/chart need the date
All P&L figures are pure `money ÷ quantity` arithmetic — **no date input**. So approximate/forgotten dates
do **not** affect P&L; the date only affects the chart x-position and which S&P price the benchmark buys at
(both already graceful). This is why **FIFO is rejected** — it matches sells to buys by date *order*, so
fuzzy dates produce misleadingly-precise wrong realized gains. Average-cost is order-independent and robust.

### 4.4 Average-cost (the only method)
`avg cost = total cost ÷ total units`. On a partial sell, cost removed = `avg-cost × units sold`. This is
the only method that needs no per-lot date precision. Total P&L (`current value + Σproceeds − Σcost`) is
identical under any method; only the *realized/unrealized split* depends on method, and average-cost is the
right fit for a personal, date-approximate tracker.

### 4.5 Lumped accumulation (DCA entered as one lot)
Entering years of buys as one dated lot does **not** skew cost basis/P&L (date-independent, given the true
*total* cost). It only skews the **benchmark timing**. Fix: **Split** the lot into dated cost legs (§7.5),
or accept the lump dated at the *weighted-middle* of accumulation.

---

## 5. Data model changes

Minimal and additive. Two new boolean columns; the rest reuses existing fields.

### 5.1 New columns
```sql
-- migration NNN_transaction_cost_basis.sql
ALTER TABLE activity_log
  ADD COLUMN is_yield          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cashflow_user_set BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN activity_log.is_yield IS
  'Transaction is income/return (interest, staking, airdrop): units added at cost €0, excluded from benchmark cash flows. Distinct from is_adjustment (corrections/transfers).';
COMMENT ON COLUMN activity_log.cashflow_user_set IS
  'True when the user explicitly typed the amount (cost/proceeds); false = auto-computed market value. Backdate-recompute (§7.2) only touches false rows.';
```
- **No backfill** (existing rows default `false` for both — correct: none are yet yield, none had a
  user-typed amount). Regenerate `src/types/database.ts` after; CI drift-check enforced.

### 5.2 Cost = the existing `cashflow_amount_usd/eur` (now user-authored)
- **Buy/Sell:** `cashflow_amount_*` = the user-entered amount (cost / proceeds). If left blank, falls back
  to the current auto-computed `qty × market price × FX` (today's behavior). This makes cost **optional with
  a market fallback**.
- **Yield:** `is_yield=true`, `cashflow_amount_* = 0` (cost €0). The "total yield earned €" figure is
  **derived** (`units × historical price`) for *display only* — never stored/typed. It is the one yield number
  that needs a historical-price lookup; the core P&L math (avg/realized/unrealized) is price-free and does not
  depend on it.
- **Currency:** the amount is entered in EUR or USD (toggle); the other is computed via FX-at-`effective_date`
  (existing `toUsdAndEur`). Stocks may enter in native trading currency (same conversion path).

### 5.3 Split legs carry per-leg cost
`SplitLeg` gains an optional `cost` (in the leg's currency). `splitActivityEntry` uses the entered cost for
each child's `cashflow_amount` instead of the current proportional-by-quantity division. Constraint:
Σ(leg quantity) = parent quantity (existing); Σ(leg cost) is shown but **not** forced to equal the parent
(user may be correcting the total). See §7.5.

---

## 6. The average-cost engine (pure module)

`src/lib/portfolio/cost-basis.ts` — a pure, unit-tested function. Operates on an **asset's total quantity
across wallets** (so wallet↔wallet transfers net to zero and never create a cost event; only real
acquisitions/disposals move the totals — see §7.4).

It runs **independently per display currency** (EUR and USD): each pass uses that currency's stored
per-transaction amounts and is internally consistent; the two results legitimately differ by exchange-rate
timing and are **never cross-reconciled** — **EUR (base currency) is authoritative** for the headline P&L
(§7.7).

**Quantity per transaction** comes from a single helper `quantityDelta(txn)` — *not* a bare
`unitsAfter − unitsBefore` — because some rows have **null snapshots**: split children carry the amount in
`details.split_quantity` (signed by `action`), `removed` rows zero the position. The helper centralizes all
of this (mirrors #94's `qty_delta_override`) so the engine can never hit `null − null = NaN`.

```
computeCostBasis(transactionsAsc, currentMarketValue) -> {
  avgCost,          // remaining cost ÷ remaining units (0 if no units)
  costBasis,        // remaining cost of currently-held units
  realized,         // Σ over sells of (proceeds − avgCostAtSale × unitsSold)
  unrealized,       // currentMarketValue − costBasis
  totalPnL,         // realized + unrealized
  totalYieldValue,  // Σ over yield txns of (units × price-at-date)  [derived, for display]
}
```

**Pre-step — net transfer legs by `transfer_group` within the asset** (this is what makes wallet moves
cost-neutral): a group whose legs are *all* this asset (wallet↔wallet move) nets to **qty 0** → skip
entirely (cost carries over, no realized, no step-up). A group with one leg on this asset (cross-asset, e.g.
crypto→cash) leaves a single net **disposal/acquisition at the moved value**. The remaining stream then has
exactly four kinds: **buy, sell, yield, correction** (a bare `is_adjustment` with no `transfer_group_id`).

Algorithm (per asset, transactions sorted by `COALESCE(effective_date, created_at)`, post-netting):
```
units = 0; cost = 0; realized = 0
for txn in stream:
  qtyDelta = quantityDelta(txn)                       // helper: snapshots, or details.split_quantity for null-snapshot rows
  if qtyDelta == 0: continue
  value      = txn.transfer_group_id ? |txn.delta| : |txn.cashflow_amount|   // € value of this flow/leg
  isCorrection = txn.is_adjustment and not txn.transfer_group_id and not txn.is_yield

  if txn.is_yield:            units += qtyDelta                              // earned units → cost += 0
  elif qtyDelta > 0:                                                         // acquisition
       if isCorrection:       units += qtyDelta                             // balance-up fix → cost += 0
       else:                  units += qtyDelta; cost += value              // BUY (amount paid) / TRANSFER-IN (moved value)
  else:                                                                     // qtyDelta < 0 — disposal
       avg = units > 0 ? cost/units : 0; out = -qtyDelta
       if isCorrection:       cost -= avg*out; units -= out                 // balance-down fix → no realized
       else:                  realized += value - avg*out; cost -= avg*out; units -= out  // SELL (proceeds) / TRANSFER-OUT (realizes)
costBasis = cost
avgCost   = units > 0 ? cost/units : 0
unrealized = currentMarketValue - costBasis
totalPnL  = realized + unrealized
```
**Invariant:** `totalPnL` must equal `currentMarketValue + Σproceeds − Σcost` (method-independent identity) —
asserted in tests. Guards: `units→0` (no divide-by-zero), re-buy after full exit (avg restarts cleanly from
0/0), float tolerance on the zero-crossing. Transfers and corrections each get dedicated tests (§10).

---

## 7. Behavior details

### 7.1 Cost override + the optional/fallback contract
Buy/Sell modal "Amount paid/received" is **optional**. Filled → sets `cashflow_amount_*` (+ `cashflow_status='complete'`)
**and `cashflow_user_set=true`**. Blank → existing market-derived value. Never coerce a blank to 0 (mirrors the
cash modal's NaN-guard lesson). **`cashflow_user_set` flips to `true` only when the amount is actually
entered or changed** — never on a no-op save of a pre-filled market value, or backdate-recompute (§7.2) would
silently stop working on an untouched row.

### 7.2 Backdate recompute (fixes the latent bug)
`backdateActivityEntry` today changes only `effective_date`, leaving a stale import-date amount → benchmark
overstates. **Fix:** on backdate of a real cash-flow entry, if `cashflow_user_set = false` (no user-authored amount),
**recompute** `cashflow_amount_* = qty × historical-price(new date) × FX` (PR #94 historical-price path). If
`cashflow_user_set = true`, **keep** the user's amount. Either way the stale import-date amount never
survives a re-date. (The flag is set `true` whenever the user types/edits the amount — §5.1.)

### 7.3 Sells and where proceeds go
A Sell always **realizes gain** for cost basis (`proceeds − avg×units`), independent of the proceeds'
destination. For the **benchmark**: if proceeds leave the portfolio it's an external outflow (counted); if
they land in tracked cash it's internal (model via **Transfer** → neutral). The modal guides this (§8.5).

### 7.4 Transfers (netted by `transfer_group` within the asset — §6 pre-step)
A wallet↔wallet move (both legs the same asset) nets to **zero** quantity change → **no cost event**
(cost-neutral carryover; no realized, no step-up). A cross-asset transfer (e.g. crypto→cash) leaves a single
net **disposal** on the source asset → realizes gain at the **moved value** (`|delta|`); the destination
(cash) acquires at that value. Transfer legs stay `is_adjustment=true` (benchmark-neutral — internal move),
so cost-basis realization and benchmark inclusion are deliberately **decoupled**: a transfer realizes gain
for P&L but is *not* an external flow. **Fees:** a transfer whose asset-level net remainder is non-zero (you
send 1.000, receive 0.999) is a **fee** — the lost units are a disposal at **€0 proceeds**, i.e. a small
**realized loss equal to their cost basis**, never a spurious gain (§10 case 24).

### 7.5 Split into dated cost legs
Extends `splitActivityEntry`: each `SplitLeg = { effective_date, quantity, cost? }`. Children get the entered
per-leg cost (fallback: proportional, as today). Parent preserved as `undone` (reversible via `unsplit`).
Quantities must sum to the parent. Used to reconstruct DCA so the benchmark sees dated flows (§4.5).

### 7.6 Existing data behaves like new data (uniformity — no two-tier system)
A hard requirement: after this ships, **older imports/transactions are processed by the exact same code as
new ones.** This falls out (almost free) of two earlier choices — classification is **derived** and all
P&L/benchmark numbers are **read-time** — so there's no legacy state to migrate.

| Aspect | Existing entries today | Uniform? | Action |
|---|---|---|---|
| **Type** (buy/sell/deposit/withdrawal/transfer) | derived by `classifyTransaction()` from fields they already have (`is_adjustment`, `transfer_group_id`, `is_yield`-default-false, qty direction, entity) | ✅ automatic | none |
| **Cost amount** | auto market-value + `cashflow_user_set=false` (default) | ✅ identical to a *new* entry with no typed cost (market fallback) | optional: type real costs later via Edit |
| **Backdating** | recompute-to-market-at-date (no user cost) | ✅ same rule | none |
| **Editing** | full Add field-set incl. **type reclassification** (§8.4) | ✅ same flow | as desired |
| **77 Feb-2026 imports** | #94's legacy-adjustment migration → `is_adjustment=false` real cash flows, market-value cost | ✅ become normal buys/deposits | optional: enter true costs |
| **Existing Yield** (e.g. GHO interest) | default `is_yield=false` → reads as deposit/buy until reclassified | ⚠️ **one cleanup** | Mark-as-Yield |

**The single cleanup — existing Yield.** Interest/staking entries can't be auto-classified (data alone can't
tell yield from a deposit — needs user knowledge). To make it painless and reach full uniformity, v1 adds a
**multi-select "Mark as Yield"** in the drawer (select GHO's ~14 interest rows → one action). The *automatic*
heuristic detector stays parked (§14). After this one pass, old and new yield are identical.

**Why (almost) no migration:** the only new stored fields are `is_yield` (default `false` — correct for every
existing non-yield row) and `cashflow_user_set` (default `false` — correct, none were user-set). Everything
else is derived or read-time. Re-classifying or re-costing an old row is a normal **Edit**, and the benchmark
+ P&L recompute on the next render (the value snapshots are untouched — quantity/worth don't change).

### 7.7 Multi-currency P&L (EUR authoritative; never reconciled)
The engine runs once per currency. Because each purchase was converted to EUR and USD at the FX rate **on its
own date**, the EUR avg-cost and the USD avg-cost will **not** equal each other under today's FX — and that is
**correct** (forcing them to match would pretend you paid today's rate on a past buy). So **EUR (the user's
base currency) is authoritative** for the headline "you're up €X"; USD is the secondary view (the app's
existing dual-currency pattern). The two are **never cross-reconciled**; a one-line tooltip notes they can
differ due to exchange-rate timing. A stock in a third native currency converts into both EUR and USD at
`effective_date` (existing `toUsdAndEur`).

### 7.8 Manual-NAV assets (ELTIF/SICAV) — a simpler cost path
These have no `qty × market-price`; the fund reports a periodic **NAV** you record by hand, so forcing them
through the unit engine is wrong. Instead: **cost = Σ(subscriptions) − Σ(redemptions)** (the cash you put in,
captured via the same Amount field), **value = latest NAV**, **total P&L = value − cost**. The per-unit
**average cost and the realized/unrealized split are skipped** (no tradeable units to average or realize) —
they render "—". Cash **distributions** are **Yield** on the receiving cash account. This keeps these holdings
in the P&L picture (no two-tier gap) without distorting the unit engine.

---

## 8. UX design (consistent, self-explanatory) — the heart of the feature

> Design principles: **add no new always-on column** (tables are width-tight); **ride existing affordances**;
> **one unified "Add transaction" flow** with a clear **type selector** + inline guidance so the user is led
> to the correct choice; follow established modal conventions (`space-y-4`, `text-xs text-zinc-400 mb-1`
> labels, dark theme, `focus-trap-react`, `role="dialog"`, `role="alert"` on errors, `accent-amber-500`
> reserved for adjustments).

### 8.1 Row affordance — a "Transactions" (history) icon
Each holdings row's action cluster (crypto/stock/cash tables) gains a **history icon** beside Edit/Delete
(hover-revealed; no new column). Opens the **Transactions drawer** for that asset. Distinct from the wallet
expansion and the position editor (which keep the *where-held* axis).

### 8.2 The Transactions drawer (per-asset lens on `activity_log`)
- Right-anchored panel: header `{Asset} · Transactions`, a one-line summary (`held · value · cost · P&L`),
  the transaction list (newest-or-oldest first; sortable by date), and footer actions **+ Add transaction**
  and **Split a lot**.
- **Grouping for long lists (yield assets like GHO):** consecutive **Yield** entries collapse into a single
  expandable row ("+ N more weekly accruals (€lo–€hi · date→date)"); a **type filter** (All · Buys · Sells ·
  Yield) is available. Prevents a HODL+yield asset from becoming a wall of rows.
- Each row: **type badge** (color-coded), quantity, amount (cost/proceeds, or "—" for yield), date, and an
  inline **edit** pencil. Editing expands the row into the edit form in place (§8.4).
- Empty state: "No transactions yet — Add the first one."

### 8.3 The Add-transaction modal — **type selector + guidance**
A single modal with a prominent **type selector** whose options + helper text adapt to the asset class.
Selecting a type shows exactly the fields that type needs (no irrelevant fields), each with a short
explainer so the user is *guided to the proper selection*.

**Type vocabulary by asset class** (same concepts, asset-appropriate labels):

| Asset class | Type options |
|---|---|
| Crypto / Stocks / Manual-NAV | **Buy · Sell · Yield · Transfer→** |
| Cash | **Deposit · Withdrawal · Yield · Transfer→** |

**Per-type fields + guidance text (shown under the selector):**

| Type | Fields | Inline guidance (verbatim intent) |
|---|---|---|
| **Buy** | Quantity · Amount paid (€/$ toggle) · Date | "Bought with **new money** you added. Moving cash you already track into this? Use **Transfer** instead — otherwise it double-counts against the S&P." |
| **Sell** | Quantity · Amount received · Date | "Sold for cash/proceeds. Realizes gain/loss. If the cash stays in an account you track, record it as a **Transfer**." |
| **Yield** | Quantity received · Date | "Interest, staking, rewards or an airdrop — units you **earned, didn't pay for**. Counted as profit (cost €0); not a contribution to the S&P comparison." |
| **Deposit** (cash) | Amount · Date | "**External money in** (e.g. salary, savings). Counts as a contribution in the S&P comparison." |
| **Withdrawal** (cash) | Amount · Date | "Money leaving your tracked portfolio (spending). Counts as a withdrawal in the S&P comparison." |
| **Transfer →** | (routes to the existing Transfer dialog) | "Move value **between accounts you already track** (e.g. cash → crypto). Doesn't affect the S&P comparison — it's internal." |

- **Amount is optional** for Buy/Sell with a clear hint: "Leave blank to use the market value on that date."
- **Adjustment** is *not* a primary type (it's a correction): reachable via an "Advanced" affordance or the
  existing adjustment checkbox, keeping the amber `accent-amber-500` convention. Not surfaced as a normal type
  to avoid confusing corrections with real activity.
- Validation: numeric amount (NaN-guarded, never coerced to 0), positive quantity, past-or-today date
  (`validatePastOrTodayDate`), `role="alert"` errors. Currency validated.

### 8.4 The Edit (existing transaction) flow — the primary use case
The same field set as Add (incl. the **type selector**), pre-filled, opened inline from a drawer row's pencil.
Editing **Amount paid**, **Date**, **or the type/classification** of a real cash-flow entry **corrects that
entry** — it does **not** create a phantom transaction:
- **Amount / Date** → updates `cashflow_amount_*` / `effective_date` (recompute contract §7.2).
- **Type → Yield** (e.g. an existing GHO "deposit" → Yield): sets `is_yield=true`, `cashflow_amount_*=0`
  (cost €0); the entry drops out of benchmark contributions and the engine treats its units as €0-cost. The
  benchmark line de-inflates and P&L corrects on the next render (read-time; value snapshots untouched).
  This is the same recompute the existing adjustment-toggle performs, generalized to the yield flag.
- **Bulk:** a drawer **multi-select → "Mark as Yield"** applies the above to several rows at once (the
  one-pass cleanup of §7.6). Reversible (re-edit back to its derived type).

Guards: cannot edit a transfer leg's amount here (edit via the transfer flow); cannot edit an
`undone`/split-child entry (unsplit first) — mirrors `backdateActivityEntry`'s existing guards, surfaced as
friendly messages.

### 8.5 Double-count prevention (Buy vs Transfer)
The Buy/Sell guidance text (above) plus an optional inline nudge: when adding a **Buy** on an asset while
the user holds tracked cash, a subtle hint "Using money from a tracked account? → Transfer." No hard block
(user may genuinely add external money), but the guidance makes the correct path obvious.

### 8.6 Display surfaces (A + B)
Per-asset, in the holdings table and/or the drawer summary:
- **Average cost** (per unit), **Unrealized**, **Realized**, **Total P&L** (€ + %). Color via existing
  `changeColor`. Realized hidden/`—` when zero (pure-hold assets) to reduce noise.
- **EUR (base currency) is the authoritative headline P&L**; USD is the secondary dual-currency view (§7.7).
  Manual-NAV assets show **total P&L only** (avg/realized/unrealized = "—", §7.8).
- Portfolio-level **Total P&L** stat on the dashboard. The S&P line is corrected (cost-accurate, yield-excluded).
- Reuse existing responsive column-hiding (`HIDDEN_BELOW`); P&L columns hide first on narrow screens, full
  detail always available in the drawer.

---

## 9. Server actions (new / modified)

- `src/lib/actions/transactions.ts` (new): `addTransaction(assetRef, {...})`, `editTransaction(entryId, patch)`
  — both validated, `revalidateDashboard()`, Sentry-wrapped (`captureAction`). **Ownership is verified in the
  action layer, not just relied on via RLS:** `editTransaction(entryId)` MUST re-fetch with
  `.eq('id', entryId).eq('user_id', user.id)` and 404 if absent — exactly the cross-user gap PR #97's review
  caught (an RLS policy is necessary but a direct-by-id mutation must still confirm ownership in the action).
  Thin orchestration over existing `upsertPosition` / cash-account / `logActivity`.
- `splits.ts`: extend `SplitLeg` with `cost?`; `splitActivityEntry` uses it.
- `backfill.ts` / backdate path: implement the recompute-on-backdate contract (§7.2).
- `benchmark.ts`: `deriveCashFlows` excludes `is_yield=true` and uses the (now user-authored) `cashflow_amount_*`
  — **the actual amount invested** — at `effective_date`. **⚠ Interaction with PR #94's seed (the single most
  delicate change):** the benchmark *should* invest your real cost (the whole point — "what if I'd put the
  money I actually spent into the S&P"). But #94's seed self-reconciles to ≈0 *only* under its assumption that
  the benchmark flow = `qty × market-price(date)` (the truth-line value). With **cost ≠ market on a backdated
  lot**, a **real, correct seed delta** appears (= market − cost at that date = your instant unrealized gain at
  purchase): the benchmark line legitimately starts at what you *invested* (cost) while the portfolio line
  starts at *market value*. #94's seed / `buildBenchmarkCashFlows` must be adjusted to **allow** this delta
  (not cancel it) **without re-triggering the double-count guards**. Scoped to *backdated lots that carry a
  user cost* (recent/at-chart-start lots have cost≈market → delta≈0 → #94 unchanged). Dedicated tests vs.
  #94's seed cases under cost≠market + a live-smoke reconciliation (§10 case 25).
- `src/lib/portfolio/cost-basis.ts` (new pure module): the average-cost engine (§6).
- Thread cost-basis outputs into `aggregate.ts` / `assemble.ts` / `shared-portfolio.ts` for display.

---

## 10. Comprehensive edge cases (must each have a test)

1. **Pure buy-and-hold, no sells** → realized 0, unrealized = value − cost, avg = cost÷qty.
2. **Partial sell** → realized = proceeds − avg×sold; remainder keeps avg.
3. **Sell at a loss** → negative realized.
4. **Full exit then re-buy** → avg restarts from 0/0; no carryover.
5. **Yield (GHO interest)** → units +, cost €0, lowers avg, value = gain; excluded from benchmark.
6. **Yield then sold** → realized = full proceeds (cost €0).
7. **Airdrop / new asset as yield** → first txn is Yield, cost €0.
8. **Cash yield (bank interest)** → Yield on the cash account; excluded from contributions.
9. **Salary deposit** → Deposit; counts as contribution; mirror of yield.
10. **Buy with tracked cash** → must be a Transfer (neutral), not a Buy (guided; tested for no double-count).
11. **Wallet→wallet move (same crypto)** → net-zero at asset level → cost-neutral.
12. **Crypto→cash transfer (disposal)** → realizes gain; benchmark-neutral.
13. **Lumped DCA** → correct total P&L; benchmark timing off until split; Split fixes it.
14. **Split with explicit per-leg costs** → children carry costs; reversible; quantities sum.
15. **Backdate an existing real cash-flow lot** → amount recomputed (or user cost kept); benchmark accurate.
16. **Multi-currency cost** (EUR vs USD; stock native currency) → stored both via FX-at-date.
17. **Stablecoin (all gain = yield)** → P&L meaningful only via yield handling.
18. **Manual-NAV asset (ELTIF/SICAV)** → simple path (§7.8): cost = net subscription, value = latest NAV, P&L = value − cost; per-unit avg + realized/unrealized **skipped** ("—"); cash distributions = Yield.
19. **Editing/undoing a transaction** → engine recomputes; existing undo machinery intact.
20. **Long yield history (GHO ~14 entries)** → drawer groups/collapses; performant.
21. **Zero/blank/NaN amount** → blocked, never coerced to 0.
22. **Float boundary at units→0** → no divide-by-zero, no drift (tolerance).
23. **Split child (null snapshots)** → `quantityDelta` reads `details.split_quantity`; engine never NaNs.
24. **Transfer with a fee** (net remainder ≠ 0) → fee = realized **loss** at €0 proceeds, not a spurious gain.
25. **Backdated lot, user cost ≠ market** → benchmark seeds at *cost* with a correct non-zero delta vs the
    market-valued truth-line; #94 seed / double-count guards not re-triggered (§9).
26. **Multi-currency divergence** → EUR and USD avg-cost legitimately differ under today's FX; EUR
    authoritative; never reconciled (§7.7).
27. **Manual-NAV** → total P&L = NAV − subscription; avg/realized/unrealized show "—" (§7.8).

---

## 11. Testing strategy (TDD throughout)

- **Unit:** the `cost-basis.ts` engine exhaustively (every §10 numeric case + the method-independent identity
  invariant); the recompute-on-backdate logic; currency conversion; split-with-cost math.
- **Component:** the Add/Edit transaction modal (each type shows correct fields + guidance; validation;
  optional-amount fallback; type-vocabulary per asset class); the drawer (grouping/collapse, filter, edit-in-place).
- **Integration (local Supabase, RLS):** `addTransaction`/`editTransaction` persist + RLS-scope; `is_yield`
  excluded from `deriveCashFlows`; backdate recompute; split-with-cost round-trips; ownership checks.
- **Quality gates:** typecheck, lint, production build, coverage thresholds on the new pure module (≥90%).
- **`/review audit`** (16-agent) on the combined branch before shipping.
- **Live + visual smoke:** real Yahoo/Frankfurter; drive the running app on the GHO case + a backdated
  crypto lot; verify avg cost, realized/unrealized, the corrected S&P line, and the yield exclusion reconcile.
- **`pg_dump`** before any prod data step (Supabase Free = no backups).

---

## 12. Phased implementation (for the plan)

1. **Data + cost capture/override** — `is_yield` migration, regenerate types; cost field on Add/Edit;
   optional/fallback contract; backdate recompute fix. *(foundation + the latent-bug fix)*
2. **Yield + Add-transaction type selector + Transactions drawer** — row history icon, drawer, the unified
   modal with type vocabulary + guidance, grouping/filter, edit-in-place. *(the UX)*
3. **Average-cost engine + A+B display** — pure `cost-basis.ts`; thread avg/realized/unrealized/total into
   aggregate + display surfaces; dashboard total. *(the numbers)*
4. **Split-with-cost** — extend `SplitLeg` + `splitActivityEntry` + the split modal cost fields. *(DCA)*
5. **Cost-basis overlay line** — extend the engine to emit a **cost-basis-at-each-date** series (a running
   total of amounts paid − cost of units sold; **no historical-price lookups**), and draw a faint third line
   on the dashboard chart. Sequenced last (needs the Phase-3 engine); contained addition. *(visualizes
   unrealized gain over time as the gap between the value and cost lines.)*

Each phase independently testable; benchmark accuracy verifiable after Phase 1, the engine after Phase 3,
the overlay after Phase 5.

---

## 13. Migration & rollout

- Built on **`feat/cost-basis`** (stacked on `feat/historical-prices-chart`). #94 stays clean.
- One additive migration (**two columns**: `is_yield` + `cashflow_user_set`, both default `false`) — no data
  backfill; CI type-drift check enforced.
- **#94 and cost-basis are verified *together* before prod** (the agreed plan): all gates + `/review audit`
  + live/visual smoke. `pg_dump` before the (separate) #94 legacy-adjustment migration; this feature needs
  no destructive data migration of its own.
- **Scope (decided 2026-06-02): all five phases ship together** as one feature — with extra care for the size:
  exhaustive per-phase TDD, the `/review audit`, and the delicate #94-seed interaction (§9) all cleared before
  the combined ship. Verify **#94 + cost-basis together**, then merge #94 → main and cost-basis → main back-to-back.

---

## 14. Open questions / parked / future

**Resolved 2026-06-02:**
- **`cashflow_user_set`** — ✅ **explicit boolean** (default `false`). Deterministic; inference (compare to
  qty×market) is too fragile for a financial value. Backdate-recompute touches only `false` rows.
- **`transaction_kind`** — ✅ **derive via one canonical `classifyTransaction()` helper; do NOT store a
  redundant enum.** The kind is fully determined by existing fields, so a stored column would be derivable-
  anyway + drift-prone (and you'd run the helper to backfill it regardless). Finer income subtypes
  ("dividend" vs "interest") are a deliberate later addition, not a reason to denormalize now.
- **DRIP** (dividend reinvested into shares) — ✅ **treat as Yield (cost €0).** Benchmark-correct,
  total-P&L-correct, total-return-neutral on ex-date, and one transaction not two. Strict tax-lot treatment
  (cost = dividend value) only if tax-lots are ever built (they're rejected — §4.4).

**Parked / future:**
- **Bulk *auto-detect* interest reclassification** — parked; v1 ships *manual* multi-select Mark-as-Yield
  (§7.6/§8.4), which is the same `is_yield` flag applied in batch by hand.
- **Per-asset detail pages** — the spacious long-term home for both axes; deferred.
- **Strict per-lot / tax reporting** — rejected for this total-return tracker (§4.4).

---

## 15. References
- PR #94 truth-based chart (the base): `2026-05-27-historical-prices-augmentation-design.md`
- `is_adjustment` read/write map + benchmark seed: project memory `chart-correctness-architecture.md`
- Design exploration + rationale (yield/salary boundary, placement evolution): project memory `pending-features.md`
