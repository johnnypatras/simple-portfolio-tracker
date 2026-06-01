# Historical-Price Chart Augmentation (extend chart back to purchase dates)

- **Status**: BOTH PHASES IMPLEMENTED on `feat/historical-prices-chart` (NOT yet merged to `main` — awaiting user approval). Phase 1 (portfolio line) `c5df861`→`9b59a3d`; Phase 2 (S&P benchmark) `a4bf18c`→`e5f1884`. Verified: 781 unit + 161 component + 154 integration green, build clean; real-data smoke (live Yahoo/Frankfurter) + visual smoke in the running local app (EUR-primary, 2 BTC backdated 2023-06-01 → portfolio + S&P both extend to 2023, coherent). **Open Question 2 RESOLVED** — Phase 2 mechanism = synthetic benchmark cash flows for `is_adjustment` backdated lots (`buildBenchmarkCashFlows`) + extended `^SP500TR` range + a seed-baseline fix (the S&P seed now reconciles against units present AT `chartStart`, not just `preChartUnits` — prevents a double-count when a cash flow sits exactly on chartStart). Plans: `docs/superpowers/plans/2026-05-27-historical-prices-phase{1,2}-*.md`. Two production bugs caught by smoke testing (NOT by 1090+ automated tests): PostgREST `max_rows` 1000-cap truncation (→ pagination) + the S&P seed double-count.
- **Date**: 2026-05-27
- **Author**: brainstorming session (John + Claude)
- **Feature branch**: `feat/historical-prices-chart` (both phases land here; merge to `main` only when the coherent whole is ready — see Deployment)
- **Relates to**: [[chart-correctness-architecture]] (this is "Phase 3" of that rollout, triggered early), manual-NAV augmentation (PR #72, the pattern this mirrors)

## Problem Statement

The portfolio chart renders historical value from `portfolio_snapshots` rows (written daily by the cron). It cannot show any date earlier than the user's first snapshot, and for **backdated lots** (positions added today but marked with an earlier `effective_date`) it relies on the `getAdjustmentDeltas()` **back-fill** — the formula `value + (finalCumDelta − cumDelta)`, which projects *today's* value as a flat line backward.

For **cash and stablecoins** the back-fill is mathematically exact (no price movement). For **sizable, multi-year crypto/stock lots it is badly wrong** — a 5 BTC lot bought in 2021 (~$150k) at ~$95k/BTC today (~$475k) draws a flat ~$475k line across 2021–2024, when the real value climbed through two market cycles. The error scales with size × volatility × age and can exceed 100%. It corrupts three things at once: the chart line, the S&P benchmark seed (derived from the chart-start value), and period-return percentages (the flat line hides the lot's real appreciation).

The user is about to insert sizable, multi-year-old crypto/stock holdings, incrementally ("when I remember an old investment, I enter it with its real date and want it backlogged"). This is the re-trigger criterion documented in [[chart-correctness-architecture]] firing for real: the approximation moves from cosmetic (<0.2% at prior scale) to materially wrong.

## Goals

1. Replace the flat-line back-fill for backdated crypto/stock lots with **exact `qty × historical-price` augmentation**.
2. **Grow the chart backward** so it begins at the user's earliest holding's purchase date and reconstructs the pre-snapshot era from real historical prices (chosen over "correct values within the existing window only" — the user wants to *see* the history, filling in as more old lots are added).
3. Extend the **S&P benchmark** back over the same range so the comparison is coherent ("your BTC vs the S&P since 2021"). **Sequenced as implementation Phase 2** (see Phasing).
4. Preserve the core correctness invariant: **a position contributes $0 to every date before its `effective_date`** — never fabricate value for a holding not yet owned.

## Non-Goals

- No live-price source change. CoinGecko remains the *live* price source; this feature only adds *historical* prices.
- No paid API plans. Historical depth is sourced from free endpoints (see Data Sources).
- No general "historical prices for every asset always" — fetching is scoped to assets that actually have backdated lots needing reconstruction.
- No retroactive change to how forward (post-first-snapshot) snapshots are computed.

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Chart range | **Grow chart back** to earliest purchase date (not correct-in-window) | User wants to see full investing history, filling in incrementally |
| Rendering strategy | **Read-time synthesis** (not materialized snapshot rows) | Consistent with the codebase's existing read-time augmentation philosophy (`augmentSnapshotsWithManualNavs`); no second class of rows in `portfolio_snapshots`; no recompute-on-insert job; self-healing; composes with manual-NAV in one pass |
| Crypto historical source | **Yahoo `/v8/chart` (`BTC-USD` etc.)** | CoinGecko free/Demo tier caps `market_chart` history at ~365 days — cannot supply multi-year crypto history without a paid plan. Yahoo gives free multi-year daily history for major coins via the same endpoint already used for the S&P line. Obscure coins fall back to CoinGecko `/history` per-date. |
| Fetch trigger | **Lazy fetch-on-read** (eager-warm deferred) | Lazy-on-read is complete and self-healing on its own (covers fetch failures, pre-existing lots, bulk imports). Eager-on-insert adds zero correctness, only first-load latency — premature optimization, deferred until proven needed. |
| Granularity | **Daily** | Matches existing snapshots (avoids mixed-granularity inconsistency); Yahoo returns the full range in one call regardless of granularity, so daily is effectively free; ~1500 rows is trivial. |
| S&P extension | **Implementation Phase 2** (designed now, built second) | Entangles with the delicate cash-flow/`is_adjustment`/units logic. Isolating it as a focused second change protects the benchmark logic and keeps the high-value core (portfolio line) shippable and verifiable first. |
| Deployment | **Feature branch, deploy together** | `main` auto-deploys; shipping the portfolio extension alone would expose an incoherent half-state (portfolio line to 2021, S&P line from 2026) on the live single-user app. Both phases land on the branch; merge to main once coherent. |

## Data Model

New table `historical_prices` — a **global, shared, append-only** price cache. Past prices never change, so it grows monotonically and is never invalidated.

```sql
CREATE TABLE historical_prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_kind   text NOT NULL CHECK (asset_kind IN ('crypto','stock','fx')),
  asset_key    text NOT NULL,   -- canonical per kind: crypto=coingecko_id, stock=yahoo_ticker, fx='EURUSD'
  price_date   date NOT NULL,
  price        numeric(20,8) NOT NULL CHECK (price > 0),
  currency     text NOT NULL,   -- native currency of the price
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_kind, asset_key, price_date)
);
CREATE INDEX idx_historical_prices_lookup
  ON historical_prices (asset_kind, asset_key, price_date);
```

Properties:
- **No `user_id`**: a BTC price on a given date is identical for every user — shared cache. Written by service-role (fetch layer), readable by all authenticated users.
- **Grants/RLS**: non-sensitive public market data. Grant `SELECT` to `authenticated`; writes via service-role only. RLS posture confirmed during planning — likely RLS-enabled with a permissive `SELECT` policy + no write policy (writes go through service-role), or a documented public-read table. Decide in the migration; default to RLS-on with read-only authenticated policy for defense-in-depth consistency with the rest of the schema.
- **FX as a first-class `asset_kind`** (`EURUSD` rows): native-currency stock conversion at any historical date is a lookup, mirroring how the cron stores both currencies forward.
- **`UNIQUE (asset_kind, asset_key, price_date)`** makes re-fetch idempotent (upsert).
- **Crypto keyed by `coingecko_id` (canonical) but fetched from Yahoo**: the fetch layer maps `coingecko_id` → Yahoo `{SYM}-USD` ticker via CoinGecko's `symbol` field. Storing under the app's canonical crypto identifier (coingecko_id) keeps the synthesis lookup consistent with how `crypto_assets` are identified everywhere else; Yahoo is purely the fetch *mechanism*, not the storage key.

## Data Sources

| Asset kind | Source | Notes |
|------------|--------|-------|
| Stocks | Yahoo `/v8/chart` (`period1`/`period2` Unix ts, `interval=1d`) | **Must use explicit timestamps, not `range=max`** — reuse the `fetchIndexHistory` lesson (Yahoo silently downsamples `range=max` to quarterly). Returns native trading currency. |
| Major crypto | Yahoo `/v8/chart` (`{SYM}-USD`) | Free multi-year daily history; sidesteps CoinGecko free-tier 365-day cap; reuses `yahoo.ts`. USD-denominated. |
| Obscure crypto | CoinGecko `/coins/{id}/history?date=DD-MM-YYYY` | Per-date fallback for coins Yahoo lacks; coarser; on-demand. If it also fails → 0 + Sentry breadcrumb (visible gap, not silent). |
| FX | Frankfurter timeseries (`/{start}..{end}?from=&to=`) | ECB data, free, decades of depth. |

All fetches use `fetchWithTimeout` (8s, existing helper) and degrade gracefully (see Edge Cases).

## Components

### 1. Pure synthesis module — `src/lib/portfolio/historical-prices-augmentation.ts`

Mirrors `manual-nav-augmentation.ts` exactly — including its **abstraction level**: it operates on `PortfolioSnapshot[]`, NOT `ChartPoint[]`. This is load-bearing: period-change cards consume snapshots via `findSnapshotAt(snapshots, daysAgo)` and the S&P seed derives from the snapshot-derived `points[0]` — so the extended history must live in the snapshot array for *all three* consumers (chart, period cards, S&P) to see it. Emitting `ChartPoint[]` would leave period cards and the S&P seed blind to the synthesized era. No DB, no clock, fully deterministic and unit-testable. Public surface:

- `findPriceAtOrBefore(pricesAsc, date)` — binary search, forward-fill semantics.
- `buildPriceIndex(rows)` — group by `(asset_kind, asset_key)`, sort ASC.
- `cumulativeAtDate(deltasAsc, date)` — cumulative sum of effective-dated deltas with `effective_date ≤ date`; `0` before the first entry. Used for both position **quantity** (crypto/stock) and cash/stablecoin **balance** — the same primitive; the difference is only whether the result is later multiplied by a price (positions) or taken as value directly (cash).
- `augmentAndExtendSnapshots(snapshots, positions, deltas, prices)` → `PortfolioSnapshot[]` — the core function. **Two responsibilities in one pass** (both needed, see below): (a) **augment** existing snapshot rows where a backdated lot is missing its contribution, and (b) **synthesize** new snapshot rows for dates before the first real snapshot. Returns the extended, augmented `PortfolioSnapshot[]`. Pure.
- `fetchHistoricalPriceInputsFor(client, userId)` — the only I/O function; gathers backdated positions, their activity-log deltas, and cached historical prices. Sentry breadcrumb for observability (matches `fetchManualNavInputsFor`).

**Why both augment AND synthesize (the coverage range):** a lot inserted *today* but backdated to 2021 is missing from the cron snapshots across the entire `[effective_date, first-cron-snapshot-that-includes-it)` range — which spans both (a) existing snapshot rows written *before* the lot was inserted (e.g. 2026-02 → insert-day) and (b) dates with no snapshot row at all (pre-first-snapshot, e.g. 2021 → 2026-02). Both segments need the contribution. Operating at the snapshot level makes this one uniform operation: augment rows that exist, synthesize rows that don't, across the whole range.

### 2. Value composition (per snapshot date D — synthesized or augmented)

For each date D, the lot's contribution to that snapshot's `*_value_usd` and `*_value_eur` columns:

```
crypto/stock:  cumulativeAtDate(D) × priceAtOrBefore(D) × fxAtOrBefore(D, →USD and →EUR)
cash/stablecoin: cumulativeAtDate(D)                     (face value — no price multiply)
```

- Emits **both USD and EUR** values (every snapshot stores both `*_value_usd` and `*_value_eur`). Crypto from Yahoo is USD-denominated → EUR mirror via historical `EURUSD`. Stocks are native-currency → both bases via historical FX. Cash/stablecoin face value converted to the non-native base via historical FX.
- Computed **per asset class** (crypto/stocks/cash) so the per-class chart views and `crypto_value_*` / `stocks_value_*` / `cash_value_*` columns on each (synthetic or augmented) snapshot are correct.
- Cash/stablecoin take `cumulativeAtDate` as value directly (exact for face-value assets — the same reason cash back-fill was already correct; no price lookup needed).
- Result: an extended `PortfolioSnapshot[]` consumed uniformly by chart-enrichment (→ ChartPoints), period cards (`findSnapshotAt`), and the S&P seed (`points[0]`) — none aware that some rows are synthesized.

### 3. Back-fill exclusion — `getAdjustmentDeltas()`

Add a third exclusion `Set` (`historicallyPricedPosIds`) alongside `manualStockPosIds` + `stablecoinPosIds`, with `continue` in the accumulation loop. A backdated crypto/stock lot is excluded from the flat back-fill **once its historical prices are cached** (its value now comes from synthesis).

**Graceful degradation**: a backdated lot whose history has not yet been fetched (pending/failed) stays on the old flat back-fill until prices land, then synthesis takes over. The chart is never broken mid-fetch.

### 4. Caller-path threading

`fetchHistoricalPriceInputsFor` is invoked in the same four paths that already call `fetchManualNavInputsFor`:
- `assemble.ts` (dashboard, authenticated client, RLS-scoped)
- `snapshots.ts` (chart + period-change)
- `shared-portfolio.ts` (share page, admin client + explicit owner_id)
- `comparison.ts` (both viewer and owner contexts)

### 5. Lazy fetch-on-read

During chart assembly: determine `(asset, date-range)` pairs needed by backdated lots, check the cache, fetch only the missing ranges (timeout-guarded, graceful degradation), upsert, then call `augmentAndExtendSnapshots` to produce the extended `PortfolioSnapshot[]`. One-time fetch cost per lot (cached forever). Runs inside the existing parallel-fetch block in `assemble.ts` / `getSnapshots` — consistent with how live prices/FX are already fetched during SSR, and at the same point where `augmentSnapshotsWithManualNavs` already runs.

## Phasing

### Phase 1 — Portfolio history extension (lower risk, ships the core value)

Everything above except the S&P benchmark: `historical_prices` table + migration, fetch layer, pure synthesis module, back-fill exclusion, caller threading, synthetic-point prepending. After Phase 1 the **portfolio line** extends back to the earliest purchase date with exact historical values; the S&P comparison line still starts at the first snapshot (interim incoherent state — **not deployed to main**, see Deployment).

### Phase 2 — S&P benchmark extension (delicate, isolated)

Extend the S&P "units" benchmark back over the synthesized range. The core problem: backdated lots are `is_adjustment=true`, which `deriveCashFlows()` *excludes* — so out of the box the extended S&P line has no cash flows in the pre-snapshot era. Phase 2 makes those backdated acquisitions count as cash flows **at their `effective_date`** for the benchmark, so the comparison is "what if your 2021 BTC purchase money had gone into the S&P instead." This interacts with the seeding logic (which currently seeds units to match the portfolio at chart start) and the `is_adjustment` exclusion that exists specifically to keep the *windowed* benchmark correct. Phase 2 gets its own focused design refinement during planning + its own dedicated tests.

## Edge Cases & Correctness Guards

| Case | Handling |
|------|----------|
| Lot sold before first snapshot | `cumulativeAtDate` replay → qty>0 from buy, →0 after sell. Shows then vanishes. |
| Missing price for a date (weekend/holiday/pre-IPO) | Forward-fill from most-recent prior trading day (step-function, same as manual-NAV + S&P line). |
| Date before asset existed | Contributes 0. A "buy" before existence is a data error → Sentry breadcrumb + skip; never fabricate. |
| Fetch failure / pending | Graceful degradation: lot stays on flat back-fill until prices land. |
| FX gaps (ECB no weekend rates) | Forward-fill, same as prices. |
| Obscure coin not on Yahoo | CoinGecko `/history` per-date fallback; if that fails → 0 + Sentry breadcrumb. |
| NaN / Infinity | `Number.isFinite` guard around every `qty × price × fx` (Phase 5 lesson: supabase-js string numerics, zero-vs-missing sentinels). |
| Far-back cap | Synthesized series bounded to earliest real `effective_date`; never synthesize before the earliest holding. |
| Historical↔live seam | Yahoo historical meets CoinGecko/cron live at the first-snapshot date. Possible sub-percent one-day blip. Accepted + documented (cheaper than a paid single-source plan). |

## Testing Strategy

### Phase 1
- **`__tests__/unit/historical-prices-augmentation.test.ts`** (mirrors manual-NAV test file):
  - **`$0-before-purchase` invariant** — dedicated test (the property the user specifically asked to confirm).
  - `cumulativeAtDate` replay: buy / partial-sell / full-sell sequences.
  - Cross-class composition: crypto-historical + cash-cumulative in one synthetic snapshot row.
  - **Augment-existing AND synthesize-new** both covered: a lot missing from existing in-window snapshots gets augmented; pre-first-snapshot dates get new rows. Assert both segments of `[effective_date, first-capture)` carry the contribution.
  - Missing-price forward-fill; FX-at-date conversion; NaN/Infinity guards.
  - Empty / no-backdated-lots → fast path returns input unchanged.
- **`__tests__/integration/historical-prices-cache.test.ts`**: fetch → upsert idempotency → lookup; RLS/grants posture.
- **`__tests__/integration/backfill-exclusion.test.ts`** (or extend existing): historically-priced lots absent from `getAdjustmentDeltas` output; graceful-degradation path (no prices → stays on back-fill).
- **API fetchers**: mocked Yahoo `/v8/chart` + Frankfurter responses — parsing, forward-fill, timeout/abort handling.

### Phase 2
- Benchmark-over-extended-range tests: backdated acquisition counted as cash flow at `effective_date`; seed correctness across the seam; S&P line coherent from earliest purchase date.

## Deployment

- Develop both phases on `feat/historical-prices-chart`.
- Each phase is a focused, reviewable, independently-tested change (PR into the feature branch or sequential commits — decide during planning).
- Merge the feature branch to `main` **only when both phases are complete** so the auto-deploy never exposes the incoherent half-extended chart.
- Migration `020_historical_prices.sql` ships with Phase 1.

## Files (anticipated)

**New:**
- `supabase/migrations/020_historical_prices.sql`
- `src/lib/portfolio/historical-prices-augmentation.ts`
- `src/lib/prices/historical.ts` (fetch layer: Yahoo range, CoinGecko per-date fallback, Frankfurter timeseries; all `fetchWithTimeout`)
- test files above

**Modified:**
- `src/lib/actions/activity-log.ts` (`getAdjustmentDeltas` third exclusion Set)
- `src/lib/portfolio/assemble.ts`, `src/lib/actions/snapshots.ts`, `src/lib/actions/shared-portfolio.ts`, `src/lib/actions/comparison.ts` (thread `fetchHistoricalPriceInputsFor` + call `augmentAndExtendSnapshots` at the same point `augmentSnapshotsWithManualNavs` runs — returns extended `PortfolioSnapshot[]`)
- `src/lib/portfolio/chart-enrichment.ts` (no change needed if it already maps the snapshot array to points — verify; S&P seed unchanged in Phase 1)
- `src/types/database.ts` (regenerated after migration)
- Phase 2: `src/lib/actions/benchmark.ts` (+ deriveCashFlows interaction)

## Open Questions (resolve during planning)

1. `historical_prices` RLS/grants exact posture (public-read table vs RLS-on with authenticated SELECT policy).
2. Phase 2 benchmark semantics — exact mechanism for treating backdated acquisitions as cash flows at `effective_date` without breaking the windowed-view seeding. Needs careful design against `benchmark.ts` + the existing `is_adjustment` exclusion rationale.
3. Lazy-fetch placement within `assemble.ts` parallel block + per-asset timeout budget under the Vercel 10s limit when several lots need first-time fetching at once (mitigation: fetch ranges are 1–3 calls each; consider capping concurrent first-fetches per render).
