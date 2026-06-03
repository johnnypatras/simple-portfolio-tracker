# Cost Basis & Realized/Unrealized P&L — Design Spec

**Status:** Reviewed — round 6 (3 review rounds + architect re-design + 2 comprehensive 6-agent code-grounded audits) incorporated · **Date:** 2026-06-02 (rev 2026-06-03)
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
- **`logActivity()`** accepts `cashflow_amount_usd/eur` + `cashflow_status` params — BUT ⚠ **its callers
  compute those from market price and expose no override** (corrected in review-3 + audit-2): `upsertPosition`
  (crypto.ts) sets `cashflow = qtyDelta × currentPrice` via `computeActivityFx`; **`upsertStockPosition`
  (stocks.ts) via `computeActivityFxWithConversion`**; the cash create/update actions derive it from the
  balance delta via **`computeFx`/`computeCashflow`** (cash-accounts.ts — *not* `computeActivityFx`). None of
  `upsertPosition.opts`, `upsertStockPosition`, `CashAccountOpts`, `computeActivityFx`, or
  `computeActivityFxWithConversion` takes a user amount. So capturing a user cost is **not** "just a
  `logActivity` param" — it requires adding an **amount-override option to all those primitives**
  (§5.2 → a dedicated Phase-1 task, B1 + B1-STOCKS).
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
-- migration 021_transaction_cost_basis.sql (020 is the latest on the chart branch)
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
- **Yield:** `is_yield=true`. The engine + benchmark key off **`is_yield` alone** → cost €0 + excluded,
  **regardless of the stored `cashflow_amount_*`** (which is left **intact**, not zeroed, so reverting/un-yield
  is lossless — review-3 H2). The "total yield earned €" figure is **derived** (`units × historical price`) in
  the display layer for *display only* — never stored/typed; the core P&L math (avg/realized/unrealized) is
  price-free and doesn't depend on it.
- **Currency:** the amount is entered in EUR or USD (toggle); the other is computed via FX-at-`effective_date`
  (existing `toUsdAndEur`). Stocks may enter in native trading currency (same conversion path).
- **⚠ Wiring (the real work — review-3 + audit-2):** the user amount must reach `logActivity`. Add an
  `amountOverride?: { usd: number; eur: number }` option to **`computeActivityFx`** and
  **`computeActivityFxWithConversion`** (and a new `cashflowUserSet` field on their `FxResult`, defaulting
  `false` in `emptyFx()`); thread a `cashflowOverride` (+ `cashflowUserSet`) through **`upsertPosition`**
  (crypto), **`upsertStockPosition`** (stocks), and **`CashAccountOpts`** (cash — whose create/update actions
  use `computeFx`/`computeCashflow`, *not* `computeActivityFx`). When present: skip the `qty × price`
  computation, write `cashflow_amount_* = override` + `cashflow_user_set=true`; when absent: today's
  market-derived behavior. ⚠ **Also thread `is_yield` through these same primitive opts (audit-3 BLOCKER):**
  `addTransaction(type='yield')` creates a **new** row, and the create primitives (`upsertPosition` /
  `upsertStockPosition` / cash) are the only insert path — but they have no `is_yield` opt, and
  `editTransaction`/`markAsYield` are UPDATEs that never touch a fresh insert. Without an `is_yield?` opt on the
  primitives (passed to `logActivity` alongside `cashflowOverride`), a newly-added airdrop/staking reward is
  written `is_yield=false` and silently counts in the benchmark. This is a real (small) Phase-1 task — the spine
  of the feature — covering crypto, **stocks**, and cash, not a free `logActivity` passthrough.

### 5.3 Split legs carry per-leg cost
`SplitLeg` gains an optional `cost` (in the leg's currency). `splitActivityEntry` uses the entered cost for
each child's `cashflow_amount` instead of the current proportional-by-quantity division. Constraint:
Σ(leg quantity) = parent quantity (existing); Σ(leg cost) is shown but **not** forced to equal the parent
(user may be correcting the total). Each child keeps a **positive** `details.split_quantity` plus a stored
`details.split_direction = Math.sign(extractQuantity(parent))` (C1 — `±1`, stored on **every** child, derived
once from the parent; legs stay positive; the engine reads `direction × quantity`; #94's augmentation + timeline
are unaffected). ⚠ `extractQuantity` returns `null` for a `removed` parent → `Math.sign(null) = 0`;
`splitActivityEntry` already rejects splitting a `removed`/`compensates_for` parent, so guard that a `0`/null
direction is **never stored**. See §7.5, §6, §10/23.

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
`unitsAfter − unitsBefore`. Two corrections from review-3, both silent-wrong-number bugs if missed:
- **Entity-aware (B2):** **cash positions store `balance`, NOT `quantity`.** Reuse the existing entity-aware
  `extractQuantity` in `split-helpers.ts` (it already reads `cashAmountField(entity_type)` → `balance`/`amount`
  for the four cash entity types via `CASH_ENTITY_TYPES`, and `quantity` otherwise). A naïve `snap.quantity`
  read returns 0 for every cash row → the engine skips all cash. The cash "units" = the currency amount.
- **Signed split children (B3 → C1, audit-2):** split children inherit `action = parent.action` (**never
  `removed`**) and store a *positive* `details.split_quantity`, so the sign **cannot** come from `action` (a
  split of a *sell* would be booked as a *buy*). ⚠ Do **not** store a *signed* `split_quantity` — PR #94's
  `historical-prices-augmentation.ts` already derives the split sign from `action` and `activity-timeline.tsx`
  renders `split_quantity` as a positive magnitude, so signing it would double-sign #94 (sign-flip → phantom
  buy) and show "−0.5" in the timeline. Instead, `splitActivityEntry` stores a separate
  **`details.split_direction = Math.sign(extractQuantity(parent))`** (keeping `split_quantity` positive); every
  consumer reads **`split_direction × split_quantity`**: the cost engine's `quantityDelta`, and #94's two
  augmentation sites (replacing their `action`-derived sign — old children with no `split_direction` default to
  `+1`, so #94 stays byte-identical). The timeline is unchanged (still a positive magnitude).

Centralizing this (mirrors #94's `qty_delta_override`) prevents `null − null = NaN`, the cash-skip, and the
mis-signed split. The Task-1.3 tests must use **real** cash (`balance`) and split (`action="updated"` + a
`split_direction` of `-1` on a negative leg) fixtures — the original fixtures masked both bugs.

```
computeCostBasis(transactionsAsc, currentMarketValue, opts?) -> {   // opts.onAnomaly: injected oversell sink (H4) — pure if omitted
  avgCost,          // remaining cost ÷ remaining units (0 if no units)
  costBasis,        // remaining cost of currently-held units
  realized,         // Σ over sells of (proceeds − avgCostAtSale × unitsSold)
  unrealized,       // currentMarketValue − costBasis
  totalPnL,         // realized + unrealized
}
```
*(H1, review-3: `totalYieldValue` was removed — it needs `units × price-at-date`, a per-date historical-price
lookup the **pure, price-free** engine has no input for. "Total yield earned €" is computed in the read-time
display layer, which already holds the historical prices, by passing a `pricesByDate` map there — not here.)*

**Per-transaction `value` source (C3, audit-2)** — *the single most missable engine bug:* a real flow
(buy/sell/deposit/withdrawal) carries its amount in `cashflow_amount_{cur}`, but a **transfer/adjustment leg
carries it in `delta_{cur}`** (`cashflow_amount_*` is **null** on `is_adjustment` rows). So the engine resolves,
per currency, `rawValue = is_adjustment ? |delta_{cur}| : |cashflow_amount_{cur}|`. (Reading `|cashflow_amount|`
on a transfer leg would yield 0 → every crypto→cash transfer would book a spurious realized **loss = full cost
basis**.) Direction always comes from `quantityDelta`, never the sign of the delta.

**Pre-step — net transfer legs by `transfer_group` within the asset**, emitting each stream entry with a
resolved `value` (from `rawValue` above): a group whose legs are *all* this asset (wallet↔wallet move) nets to
**qty 0** → skip (cost-neutral carryover). A cross-asset group (one leg on this asset, e.g. crypto→cash) → a
single net **disposal/acquisition** with `value = |moved value|` (the leg's `|delta_{cur}|`). ⚠ **Fee remainder
(B5):** a same-asset group that nets to a *small non-zero* remainder (a network fee — send 1.000, receive
0.999) → a disposal with **`value = 0`** (not `|delta|`), so it books a realized **loss = cost basis**, never a
spurious gain (§7.4). A normal buy/sell keeps `value = |cashflow_amount_{cur}|`. The remaining stream then has
exactly these kinds: **buy/deposit** (qty-up real flow), **sell/withdrawal** (qty-down real flow), **yield**,
**correction** (bare `is_adjustment`). Deposit/withdrawal are the cash labels — the engine treats them
identically to buy/sell (qty-direction drives it; cash qty = the `balance` delta).

Algorithm (per asset, transactions sorted by `COALESCE(effective_date, created_at)`, post-netting):
```
units = 0; cost = 0; realized = 0
for txn in stream:
  qtyDelta = quantityDelta(txn)                       // entity-aware; split_direction × split_quantity for null-snapshot rows
  if qtyDelta == 0: continue
  value      = txn.streamValue                        // per the pre-step (per currency): |cashflow_amount| for buys/sells,
                                                       // |delta| (moved value) for transfers, 0 for fee remainders
  isCorrection = txn.is_adjustment and not txn.transfer_group_id and not txn.is_yield

  if txn.is_yield:            units += qtyDelta                              // earned units → cost += 0
  elif qtyDelta > 0:                                                         // acquisition
       if isCorrection:       units += qtyDelta                             // balance-up fix → cost += 0
       else:                  units += qtyDelta; cost += value              // BUY (amount paid) / TRANSFER-IN (moved value)
  else:                                                                     // qtyDelta < 0 — disposal
       avg = units > 0 ? cost/units : 0
       out = min(-qtyDelta, units)                                          // ⚠ oversell clamp (H4): never drive units/cost < 0
       if (-qtyDelta) > units + EPS: onAnomaly("cost-basis oversell")        // backdated-buy-after-sell corruption → Sentry
       if isCorrection:       cost -= avg*out; units -= out                 // balance-down fix → no realized
       else:                  realized += value - avg*out; cost -= avg*out; units -= out  // SELL (proceeds) / TRANSFER-OUT (realizes)
costBasis = cost
avgCost   = units > 0 ? cost/units : 0
unrealized = currentMarketValue - costBasis
totalPnL  = realized + unrealized
```
`onAnomaly` is an **injected optional callback** — the pure engine stays pure (unit tests omit it and assert the
clamp; the read-time caller passes a Sentry `captureMessage` via the dynamic-import pattern). A genuine
`out > units` is only reachable from corrupt/backdated data (a buy backdated to *after* a sell), so it is both
clamped (no negative units/cost) **and** surfaced.
**Invariant (H3 carve-out, audit-2):** `totalPnL` equals `currentMarketValue + Σproceeds − Σcost`
(method-independent identity) **across buy / sell / yield only** — asserted in tests over those event kinds.
**Corrections are deliberately off-book:** a bare `is_adjustment` balance restatement moves `units` with **no**
matching `Σcost`/`Σproceeds` entry, so the identity does **not** hold across a correction (a test asserts it
does NOT, rather than pretending it does). Guards: `units→0` (no divide-by-zero), re-buy after full exit (avg
restarts cleanly from 0/0), float tolerance **`EPS`** (e.g. `1e-9` — snap `units`/`cost` to 0 when
`|units| < EPS` after a disposal so a re-buy restarts cleanly from 0/0, and so cent-rounded `NUMERIC(18,2)`
inputs don't accumulate drift), the oversell clamp (above). Transfers and corrections each get dedicated tests
(§10).

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

### 7.8 Manual-NAV assets (ELTIF/SICAV) — they DO use the engine
⚠ *Premise corrected (review-3):* these are **`stock_positions` with `kind='manual'` that carry a real
`quantity`** and are valued **`qty × latest-NAV`** (`injectManualNavPrices` injects the NAV as the per-unit
price, `manual-nav.ts`). So the unit engine **applies normally** — there is **no** "skip per-unit / no
tradeable units"; avg cost, realized, and unrealized all compute like a Yahoo stock. The only genuine gap:
**subscription cost is recorded nowhere today** (NAV-update rows carry no `cashflow_amount`). So manual-NAV
cost is captured the **same way as any asset** — the user enters the **amount paid** (subscription) on the
position's buy/edit via the §5.2 override on **`upsertStockPosition`** (B1-STOCKS — manual-NAV holdings are
`stock_positions`), and the engine produces full A+B P&L. ⚠ **Scope (audit-3):** the cost rides the **position**
write (`upsertStockPosition`), reachable from the Add-Manual-NAV modal's position leg and the shared position
editor; the NAV actions (`addManualNavAsset` / `upsertManualNav` / the update-NAV modal) stay **cost-free**. An
asset created with **no** position has no cost until a position is added (the market/NAV fallback covers it —
§8.6). Cash **distributions** are **Yield** on the receiving cash account. Until a cost is entered, an existing manual-NAV holding shows P&L via
the market (NAV) fallback like any un-costed lot — i.e. it is **not** a special display case (`kind='manual'`
needs no separate "—" branch).

---

## 8. UX design (consistent, self-explanatory) — the heart of the feature

> Design principles: **add no new always-on column** (tables are width-tight); **ride existing affordances**;
> **one unified "Add transaction" flow** with a clear **type selector** + inline guidance so the user is led
> to the correct choice; follow established modal conventions (`space-y-4`, `text-xs text-zinc-400 mb-1`
> labels, dark theme, `focus-trap-react`, `role="dialog"`, `role="alert"` on errors, `accent-amber-500`
> reserved for adjustments).

### 8.1 Row affordance — a "Transactions" (history) icon
Crypto/stock rows have an Edit/Delete action cluster (`crypto-columns.tsx`, `stock-columns.tsx`) — the
**history icon** slots in beside them (hover-revealed; no new column), opening the **Transactions drawer**.
⚠ **Cash is different (review-3 L3):** the cash *group* row renders `actions: () => null` and Edit/Delete
live on the **expanded sub-rows** (`cash-columns.tsx`). So the cash history icon needs a **different
placement** — on the cash sub-row, or a group-level affordance — not a drop-in to a (nonexistent) group
cluster. Distinct from the wallet expansion + position editor (the *where-held* axis).

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
- **Type → Yield** (e.g. an existing GHO "deposit" → Yield): UPDATEs the row to `is_yield=true` (the amount is
  **left intact**, not zeroed — §5.2). It drops out of benchmark contributions and the engine treats its units
  as €0-cost (both key off `is_yield`). Benchmark + P&L correct on the next render (read-time; value snapshots
  untouched). **Un-yield is the exact reverse** — set `is_yield=false`; the preserved amount returns
  automatically (no recompute, no data loss — review-3 H2).
- **Bulk:** a drawer **multi-select → "Mark as Yield"** applies this to several rows at once (the one-pass
  cleanup of §7.6), fully reversible.

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
  Manual-NAV assets use the **same engine** (they carry a quantity — §7.8): full avg/realized/unrealized once a
  subscription cost is entered, market (NAV) fallback until then. No special "—" branch.
- Portfolio-level **Total P&L** stat on the dashboard. The S&P line is corrected (cost-accurate, yield-excluded).
- Reuse existing responsive column-hiding (`HIDDEN_BELOW`); P&L columns hide first on narrow screens, full
  detail always available in the drawer.

---

## 9. Server actions (new / modified)

- `src/lib/actions/transactions.ts` (new): `addTransaction(assetRef, {...})`, `editTransaction(entryId, patch)`,
  `markAsYield(ids)` — all `revalidateDashboard()` + Sentry-wrapped (`captureAction`).
  - **Validate at the boundary (M3):** server actions are public endpoints, so re-validate independent of the
    modal — `validateUUID` (every `entryId`/`id`, incl. each id in `markAsYield`'s array), `validateAmount`,
    `validateQuantity`, `validateCurrency`, `validatePastOrTodayDate`.
  - **Ownership in the action, not just RLS (#97):** `editTransaction`/`markAsYield` MUST re-fetch with
    `.eq('id', …).eq('user_id', user.id)` and 404 if absent.
  - **⚠ `editTransaction` is an UPDATE, not an append (H3):** `logActivity` is **insert-only**, so editing an
    existing row's `cashflow_amount_*`/`effective_date`/`is_yield`/`cashflow_user_set` is a direct
    `activity_log` UPDATE (mirror `backdateActivityEntry`/`toggleActivityAdjustment`, activity-log.ts:380-407),
    NOT a new `logActivity` call. **Guards (audit-2 H5 + audit-3):** reject a **transfer leg**
    (`transfer_group_id != null` → edit via the Transfer flow), a **split child / undone row**
    (`split_from_id != null` or `undone_at != null` → unsplit first), and a **compensation row**
    (`compensates_for != null` → an automatic undo-reversal; editing it desyncs the compensated pair —
    `splitActivityEntry` already rejects these), with friendly messages. **Write the right columns — amount AND
    status (audit-3 HIGH + audit-r5):** mirror `toggleActivityAdjustment`'s **full** UPDATE object — **all 8
    columns**: an `is_adjustment` row writes `{ delta_{cur}, delta_status:'complete', cashflow_amount_{cur}:null,
    cashflow_status:null, cashflow_asset_class:null }`; a real-flow row writes the inverse **with
    `cashflow_asset_class` set via `classifyAssetClass(...)`** (the toggle sets it on the real-flow side and nulls
    it on the adjustment side — omitting it mis-labels the contribution's asset class in the benchmark/deposit
    breakdown). ⚠ `deriveCashFlows` keys on **`cashflow_status='complete'`**, not on a non-null amount — so
    writing the amount while leaving a stale opposite **status** re-creates the phantom-contribution bug.
    **Never populate both sides.** **TOCTOU guard (M4):** scope the UPDATE with
    `.is('undone_at', null)` so a concurrently undone/split entry matches 0 rows and reports it.
  - **`addTransaction`** orchestrates over the override-extended primitives (§5.2): Buy/Sell → `upsertPosition`
    (crypto) / `upsertStockPosition` (stocks) with the amount override; Deposit/Withdrawal → cash actions with
    the override; **Yield → a normal qty-up acquisition with `is_yield=true`** — the amount is the market value
    (or a user entry) and is **left intact, never zeroed** (`is_yield` alone is the exclusion signal — §5.2/§8.4;
    so un-yield is lossless). **`markAsYield`** flips only **eligible** rows — full predicate (audit-3 + audit-r5):
    `is_adjustment = false AND transfer_group_id IS NULL AND split_from_id IS NULL AND undone_at IS NULL AND
    compensates_for IS NULL AND cashflow_status = 'complete' AND is_yield = false` — sets `is_yield=true` (amount
    left **intact** — §5.2); everything else → `skipped`; returns `{updated, skipped}`. (⚠ `split_from_id` is
    essential — `markAsYield` is the **bulk** path and a live split child otherwise passes every term; zero-costing
    one leg of a split corrupts the asset's cost basis. `cashflow_status='complete'` is the concrete "real cash
    flow" test; `is_yield=false` keeps the `{updated}` count honest.)
- `splits.ts`: extend `SplitLeg` with `cost?`; `splitActivityEntry` uses it.
- `backfill.ts` / backdate path: implement the recompute-on-backdate contract (§7.2).
- `benchmark.ts`: `deriveCashFlows` excludes `is_yield=true` (add `is_yield` to its `.select` + `.eq("is_yield",
  false)`) and uses the (now user-authored) `cashflow_amount_*` — **the actual amount invested** — at
  `effective_date`. ⚠ **`deriveCashFlows` is the ONLY reader that needs the filter (CORRECTED audit-r5 — the
  prior "both readers" instruction was wrong AND breaking):** the backdated/synthetic reader
  `buildBenchmarkCashFlows` only emits flows for `is_adjustment` rows (`if (is_adjustment !== true) continue`),
  and yield is `is_adjustment=false`, so it **already excludes yield structurally**. Critically,
  `fetchHistoricalPriceInputsFor`'s lot stream is the **shared input to the VALUE/truth line**
  (`augmentAndExtendSnapshots`) — a row-level `is_yield` filter there would drop backdated-yield **units** from
  the value line (understating holdings). So **do NOT filter `fetchHistoricalPriceInputsFor`**; yield units stay
  in the value line and are simply ignored by the benchmark via the existing `is_adjustment` gate. **Test:** a
  backdated yield is absent from `deriveCashFlows` AND the synthetic flows, **but its units still appear in the
  value line.**
- **⚠ The #94 seed — the single most delicate change (re-architected per audit-2 C2):** Reading the real code
  (`chart-enrichment.ts:204-304`): `seedDisp = firstSliceVal` (line 242) = the portfolio's **market value** at
  chart start, and the seed computes `seedDelta = neededUnits − unitsAtChartStart` precisely to force
  `benchmark(chartStart) == market value`. So the seed **actively re-anchors the benchmark to market and erases
  any cost≠market gap.** **The fix anchors the benchmark to cost instead** — but a naïve scalar is infeasible:
  `enrichWithSp500Benchmark` runs **client-side** in a `useMemo`, and `chartStart` is **period-dependent**
  (24H/3D/…/All) and **per-view-mode** (crypto/stocks/cash/total), while the engine is per-asset. So:
  1. A new pure **`buildCostBasisSeries(...)`** emits a **server-side, portfolio-wide, per-class** series. ⚠
     **It must run over ALL of the user's positions (audit-3 BLOCKER), not #94's backdated-only lots** — #94's
     `buildHistoricalLots` drops every non-backdated position, and its lot inputs carry **quantity only, never
     cost**, so it cannot produce a full-portfolio cost basis. So `buildCostBasisSeries` needs the **per-asset
     cost + `delta` streams** (the engine's real input), with each real lot valued at its **cost** (user amount,
     else market fallback) and each `is_adjustment` lot at **market** (`lotContributionAtDate`). Apply the **same
     stablecoin crypto→cash reclassification** the value line uses (`aggregate.ts` / augmentation ~865-887) so
     the per-class cost split matches the per-class value split. **Shape (audit-r5 F1):** emit BOTH absolute
     per-class **cost** columns `{ cryptoCostUsd, … }` (for the Phase-5 overlay) AND explicit per-class **gap**
     columns `{ cryptoGapUsd, … }` = `Σ(marketAtChartStart − userCost)` over `cashflow_user_set=true` lots (for
     the seed) — the gap CANNOT be derived from an aggregated cost total, so the builder must emit it while
     per-lot data is in scope (total/investments by summation). ⚠ **Price availability (audit-r5 F2 — the
     load-bearing fix):** `marketAtChartStart` needs cached `historical_prices` + FX, but #94's
     `ensureHistoricalPricesCached` caches prices **only for backdated lots**, and a user-costed lot is typically
     a *non-backdated* normal buy → so this requires **widening #94's price-fetch to also cover the assets of
     `cashflow_user_set=true` lots back to `chartStart`** (bounded — only the assets the user has actually
     costed). Reconstructed `marketAtChartStart` may differ from the snapshot by FX/forward-fill ULPs → seed
     tests tolerate `EPS` on the user-costed branch (never assert exact cents there). *(Note: #94's chart series
     excludes manual-NAV lots — no `yahoo_ticker` —
     so the overlay/seed won't include them even though the per-asset engine shows their P&L; acceptable, a
     chart-series limitation to call out, not a bug.)*
  2. It is exposed via **`getHistoricalBenchmarkExtension`** (`benchmark.ts:145-198`) — a **third read** (the
     cost + `delta_*` streams **+ `cashflow_user_set`** — the gate flag the gap needs, audit-r5 F3), *not* merely
     a "superset of `deriveCashFlows`" (which selects neither `delta_*` nor includes `is_adjustment` rows), and
     over **all** positions (not the backdated-only lot builder). The plan spells out the exact SELECT.
  3. It is threaded as a **new prop**: `page.tsx:157` + `share/[token]/page.tsx:75` → `PortfolioChart` →
     `enrichChartData` → `enrichWithSp500Benchmark`.
  4. **The seed is a *delta from* `firstSliceVal`, not a re-reconstruction of it (audit-3 — the byte-identical
     guarantee):** `seedDisp = firstSliceVal − costGap(chartStart, viewMode)`, where
     `costGap = Σ (marketAtChartStart − userCost)` over **only the lots the user explicitly costed**
     (`cashflow_user_set = true`) in that view-mode's class. `lookupCostAtOrBefore` **reads/sums the pre-computed
     per-class gap columns** (audit-r5 F1) for the view-mode (**0** when no lot is user-costed). Reuse the
     FX-ratio tiers (:251-263) for the gap's currency conversion. The benchmark
     then anchors to *what you invested* while the portfolio line stays at *market* — the delta survives.
  - **Byte-identical regression guard (now EXACT, not reconstruction-matched):** subtracting a gap *from the real
    `firstSliceVal`* (rather than recomputing the whole value) means that when **no lot is user-costed**,
    `costGap = 0` and `seedDisp == firstSliceVal` **byte-for-byte** — via the *same* code path as today, with
    **no** dependency on a cost-series reconstruction matching `firstSliceVal`. *(This is the flaw the prior
    formula had: `firstSliceVal` is the **full-portfolio snapshot** market value (cron + augmentations), which a
    backdated-only or independently-reconstructed series will never byte-match — so a populated series would have
    regressed the anchor even at cost==market. The gap-subtraction sidesteps it entirely.)* A user cost on a lot
    subtracts exactly `(market − cost)` for **that lot only** → the gap appears only where it should.
    Corrections/synthetic `is_adjustment` flows are never user-costed → never in the gap → keep market valuation.
    The control test must include a **populated** series (a backdated lot present, cost == market → gap 0 → still
    byte-identical), not merely an empty one.
  - **Sequencing:** the series builder is built in **Phase 3** (with the engine), *not* Phase 5 — this resolves
    the dependency inversion (the seed needs it) and the Phase-5 overlay simply **reuses** the same series.
  - `enrichWithSp500Benchmark` is **not exported** → the seed test drives the **public `enrichChartData`** with
    crafted points + a crafted cost series (a UNIT test, not Supabase integration — H6); then the **entire #94
    benchmark + chart-enrichment suite must pass unchanged**. §10 case 25 + manual live-smoke.
- `getAssetTransactions(assetRef)` (the engine's input read, in `transactions.ts`): ⚠ **asset-level, NOT
  per-`entity_id` (audit-3 BLOCKER):** `activity_log.entity_id` for crypto/stocks is the **per-wallet position
  id**, so one asset across N wallets has N `entity_id`s. Grouping by `entity_id` would fracture the asset's
  stream → a wallet↔wallet move would look like a disposal in one stream + an acquisition in another (never
  netting to 0 → spurious realized gain, §7.4 violated). So resolve `assetRef` → the asset
  (`crypto_asset_id`/`stock_asset_id`), collect **all of that asset's position ids** (RLS-scoped read of the
  positions table), then read `activity_log` `.in('entity_id', positionIds)` — one merged per-asset stream.
  **Cash is the exception:** `entity_id = cash_accounts.id` and a cash "asset" *is* the account, so the account
  id is the grouping key (so cost P&L is **per cash account**, not aggregated across same-currency accounts — a
  deliberate asymmetry vs the crypto/stock per-asset-across-wallets axis; documented + acceptable for v1). The
  read keeps **`.eq('user_id', user.id)`** (defense-in-depth — positions have no `user_id`; RLS + explicit
  scope), **`.is('undone_at', null)`**, **selects `cashflow_amount_*` AND `delta_*`** (C3), sorts
  `COALESCE(effective_date, created_at)`, and paginates via `fetchAllPaginated`. The `undone_at` filter yields
  exactly **live parents OR split children, never both** (a split marks the parent `undone` right *after*
  inserting children — **sequential, not one transaction**, audit-r5 — so `getAssetTransactions` should
  defensively skip a parent that still has live children, lest a mid-split failure double-count). ⚠ **Dual-client
  contract (audit-r5 HIGH):** the share page reconstructs a **non-owner's** portfolio via the **admin client
  scoped by `owner_id`** (`shared-portfolio.ts`), and §8.6/the display layer thread cost P&L there — so
  `getAssetTransactions` must accept `(supabase, userId)` and resolve positions by that `userId` (admin path for
  share/comparison; authed-RLS path for the owner), mirroring `fetchHistoricalPriceInputsFor`'s existing
  owner/authed duality. An RLS-only signature leaves the share page with no cost data.
- `src/lib/portfolio/cost-basis.ts` (new pure module): the average-cost engine (§6). Optional injected
  `onAnomaly` callback (oversell → Sentry at the read-time caller; the engine itself stays pure — H4).
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
18. **Manual-NAV asset (ELTIF/SICAV)** → uses the engine (has a `quantity`, §7.8): full avg/realized/unrealized once a subscription cost is entered; market (NAV) fallback until then; distributions = Yield.
19. **Editing/undoing a transaction** → engine recomputes; existing undo machinery intact.
20. **Long yield history (GHO ~14 entries)** → drawer groups/collapses; performant.
21. **Zero/blank/NaN amount** → blocked, never coerced to 0.
22. **Float boundary at units→0** → no divide-by-zero, no drift (tolerance).
23. **Split child of a SELL (null snapshots)** → `quantityDelta` returns `details.split_direction ×
    details.split_quantity` (direction matching the parent; magnitude positive); a split sell stays a
    **disposal**, not a buy, and #94's augmentation/timeline are unaffected. Engine never NaNs. (B3/C1)
24. **Transfer with a fee** (same-asset net remainder ≠ 0) → fee = realized **loss** at €0 proceeds (B5), not a
    spurious gain.
25. **Backdated lot, user cost ≠ market** → benchmark **seeds at cost** via
    `seedDisp = firstSliceVal − costGap(chartStart, viewMode)` (gap = `Σ(market − userCost)` over user-costed
    lots) with a correct non-zero delta vs the market-valued truth-line; **with no user-costed lot the gap is 0
    → byte-identical** to #94 — exact via the same code path, even with a populated series (§9, C2).
26. **Multi-currency divergence** → EUR and USD avg-cost legitimately differ under today's FX; EUR
    authoritative; never reconciled (§7.7).
27. **Cash classification across all four cash entity types (B2)** → a deposit into a `bank_account` /
    `exchange_deposit` / `broker_deposit` / `cash_account` classifies as **Deposit** (qty-up via the cash-amount
    delta), a withdrawal as **Withdrawal** — never as a crypto buy/sell. `quantityDelta` reads the cash amount
    via `cashAmountField` (**`balance`** for `bank_account`/`cash_account`, **`amount`** for
    `exchange_deposit`/`broker_deposit`), **not `quantity`**, for cash.
28. **Un-yield is lossless (H2)** → Mark-as-Yield then revert: `is_yield` toggles, `cashflow_amount_*` is never
    zeroed, so the original amount returns intact.
29. **Cost override actually persists (B1)** → `addTransaction` with a user amount stores `cashflow_amount_* =`
    that amount + `cashflow_user_set=true` (NOT overwritten by `qty × market`); blank → market + `user_set=false`.
    Covers crypto (`upsertPosition`), stocks (`upsertStockPosition`), and cash (B1).
30. **Oversell / backdated-buy-after-sell (H4)** → a disposal whose units exceed holdings is **clamped**
    (`out = min(out, units)`; no negative units/cost) **and** surfaced via the injected `onAnomaly` → Sentry.
    The test fixture must produce a genuine negative `quantityDelta` exceeding running `units` (snapshots
    consistent with the kind), not an acquisition.
31. **Correction is off-book (H3)** → a bare `is_adjustment` **balance-DOWN** restatement removes cost basis
    (`avg×out`) with no `Σproceeds` entry → the identity invariant is asserted to **NOT** hold across it
    (corrections are deliberately outside the buy/sell/yield identity). A companion **balance-UP** correction
    test asserts units rise at **zero cost** (the up-direction happens to preserve the identity).

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
3. **Average-cost engine + A+B display + the #94 seed** — pure `cost-basis.ts`; the server-side
   `buildCostBasisSeries` (per-class running cost) + the `seedDisp → cost` re-anchor (§9, C2); thread
   avg/realized/unrealized/total into aggregate + display surfaces; dashboard total. *(the numbers + the
   benchmark seed; the series is built here so Phase 5 can reuse it)*
4. **Split-with-cost** — extend `SplitLeg` + `splitActivityEntry` + the split modal cost fields. *(DCA)*
5. **Cost-basis overlay line** — draw a faint third line on the dashboard chart fed by the **Phase-3
   `buildCostBasisSeries`** (the cost-at-each-date series already built for the seed; **no historical-price
   lookups**). Sequenced last (pure presentation); contained addition. *(visualizes unrealized gain over time
   as the gap between the value and cost lines.)*

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
