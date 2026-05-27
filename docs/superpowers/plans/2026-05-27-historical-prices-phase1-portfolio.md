# Historical-Price Chart Augmentation — Phase 1 (Portfolio Line) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the portfolio chart backward to each backdated crypto/stock lot's real purchase date, reconstructing pre-snapshot value from exact `qty × historical-price × fx` instead of the flat-line back-fill.

**Architecture:** A global, append-only `historical_prices` cache (Migration 020) feeds a pure synthesis module (`historical-prices-augmentation.ts`) that mirrors `manual-nav-augmentation.ts`. The module operates on `PortfolioSnapshot[]` (NOT `ChartPoint[]`) so the chart, period-change cards (`findSnapshotAt`), and the S&P seed (`points[0]`) all see the extended history. It does two things in one pass: **augment** existing in-window snapshots that are missing a backdated lot, and **synthesize** new pre-first-snapshot rows. A `capture_date` upper bound prevents double-counting once the daily cron starts pricing the lot. Lazy fetch-on-read fills the cache; backdated lots stay on the old back-fill until their prices land (graceful degradation).

**Tech Stack:** TypeScript, Next.js 16 server actions, Supabase (PostgreSQL + RLS), Yahoo `/v8/chart` (crypto `{SYM}-USD` + stocks), Frankfurter timeseries (FX), Vitest (unit + integration), `fetchWithTimeout` (8s).

**Spec:** `docs/superpowers/specs/2026-05-27-historical-prices-augmentation-design.md`
**Branch:** `feat/historical-prices-chart` (do NOT merge to `main` until Phase 2 is also complete — see the spec's Deployment section).

---

## Planning Refinements (read before starting — these correct/sharpen the spec)

The spec was written before reading the integration code. Planning surfaced four refinements that this plan implements. They do not change the spec's intent; they make it correct against the real codebase.

1. **`capture_date` double-count guard (NEW, load-bearing).** Unlike manual-NAV assets (the cron *never* prices them, so `augmentSnapshotsWithManualNavs` adds to every snapshot safely), the daily cron **does** write `crypto_value_usd` / `stocks_value_usd` (`supabase/functions/daily-snapshot/index.ts:546-547`). So once a backdated crypto/stock lot is inserted, every cron snapshot from that day forward already includes it. Augmenting those rows too would double-count. Therefore each lot carries a `capture_date` (the date the cron first captured it), and the augment contribution applies **only to snapshot dates `< capture_date`**. `capture_date` is derived from the position's earliest `activity_log` entry — `crypto_positions`/`stock_positions` have **no `created_at` column** (verified), so the position row cannot supply it.

2. **Two real integration points, not four.** The spec lists `assemble.ts`, `snapshots.ts`, `shared-portfolio.ts`, `comparison.ts`. In reality `augmentSnapshotsWithManualNavs` runs in only **two** places — `getSnapshots` (`snapshots.ts:166`) and `getSharedPortfolio` (`shared-portfolio.ts:225`). `comparison.ts` is a pure consumer that delegates to both (`getSnapshots(365)` + `getSharedPortfolio(token)`), so it inherits the extension transitively. `assemble.ts` builds the *live* dashboard total, not the historical snapshot array, so it gets no augmentation call. We thread into the two real sites only.

3. **Phase 1 scope = crypto + stock only.** Cash/stablecoin backdated lots stay on the existing back-fill (mathematically exact for face-value assets; <0.2% production skew). The pure `cumulativeAtDate` primitive is written generally so cash can be wired later, but Phase 1 does not fetch cash/stablecoin balance history. Pre-first-snapshot cash is not reconstructed (documented limitation; the user is backdating crypto/stock, per the spec).

4. **USD-pivot FX.** Historical FX is stored as `asset_kind='fx'`, `asset_key=<currency code>`, `price = USD per 1 unit of that currency`. This generalizes beyond EUR/USD to any stock trading currency (GBP, CHF, …). `usdPerUnit("USD") = 1` (special-cased, never stored). `eurPerUsd(D) = 1 / usdPerUnit("EUR", D)`.

**Consistency invariant (augment ↔ exclude):** both the augmentation gate (in `getSnapshots`) and the back-fill exclusion (in `getAdjustmentDeltas`) key off the *same* condition — "does `historical_prices` hold rows for this asset's key?" If yes → the lot is excluded from the flat back-fill **and** augmented with real prices. If no → it stays on the back-fill and is not augmented. Consistent by construction, no shared mutable set needed.

---

## File Structure

**New files:**
- `supabase/migrations/020_historical_prices.sql` — the global price cache table (create via Bash heredoc; the PreToolUse hook blocks Write/Edit under `supabase/migrations/`).
- `src/lib/portfolio/historical-prices-augmentation.ts` — pure synthesis primitives + the I/O fetchers. One responsibility: turn (snapshots, backdated lots, cached prices) into an extended `PortfolioSnapshot[]`.
- `src/lib/prices/historical.ts` — network fetch layer (Yahoo daily history for crypto+stock, Frankfurter USD-pivot FX timeseries, CoinGecko per-date fallback). All `fetchWithTimeout`-guarded.
- `__tests__/unit/historical-prices-augmentation.test.ts` — pure-function unit tests (incl. the `$0-before-purchase` invariant).
- `__tests__/unit/historical-fetch.test.ts` — fetch-layer parsing/forward-fill/timeout tests (mocked `fetch`).
- `__tests__/integration/historical-prices-cache.test.ts` — cache upsert idempotency + RLS/grants posture (needs local Supabase).

**Modified files:**
- `src/lib/actions/activity-log.ts` — add the third exclusion set (`historicallyPricedPosIds`) to `getAdjustmentDeltas`.
- `src/lib/actions/snapshots.ts` — thread the historical fetch + `augmentAndExtendSnapshots` into `getSnapshots`.
- `src/lib/actions/shared-portfolio.ts` — same threading into `getSharedPortfolio` (admin client + explicit `userId`).
- `src/types/database.ts` — regenerated after Migration 020 (CI drift check enforces this).

---

## Task 1: Migration 020 — `historical_prices` cache table

**Files:**
- Create: `supabase/migrations/020_historical_prices.sql` (via Bash heredoc — hook blocks Write/Edit here)
- Modify (regenerate): `src/types/database.ts`

- [ ] **Step 1: Create the migration file via heredoc**

Run exactly this (the heredoc avoids the Write/Edit hook on `supabase/migrations/`):

```bash
cat > supabase/migrations/020_historical_prices.sql <<'SQL'
-- 020_historical_prices.sql
-- Global, shared, append-only cache of historical daily prices.
--
-- Purpose: reconstruct the portfolio chart back to each backdated crypto/stock
-- lot's real purchase date using exact qty × historical-price, replacing the
-- flat-line back-fill (getAdjustmentDeltas) that is badly wrong for sizable,
-- multi-year, volatile lots.
--
-- Design:
--   - NO user_id: a BTC price on a given date is identical for every user.
--     This is a shared market-data cache, not user data. Written by the
--     fetch layer via the service-role (admin) client; readable by any
--     authenticated user.
--   - Append-only: past prices never change after the trading day closes, so
--     the table grows monotonically and is never invalidated.
--   - asset_key is canonical PER KIND: crypto = coingecko_id (NOT the Yahoo
--     symbol — Yahoo is only the fetch mechanism), stock = yahoo_ticker,
--     fx = ISO currency code (price = USD per 1 unit of that currency).
--   - UNIQUE(asset_kind, asset_key, price_date) makes re-fetch idempotent
--     (ON CONFLICT DO NOTHING / upsert).
--
-- RLS posture: RLS ENABLED with a permissive authenticated SELECT policy
-- (defense-in-depth consistency with the rest of the schema, even though the
-- data is non-sensitive public market data). NO write policy — writes go
-- through the service-role client, which bypasses RLS. anon is REVOKEd
-- (consistency with migration 019's manual_nav hardening).

CREATE TABLE public.historical_prices (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_kind   TEXT          NOT NULL CHECK (asset_kind IN ('crypto','stock','fx')),
  asset_key    TEXT          NOT NULL,
  price_date   DATE          NOT NULL,
  price        NUMERIC(20,8) NOT NULL CHECK (price > 0),
  currency     TEXT          NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (asset_kind, asset_key, price_date)
);

COMMENT ON TABLE public.historical_prices IS
  'Global append-only daily price cache for chart back-extension. asset_key: crypto=coingecko_id, stock=yahoo_ticker, fx=currency code (price=USD per 1 unit). No user_id — shared market data, written by service-role only.';

-- The UNIQUE constraint already creates a btree index on
-- (asset_kind, asset_key, price_date) which serves the lookup
-- "all prices for one asset, ordered by date". No extra index needed.

ALTER TABLE public.historical_prices ENABLE ROW LEVEL SECURITY;

-- Read-only for authenticated users (shared market data). No USING clause
-- on user_id because there is none — every authenticated user may read all
-- rows. Writes are not granted to authenticated; only service-role writes.
CREATE POLICY "authenticated_read_historical_prices"
  ON public.historical_prices
  FOR SELECT
  TO authenticated
  USING (public.is_active_user());

GRANT SELECT ON TABLE public.historical_prices TO authenticated;
GRANT ALL    ON TABLE public.historical_prices TO service_role;
REVOKE ALL   ON TABLE public.historical_prices FROM anon;
SQL
echo "migration written:"; wc -l supabase/migrations/020_historical_prices.sql
```

- [ ] **Step 2: Apply the migration to local Supabase**

Run: `supabase db reset`
Expected: all migrations 001→020 apply with no error; final line reports the reset finished. (If `supabase` is not running, `supabase start` first.)

- [ ] **Step 3: Regenerate the database types**

Run (the `sed` strips the CLI's stdout banner that would corrupt the file):
```bash
supabase gen types typescript --local 2>/dev/null | sed '/^Connecting to db/d' > src/types/database.ts
```
Then verify the new table is present:
```bash
grep -n "historical_prices" src/types/database.ts | head
```
Expected: matches for `historical_prices: {` with `Row`/`Insert`/`Update`.

- [ ] **Step 4: Typecheck (confirms generated types compile)**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/020_historical_prices.sql src/types/database.ts
git commit -m "feat: add historical_prices cache table (migration 020)"
```

---

## Task 2: Pure date-lookup + cumulative primitives

**Files:**
- Create: `src/lib/portfolio/historical-prices-augmentation.ts`
- Test: `__tests__/unit/historical-prices-augmentation.test.ts`

These three primitives mirror `findNavAtOrBefore` / `buildNavIndex` in `manual-nav-augmentation.ts:36-70`. Build them first; later tasks compose them.

- [ ] **Step 1: Write the failing tests for the primitives**

Create `__tests__/unit/historical-prices-augmentation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  findPriceAtOrBefore,
  buildPriceIndex,
  cumulativeAtDate,
  type HistoricalPriceRow,
  type QtyDelta,
} from "@/lib/portfolio/historical-prices-augmentation";

const px = (
  asset_kind: HistoricalPriceRow["asset_kind"],
  asset_key: string,
  price_date: string,
  price: number,
  currency = "USD",
): HistoricalPriceRow => ({ asset_kind, asset_key, price_date, price, currency });

describe("findPriceAtOrBefore", () => {
  it("returns null for an empty list", () => {
    expect(findPriceAtOrBefore([], "2026-01-01")).toBeNull();
  });

  it("returns null when the target precedes the earliest price", () => {
    const rows = [px("crypto", "bitcoin", "2021-01-10", 30000)];
    expect(findPriceAtOrBefore(rows, "2021-01-09")).toBeNull();
  });

  it("returns the exact price when the target equals a price_date", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-01-01", 29000),
      px("crypto", "bitcoin", "2021-02-01", 33000),
    ];
    expect(findPriceAtOrBefore(rows, "2021-02-01")).toBe(33000);
  });

  it("forward-fills: returns the most-recent price strictly before the target (weekend/holiday gap)", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-01-01", 29000),
      px("crypto", "bitcoin", "2021-01-04", 31000),
    ];
    // 2021-01-02 and 03 are a weekend with no row → forward-fill from Jan 1.
    expect(findPriceAtOrBefore(rows, "2021-01-03")).toBe(29000);
  });
});

describe("buildPriceIndex", () => {
  it("groups by asset_kind:asset_key and sorts each group ascending by date", () => {
    const rows = [
      px("crypto", "bitcoin", "2021-03-01", 50000),
      px("stock", "AAPL", "2021-01-01", 130),
      px("crypto", "bitcoin", "2021-01-01", 29000),
    ];
    const idx = buildPriceIndex(rows);
    expect(idx.get("crypto:bitcoin")!.map((r) => r.price_date)).toEqual([
      "2021-01-01",
      "2021-03-01",
    ]);
    expect(idx.get("stock:AAPL")).toHaveLength(1);
  });
});

describe("cumulativeAtDate", () => {
  const deltas: QtyDelta[] = [
    { effective_date: "2021-01-01", qty_delta: 5 },   // buy 5
    { effective_date: "2023-06-01", qty_delta: -2 },  // partial sell
    { effective_date: "2024-01-01", qty_delta: -3 },  // full sell
  ];

  it("is 0 before the first effective_date ($0-before-purchase building block)", () => {
    expect(cumulativeAtDate(deltas, "2020-12-31")).toBe(0);
  });

  it("replays buys and partial sells in date order", () => {
    expect(cumulativeAtDate(deltas, "2021-01-01")).toBe(5);
    expect(cumulativeAtDate(deltas, "2023-06-01")).toBe(3);
    expect(cumulativeAtDate(deltas, "2023-12-31")).toBe(3);
  });

  it("returns 0 after a full sell", () => {
    expect(cumulativeAtDate(deltas, "2024-01-01")).toBe(0);
    expect(cumulativeAtDate(deltas, "2025-01-01")).toBe(0);
  });

  it("ignores deltas given out of order (does not assume sorted input)", () => {
    const unordered: QtyDelta[] = [
      { effective_date: "2023-06-01", qty_delta: -2 },
      { effective_date: "2021-01-01", qty_delta: 5 },
    ];
    expect(cumulativeAtDate(unordered, "2022-01-01")).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/portfolio/historical-prices-augmentation"` (module not created yet).

- [ ] **Step 3: Create the module with the types and three primitives**

Create `src/lib/portfolio/historical-prices-augmentation.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import type { Database } from "@/types/database";
import type { PortfolioSnapshot } from "@/lib/types";

/**
 * One cached historical price. `asset_key` is canonical per kind:
 *   crypto = coingecko_id, stock = yahoo_ticker, fx = currency code
 *   (price = USD per 1 unit of that currency).
 * Kept in this pure module (no "use server") so synthesis is unit-testable
 * without Supabase, Next.js, or RLS — mirrors manual-nav-augmentation.ts.
 */
export type HistoricalPriceRow = {
  asset_kind: "crypto" | "stock" | "fx";
  asset_key: string;
  price_date: string; // YYYY-MM-DD
  price: number;
  currency: string;
};

/** A single quantity change for a position, dated by effective_date. */
export type QtyDelta = { effective_date: string; qty_delta: number };

/**
 * A backdated crypto/stock lot needing historical reconstruction.
 *   - asset_key: storage/lookup key (coingecko_id | yahoo_ticker)
 *   - fetch_symbol: Yahoo symbol used by the fetch layer
 *       (`${ticker}-USD` for crypto, yahoo_ticker for stock)
 *   - native_currency: "USD" for crypto (Yahoo {SYM}-USD is USD-denominated);
 *       the native trading currency for stock
 *   - capture_date: the date the daily cron first included this lot in
 *       snapshots (= date of the position's earliest activity_log entry).
 *       Augment ONLY snapshot dates < capture_date — on/after it the cron
 *       already prices the lot, so augmenting would double-count.
 *   - deltas: quantity changes by effective_date (need not be pre-sorted).
 */
export type HistoricalLot = {
  position_id: string;
  asset_kind: "crypto" | "stock";
  asset_key: string;
  fetch_symbol: string;
  native_currency: string;
  asset_class: "crypto" | "stocks";
  capture_date: string;
  deltas: QtyDelta[];
};

/** Map key for the price index: `${asset_kind}:${asset_key}`. */
function priceKey(asset_kind: string, asset_key: string): string {
  return `${asset_kind}:${asset_key}`;
}

/**
 * Binary search for the largest-date price at-or-before `targetDate`.
 * `pricesAsc` MUST be sorted ascending by price_date. Forward-fill semantics
 * (returns the most-recent prior price across weekend/holiday gaps).
 * O(log n). Mirrors findNavAtOrBefore in manual-nav-augmentation.ts.
 */
export function findPriceAtOrBefore(
  pricesAsc: HistoricalPriceRow[],
  targetDate: string,
): number | null {
  if (pricesAsc.length === 0) return null;
  let lo = 0;
  let hi = pricesAsc.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (pricesAsc[mid].price_date <= targetDate) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? pricesAsc[result].price : null;
}

/**
 * Group price rows by `${asset_kind}:${asset_key}`, each list sorted ascending
 * by price_date for binary search regardless of caller-supplied order.
 */
export function buildPriceIndex(
  rows: HistoricalPriceRow[],
): Map<string, HistoricalPriceRow[]> {
  const index = new Map<string, HistoricalPriceRow[]>();
  for (const row of rows) {
    const key = priceKey(row.asset_kind, row.asset_key);
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(row);
  }
  for (const list of index.values()) {
    list.sort((a, b) => a.price_date.localeCompare(b.price_date));
  }
  return index;
}

/**
 * Cumulative quantity at `date` = sum of every qty_delta whose effective_date
 * is on-or-before `date`. Returns 0 before the first delta — this is the
 * building block of the "$0 before purchase" invariant. Does not assume the
 * input is sorted (filters by date, so order is irrelevant). Used for position
 * quantity (Phase 1) and, in future, cash/stablecoin balance.
 */
export function cumulativeAtDate(deltas: QtyDelta[], date: string): number {
  let qty = 0;
  for (const d of deltas) {
    if (d.effective_date <= date) qty += d.qty_delta;
  }
  return qty;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS (all primitive tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts
git commit -m "feat: historical-prices synthesis primitives (findPriceAtOrBefore, buildPriceIndex, cumulativeAtDate)"
```

---

## Task 3: Pure value composition — `lotContributionAtDate`

**Files:**
- Modify: `src/lib/portfolio/historical-prices-augmentation.ts`
- Test: `__tests__/unit/historical-prices-augmentation.test.ts`

Computes one lot's USD+EUR contribution to a snapshot date via `qty × price × fx`, with USD-pivot FX and `Number.isFinite` guards (the Phase 5 lesson against supabase-js string numerics / NaN poisoning).

- [ ] **Step 1: Write the failing tests (append to the test file)**

Append to `__tests__/unit/historical-prices-augmentation.test.ts`:

```typescript
import {
  lotContributionAtDate,
  usdPerUnit,
  type HistoricalLot,
} from "@/lib/portfolio/historical-prices-augmentation";

const lot = (overrides: Partial<HistoricalLot> = {}): HistoricalLot => ({
  position_id: "pos-1",
  asset_kind: "crypto",
  asset_key: "bitcoin",
  fetch_symbol: "BTC-USD",
  native_currency: "USD",
  asset_class: "crypto",
  capture_date: "2026-05-01",
  deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
  ...overrides,
});

describe("usdPerUnit", () => {
  it("returns 1 for USD without consulting the index", () => {
    expect(usdPerUnit(new Map(), "USD", "2021-01-01")).toBe(1);
  });

  it("looks up USD-per-unit for a foreign currency, forward-filled", () => {
    const fxIndex = buildPriceIndex([
      px("fx", "EUR", "2021-01-01", 1.21), // USD per 1 EUR
    ]);
    expect(usdPerUnit(fxIndex, "EUR", "2021-03-01")).toBeCloseTo(1.21, 5);
  });

  it("returns null when no fx rate is available at-or-before the date", () => {
    const fxIndex = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.19)]);
    expect(usdPerUnit(fxIndex, "EUR", "2021-01-01")).toBeNull();
  });
});

describe("lotContributionAtDate", () => {
  it("returns {usd:0,eur:0} before the lot's effective_date ($0-BEFORE-PURCHASE INVARIANT)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2020-06-01", 9000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2020-06-01", 1.12)]);
    // Lot bought 2021-01-01; ask for 2020-12-31 — must contribute nothing
    // even though a BTC price exists for that date.
    const c = lotContributionAtDate(lot(), "2020-12-31", prices, fx);
    expect(c).toEqual({ usd: 0, eur: 0 });
  });

  it("crypto (USD-native): qty × BTC price, EUR via 1/usdPerUnit(EUR)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-01-01", 1.2)]); // USD per EUR
    const c = lotContributionAtDate(lot(), "2021-01-01", prices, fx);
    expect(c!.usd).toBeCloseTo(2 * 30000, 2); // 60000
    // eurPerUsd = 1/1.2 = 0.8333 → 60000 × 0.8333 = 50000
    expect(c!.eur).toBeCloseTo(60000 / 1.2, 2);
  });

  it("returns null contribution when no price exists yet (pre-listing)", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-06-01", 35000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-06-01", 1.18)]);
    // qty>0 at this date, but no price on-or-before 2021-03-01 → null (skip).
    expect(lotContributionAtDate(lot(), "2021-03-01", prices, fx)).toBeNull();
  });

  it("stock in native EUR: value is EUR-direct, USD via usdPerUnit(EUR)", () => {
    const stock = lot({
      asset_kind: "stock",
      asset_key: "SAP.DE",
      fetch_symbol: "SAP.DE",
      native_currency: "EUR",
      asset_class: "stocks",
      deltas: [{ effective_date: "2022-01-01", qty_delta: 10 }],
    });
    const prices = buildPriceIndex([px("stock", "SAP.DE", "2022-01-01", 100, "EUR")]);
    const fx = buildPriceIndex([px("fx", "EUR", "2022-01-01", 1.13)]); // USD per EUR
    const c = lotContributionAtDate(stock, "2022-01-01", prices, fx);
    expect(c!.eur).toBeCloseTo(10 * 100, 2); // 1000 EUR
    expect(c!.usd).toBeCloseTo(10 * 100 * 1.13, 2); // → USD
  });

  it("skips EUR mirror (eur=0) when fx is unavailable, never fabricates 1:1", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([]); // no fx at all
    const c = lotContributionAtDate(lot(), "2021-01-01", prices, fx);
    expect(c!.usd).toBeCloseTo(60000, 2);
    expect(c!.eur).toBe(0); // mirror skipped, not contaminated
  });

  it("guards against NaN/Infinity in price or qty", () => {
    const prices = buildPriceIndex([px("crypto", "bitcoin", "2021-01-01", 30000)]);
    const fx = buildPriceIndex([px("fx", "EUR", "2021-01-01", 1.2)]);
    const bad = lot({ deltas: [{ effective_date: "2021-01-01", qty_delta: NaN }] });
    expect(lotContributionAtDate(bad, "2021-01-01", prices, fx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts -t "lotContributionAtDate|usdPerUnit"`
Expected: FAIL — `lotContributionAtDate`/`usdPerUnit` not exported.

- [ ] **Step 3: Implement `usdPerUnit` and `lotContributionAtDate`**

Append to `src/lib/portfolio/historical-prices-augmentation.ts`:

```typescript
/**
 * USD per 1 unit of `currency` at `date`. USD is the pivot: "USD" → 1 without
 * touching the index. Foreign currencies are looked up from fx rows
 * (asset_kind='fx', asset_key=currency, price=USD per 1 unit), forward-filled.
 * Returns null when no rate is available at-or-before `date`.
 */
export function usdPerUnit(
  fxIndex: Map<string, HistoricalPriceRow[]>,
  currency: string,
  date: string,
): number | null {
  if (currency === "USD") return 1;
  const list = fxIndex.get(priceKey("fx", currency));
  if (!list) return null;
  return findPriceAtOrBefore(list, date);
}

/**
 * One lot's contribution to a snapshot date, in USD and EUR.
 *
 *   qty   = cumulativeAtDate(lot.deltas, date)        // 0 before purchase
 *   price = findPriceAtOrBefore(prices[kind:key], date) // forward-filled
 *   valueNative = qty × price (in lot.native_currency)
 *   usd  = valueNative × usdPerUnit(native_currency, date)
 *   eur  = usd × eurPerUsd(date), eurPerUsd = 1 / usdPerUnit("EUR", date)
 *
 * Returns:
 *   { usd: 0, eur: 0 } when qty is 0 (the $0-before-purchase invariant, and
 *       after a full sell) — a real, intentional zero contribution.
 *   null when a value cannot be computed (no price yet, or NaN/Infinity, or no
 *       USD rate for the native currency) — caller skips, never fabricates.
 *
 * The EUR mirror is skipped (eur stays 0) when no EUR fx rate is available,
 * rather than writing a 1:1 identity copy (the audit R1 Phase 5 contract).
 */
export function lotContributionAtDate(
  lot: HistoricalLot,
  date: string,
  priceIndex: Map<string, HistoricalPriceRow[]>,
  fxIndex: Map<string, HistoricalPriceRow[]>,
): { usd: number; eur: number } | null {
  const qty = cumulativeAtDate(lot.deltas, date);
  if (!Number.isFinite(qty)) return null;
  if (qty === 0) return { usd: 0, eur: 0 };

  const prices = priceIndex.get(priceKey(lot.asset_kind, lot.asset_key));
  if (!prices) return null;
  const priceNative = findPriceAtOrBefore(prices, date);
  if (priceNative === null || !Number.isFinite(priceNative) || priceNative <= 0) {
    return null;
  }

  const valueNative = qty * priceNative;
  if (!Number.isFinite(valueNative)) return null;

  // Native → USD.
  const usdRate = usdPerUnit(fxIndex, lot.native_currency, date);
  if (usdRate === null || !Number.isFinite(usdRate) || usdRate <= 0) return null;
  const usd = valueNative * usdRate;
  if (!Number.isFinite(usd)) return null;

  // USD → EUR via eurPerUsd = 1 / usdPerUnit("EUR"). Skip mirror if unknown.
  const usdPerEur = usdPerUnit(fxIndex, "EUR", date);
  let eur = 0;
  if (usdPerEur !== null && Number.isFinite(usdPerEur) && usdPerEur > 0) {
    eur = usd / usdPerEur;
    if (!Number.isFinite(eur)) eur = 0;
  }

  return { usd, eur };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS (primitives + composition).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts
git commit -m "feat: lotContributionAtDate value composition (qty × price × USD-pivot fx + guards)"
```

---

## Task 4: Pure core — `augmentAndExtendSnapshots`

**Files:**
- Modify: `src/lib/portfolio/historical-prices-augmentation.ts`
- Test: `__tests__/unit/historical-prices-augmentation.test.ts`

The load-bearing function. Two responsibilities in one pass: **augment** existing snapshots in `[effective_date, capture_date)`, and **synthesize** new daily rows for `[earliest effective_date, first-snapshot-date)`. Returns the extended `PortfolioSnapshot[]` sorted ascending by `snapshot_date`.

- [ ] **Step 1: Write the failing tests (append to the test file)**

Append to `__tests__/unit/historical-prices-augmentation.test.ts`:

```typescript
import {
  augmentAndExtendSnapshots,
} from "@/lib/portfolio/historical-prices-augmentation";
import type { PortfolioSnapshot } from "@/lib/types";

function snap(overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    id: "s",
    user_id: "u",
    snapshot_date: "2026-03-01",
    total_value_usd: 0,
    total_value_eur: 0,
    crypto_value_usd: 0,
    stocks_value_usd: 0,
    cash_value_usd: 0,
    crypto_value_eur: 0,
    stocks_value_eur: 0,
    cash_value_eur: 0,
    stocks_eur_denominated_value: 0,
    cash_eur_denominated_value: 0,
    created_at: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

// 2 BTC bought 2021-01-01, captured by cron 2026-03-01. Prices: 30k @2021,
// 60k @2026-02. FX 1.2 USD/EUR throughout.
const btcLot: HistoricalLot = {
  position_id: "btc-1",
  asset_kind: "crypto",
  asset_key: "bitcoin",
  fetch_symbol: "BTC-USD",
  native_currency: "USD",
  asset_class: "crypto",
  capture_date: "2026-03-01",
  deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
};
const priceRows: HistoricalPriceRow[] = [
  px("crypto", "bitcoin", "2021-01-01", 30000),
  px("crypto", "bitcoin", "2026-02-01", 60000),
  px("fx", "EUR", "2021-01-01", 1.2),
  px("fx", "EUR", "2026-02-01", 1.2),
];

describe("augmentAndExtendSnapshots", () => {
  it("returns input unchanged when there are no lots", () => {
    const snaps = [snap({ snapshot_date: "2026-03-01" })];
    expect(augmentAndExtendSnapshots(snaps, [], [])).toEqual(snaps);
  });

  it("synthesizes pre-first-snapshot rows AND extends back to effective_date", () => {
    // First (and only) real snapshot is on capture date 2026-03-01.
    const real = snap({
      snapshot_date: "2026-03-01",
      crypto_value_usd: 120000, // cron already priced 2 BTC @ 60k
      total_value_usd: 120000,
      crypto_value_eur: 100000,
      total_value_eur: 100000,
    });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);

    // Earliest synthesized row is the purchase date, value = 2 × 30k = 60k.
    expect(out[0].snapshot_date).toBe("2021-01-01");
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
    expect(out[0].total_value_usd).toBeCloseTo(60000, 2);
    expect(out[0].crypto_value_eur).toBeCloseTo(60000 / 1.2, 2);

    // Output is sorted ascending and ends with the real snapshot.
    expect(out[out.length - 1].snapshot_date).toBe("2026-03-01");
    for (let i = 1; i < out.length; i++) {
      expect(out[i].snapshot_date >= out[i - 1].snapshot_date).toBe(true);
    }
  });

  it("does NOT touch the real snapshot on/after capture_date (no double-count)", () => {
    const real = snap({
      snapshot_date: "2026-03-01", // == capture_date → already includes the lot
      crypto_value_usd: 120000,
      total_value_usd: 120000,
    });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);
    const captured = out.find((s) => s.snapshot_date === "2026-03-01")!;
    expect(captured.crypto_value_usd).toBe(120000); // unchanged
  });

  it("AUGMENTS an in-window snapshot before capture_date that is missing the lot", () => {
    // A real snapshot exists on 2026-02-15 (before capture 2026-03-01). The lot
    // was inserted today, so this snapshot does NOT yet include it → augment.
    const before = snap({
      snapshot_date: "2026-02-15",
      crypto_value_usd: 0,
      total_value_usd: 0,
    });
    const captured = snap({
      snapshot_date: "2026-03-01",
      crypto_value_usd: 120000,
      total_value_usd: 120000,
    });
    const out = augmentAndExtendSnapshots([before, captured], [btcLot], priceRows);

    const aug = out.find((s) => s.snapshot_date === "2026-02-15")!;
    // 2 BTC × 60k (forward-filled from 2026-02-01) = 120000 added.
    expect(aug.crypto_value_usd).toBeCloseTo(120000, 2);
    // The captured row stays untouched.
    expect(out.find((s) => s.snapshot_date === "2026-03-01")!.crypto_value_usd).toBe(120000);
  });

  it("never synthesizes before the earliest effective_date (far-back cap)", () => {
    const real = snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 });
    const out = augmentAndExtendSnapshots([real], [btcLot], priceRows);
    expect(out.every((s) => s.snapshot_date >= "2021-01-01")).toBe(true);
  });

  it("is pure — does not mutate the input snapshots", () => {
    const real = snap({ snapshot_date: "2026-03-01", crypto_value_usd: 120000, total_value_usd: 120000 });
    const frozen = JSON.parse(JSON.stringify(real));
    augmentAndExtendSnapshots([real], [btcLot], priceRows);
    expect(real).toEqual(frozen);
  });

  it("handles the no-real-snapshots case (brand-new user, all history synthesized)", () => {
    const out = augmentAndExtendSnapshots([], [btcLot], priceRows);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].snapshot_date).toBe("2021-01-01");
    expect(out[0].crypto_value_usd).toBeCloseTo(60000, 2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts -t "augmentAndExtendSnapshots"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `augmentAndExtendSnapshots`**

Append to `src/lib/portfolio/historical-prices-augmentation.ts`. Note the helper `addContribution` routes by `asset_class` to the right snapshot columns (`crypto_value_*` / `stocks_value_*`) and always also updates `total_value_*`.

```typescript
/** Iterate dates from `start` to `end` inclusive, daily, as YYYY-MM-DD. */
function* eachDay(start: string, end: string): Generator<string> {
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/** Add a USD+EUR contribution to the right asset-class columns + totals. */
function addContribution(
  snap: PortfolioSnapshot,
  assetClass: "crypto" | "stocks",
  usd: number,
  eur: number,
): PortfolioSnapshot {
  if (assetClass === "crypto") {
    return {
      ...snap,
      crypto_value_usd: (snap.crypto_value_usd ?? 0) + usd,
      crypto_value_eur: (snap.crypto_value_eur ?? 0) + eur,
      total_value_usd: (snap.total_value_usd ?? 0) + usd,
      total_value_eur: (snap.total_value_eur ?? 0) + eur,
    };
  }
  return {
    ...snap,
    stocks_value_usd: (snap.stocks_value_usd ?? 0) + usd,
    stocks_value_eur: (snap.stocks_value_eur ?? 0) + eur,
    total_value_usd: (snap.total_value_usd ?? 0) + usd,
    total_value_eur: (snap.total_value_eur ?? 0) + eur,
  };
}

/**
 * Build a fresh synthesized snapshot for `date` from all lots active then.
 * Synthetic rows are flagged with id `synthetic:<date>` and inherit user_id
 * from `template` (the earliest real snapshot, or a stub if none exist).
 */
function synthesizeRow(
  date: string,
  lots: HistoricalLot[],
  priceIndex: Map<string, HistoricalPriceRow[]>,
  fxIndex: Map<string, HistoricalPriceRow[]>,
  template: PortfolioSnapshot | null,
): PortfolioSnapshot {
  let row: PortfolioSnapshot = {
    id: `synthetic:${date}`,
    user_id: template?.user_id ?? "",
    snapshot_date: date,
    total_value_usd: 0,
    total_value_eur: 0,
    crypto_value_usd: 0,
    stocks_value_usd: 0,
    cash_value_usd: 0,
    crypto_value_eur: 0,
    stocks_value_eur: 0,
    cash_value_eur: 0,
    stocks_eur_denominated_value: 0,
    cash_eur_denominated_value: 0,
    created_at: `${date}T00:00:00Z`,
  };
  for (const lot of lots) {
    const c = lotContributionAtDate(lot, date, priceIndex, fxIndex);
    if (c === null) continue;
    row = addContribution(row, lot.asset_class, c.usd, c.eur);
  }
  return row;
}

/**
 * Extend and augment the snapshot series with exact historical-price
 * contributions for backdated crypto/stock lots.
 *
 *   AUGMENT: for each existing snapshot whose date is in [effective, capture)
 *     for a lot, add that lot's qty × historical-price contribution. (On/after
 *     capture_date the cron already prices it — left untouched to avoid
 *     double-counting.)
 *   SYNTHESIZE: for every day in [earliest effective_date, first-snapshot-date)
 *     create a new row summing all lots active that day.
 *
 * Returns a new array sorted ascending by snapshot_date. Pure — no DB, no clock.
 * Caller must pass only lots that actually have cached prices (graceful
 * degradation: a lot with no prices is simply left on the back-fill upstream).
 */
export function augmentAndExtendSnapshots(
  snapshots: PortfolioSnapshot[],
  lots: HistoricalLot[],
  prices: HistoricalPriceRow[],
): PortfolioSnapshot[] {
  if (lots.length === 0) return snapshots;

  const priceIndex = buildPriceIndex(prices);
  const fxIndex = priceIndex; // fx rows live in the same index under "fx:<cur>"

  // ── AUGMENT existing snapshots in [effective, capture) per lot ──────────
  const augmented = snapshots.map((snap) => {
    let row = snap;
    for (const lot of lots) {
      if (snap.snapshot_date >= lot.capture_date) continue; // cron already has it
      const c = lotContributionAtDate(lot, snap.snapshot_date, priceIndex, fxIndex);
      if (c === null) continue;
      if (c.usd === 0 && c.eur === 0) continue; // before effective_date / sold out
      row = addContribution(row, lot.asset_class, c.usd, c.eur);
    }
    return row;
  });

  // ── SYNTHESIZE pre-first-snapshot rows ──────────────────────────────────
  const sortedReal = [...augmented].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  const firstSnapshotDate = sortedReal.length > 0 ? sortedReal[0].snapshot_date : null;

  let earliestEffective: string | null = null;
  for (const lot of lots) {
    for (const d of lot.deltas) {
      if (earliestEffective === null || d.effective_date < earliestEffective) {
        earliestEffective = d.effective_date;
      }
    }
  }
  if (earliestEffective === null) return sortedReal;

  // Synthesize up to (but not including) the first real snapshot date; if there
  // are no real snapshots, synthesize through today.
  const synthEnd = firstSnapshotDate
    ? isoDayBefore(firstSnapshotDate)
    : new Date().toISOString().slice(0, 10);

  const synthesized: PortfolioSnapshot[] = [];
  if (earliestEffective <= synthEnd) {
    const template = sortedReal[0] ?? null;
    for (const date of eachDay(earliestEffective, synthEnd)) {
      synthesized.push(synthesizeRow(date, lots, priceIndex, fxIndex, template));
    }
  }

  return [...synthesized, ...sortedReal];
}

/** YYYY-MM-DD for the day before `date`. */
function isoDayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts
git commit -m "feat: augmentAndExtendSnapshots (augment in-window + synthesize pre-snapshot, capture_date guard)"
```

---

## Task 5: Fetch layer — `src/lib/prices/historical.ts`

**Files:**
- Create: `src/lib/prices/historical.ts`
- Test: `__tests__/unit/historical-fetch.test.ts`

Network I/O only (no DB). Yahoo daily history for crypto (`{SYM}-USD`) + stocks via explicit `period1`/`period2` (the `fetchIndexHistory` lesson — `range=max` silently downsamples). Frankfurter timeseries for USD-pivot FX. Each returns `{ date, price }[]` and is `fetchWithTimeout`-guarded with graceful `[]` on failure.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/historical-fetch.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchYahooDailyHistory,
  fetchFxUsdPivotHistory,
} from "@/lib/prices/historical";

afterEach(() => vi.restoreAllMocks());

function mockFetchOnce(body: unknown, ok = true, contentType = "application/json") {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    headers: { get: () => contentType },
    json: async () => body,
  } as unknown as Response);
}

describe("fetchYahooDailyHistory", () => {
  it("parses timestamps + closes into {date, price} rows, dropping nulls", async () => {
    mockFetchOnce({
      chart: {
        result: [
          {
            meta: { dataGranularity: "1d" },
            timestamp: [1609459200, 1609545600], // 2021-01-01, 2021-01-02
            indicators: { quote: [{ close: [29000, null] }] },
          },
        ],
      },
    });
    const rows = await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02");
    expect(rows).toEqual([{ date: "2021-01-01", price: 29000 }]);
  });

  it("returns [] on HTTP error (graceful degradation)", async () => {
    mockFetchOnce({}, false);
    expect(await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02")).toEqual([]);
  });

  it("returns [] on non-JSON (captcha) response", async () => {
    mockFetchOnce("<html>", true, "text/html");
    expect(await fetchYahooDailyHistory("BTC-USD", "2021-01-01", "2021-01-02")).toEqual([]);
  });
});

describe("fetchFxUsdPivotHistory", () => {
  it("converts Frankfurter base=USD timeseries to USD-per-1-unit rows", async () => {
    // Frankfurter base=USD gives 'EUR per 1 USD'; we store USD per 1 EUR = 1/that.
    mockFetchOnce({
      base: "USD",
      rates: {
        "2021-01-01": { EUR: 0.8 }, // 0.8 EUR per USD → 1.25 USD per EUR
        "2021-01-02": { EUR: 0.82 }, // → 1.2195 USD per EUR
      },
    });
    const rows = await fetchFxUsdPivotHistory("EUR", "2021-01-01", "2021-01-02");
    expect(rows[0]).toEqual({ date: "2021-01-01", price: expect.closeTo(1.25, 4) });
    expect(rows[1].price).toBeCloseTo(1 / 0.82, 4);
  });

  it("returns [] when Frankfurter omits the symbol", async () => {
    mockFetchOnce({ base: "USD", rates: { "2021-01-01": {} } });
    expect(await fetchFxUsdPivotHistory("EUR", "2021-01-01", "2021-01-02")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fetch layer**

Create `src/lib/prices/historical.ts`:

```typescript
/**
 * Historical price fetch layer for chart back-extension.
 *
 * Sources (all free, no paid plan):
 *   - Crypto: Yahoo /v8/chart `{SYM}-USD` (BTC-USD, …) — multi-year daily,
 *     USD-denominated. CoinGecko free tier caps market_chart at ~365 days.
 *   - Stocks: Yahoo /v8/chart `{ticker}` — native trading currency.
 *   - FX:     Frankfurter timeseries (ECB), converted to USD-per-1-unit.
 *
 * Every call is fetchWithTimeout-guarded (8s) and returns [] on any failure
 * (graceful degradation — the lot stays on the flat back-fill until prices
 * land). Returns parsed { date: "YYYY-MM-DD", price } rows; the caller maps
 * these into historical_prices rows + upserts via the admin client.
 */
import { fetchWithTimeout } from "./fetch-with-timeout";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v1";
const SECONDS_PER_DAY = 86400;
/** Pad the range so forward-fill has a prior trading day at the start edge. */
const RANGE_PAD_DAYS = 5;

function toUnixDayStart(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

/**
 * Daily closes for a Yahoo symbol over [startDate, endDate] (inclusive),
 * using explicit period1/period2 — NEVER range=Xy (Yahoo silently downsamples
 * range=max to quarterly, see fetchIndexHistory in yahoo.ts). Works for crypto
 * `{SYM}-USD` and ordinary stock tickers alike.
 */
export async function fetchYahooDailyHistory(
  symbol: string,
  startDate: string,
  endDate: string,
): Promise<{ date: string; price: number }[]> {
  const period1 = toUnixDayStart(startDate) - RANGE_PAD_DAYS * SECONDS_PER_DAY;
  const period2 = toUnixDayStart(endDate) + SECONDS_PER_DAY; // include endDate
  try {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      console.warn(`[historical] Yahoo history failed for ${symbol}: ${res.status}`);
      return [];
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      console.warn(`[historical] Yahoo non-JSON for ${symbol} (captcha?): ${contentType}`);
      return [];
    }
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const out: { date: string; price: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null || !Number.isFinite(close) || close <= 0) continue;
      out.push({ date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10), price: close });
    }
    return out;
  } catch (err) {
    console.error(`[historical] Yahoo history error for ${symbol}:`, err);
    return [];
  }
}

/**
 * USD-per-1-unit daily history for a foreign `currency` over [startDate,
 * endDate], from Frankfurter's timeseries (base=USD). Frankfurter returns
 * "currency per 1 USD"; we invert to "USD per 1 unit" so the synthesis layer's
 * usdPerUnit() can multiply directly. Returns [] on failure or missing symbol.
 */
export async function fetchFxUsdPivotHistory(
  currency: string,
  startDate: string,
  endDate: string,
): Promise<{ date: string; price: number }[]> {
  if (currency === "USD") return []; // pivot — never stored
  try {
    const url = `${FRANKFURTER_BASE}/${startDate}..${endDate}?base=USD&symbols=${currency}`;
    const res = await fetchWithTimeout(url, { cache: "force-cache" });
    if (!res.ok) {
      console.warn(`[historical] Frankfurter timeseries failed for ${currency}: ${res.status}`);
      return [];
    }
    const json: { rates?: Record<string, Record<string, number>> } = await res.json();
    const rates = json.rates ?? {};
    const out: { date: string; price: number }[] = [];
    for (const [date, perUsd] of Object.entries(rates)) {
      const v = perUsd[currency];
      if (v == null || !Number.isFinite(v) || v <= 0) continue;
      out.push({ date, price: 1 / v }); // USD per 1 unit
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch (err) {
    console.error(`[historical] Frankfurter timeseries error for ${currency}:`, err);
    return [];
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run __tests__/unit/historical-fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prices/historical.ts __tests__/unit/historical-fetch.test.ts
git commit -m "feat: historical price fetch layer (Yahoo daily + Frankfurter USD-pivot FX)"
```

---

## Task 6: I/O — gather backdated lots + fill the cache

**Files:**
- Modify: `src/lib/portfolio/historical-prices-augmentation.ts` (add I/O functions + a pure lot-builder)
- Test: `__tests__/unit/historical-prices-augmentation.test.ts` (pure builder), `__tests__/integration/historical-prices-cache.test.ts` (cache idempotency + RLS)

This is the only I/O in the synthesis module. It (a) reads the user's backdated crypto/stock activity, (b) builds `HistoricalLot[]` (pure), (c) ensures the needed prices are cached (fetch missing via Task 5, upsert via the admin client), and (d) reads back the relevant cached prices for synthesis.

- [ ] **Step 1: Write the failing test for the pure lot-builder**

Append to `__tests__/unit/historical-prices-augmentation.test.ts`:

```typescript
import { buildHistoricalLots, type ActivityForLot } from "@/lib/portfolio/historical-prices-augmentation";

describe("buildHistoricalLots", () => {
  it("groups activity by position, derives capture_date (min created_at) + deltas, flags backdated", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-1",
        entity_type: "crypto_position",
        action: "create",
        effective_date: "2021-01-01",
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 2,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    const lots = buildHistoricalLots(rows);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      position_id: "btc-1",
      capture_date: "2026-05-20",
      asset_key: "bitcoin",
      deltas: [{ effective_date: "2021-01-01", qty_delta: 2 }],
    });
  });

  it("excludes non-backdated positions (effective_date == capture date → empty augment range)", () => {
    const rows: ActivityForLot[] = [
      {
        entity_id: "btc-2",
        entity_type: "crypto_position",
        action: "create",
        effective_date: "2026-05-20", // same day as created_at → not backdated
        created_at: "2026-05-20T10:00:00Z",
        before_quantity: null,
        after_quantity: 1,
        asset_kind: "crypto",
        asset_key: "bitcoin",
        fetch_symbol: "BTC-USD",
        native_currency: "USD",
        asset_class: "crypto",
      },
    ];
    expect(buildHistoricalLots(rows)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts -t "buildHistoricalLots"`
Expected: FAIL — `buildHistoricalLots` not exported.

- [ ] **Step 3: Implement the pure lot-builder + the I/O functions**

Append to `src/lib/portfolio/historical-prices-augmentation.ts`. (Imports for the fetch layer + admin client go at the top of the file alongside the existing imports.)

Add at the top of the file (`pickJoinedRecord` already exists in `join-utils.ts` and is used the same way by `manual-nav-augmentation.ts:242` — reuse it, do not write a local helper):
```typescript
import { createAdminClient } from "@/lib/supabase/admin";
import { positionQtyDelta } from "@/lib/deltas";
import { pickJoinedRecord } from "@/lib/supabase/join-utils";
import {
  fetchYahooDailyHistory,
  fetchFxUsdPivotHistory,
} from "@/lib/prices/historical";
```

Append the builder + I/O:
```typescript
/** One activity-log row joined with its asset metadata, for lot building. */
export type ActivityForLot = {
  entity_id: string;
  entity_type: string; // "crypto_position" | "stock_position"
  action: string;
  effective_date: string | null;
  created_at: string;
  before_quantity: number | null;
  after_quantity: number | null;
  asset_kind: "crypto" | "stock";
  asset_key: string;       // coingecko_id | yahoo_ticker
  fetch_symbol: string;    // `${ticker}-USD` | yahoo_ticker
  native_currency: string;
  asset_class: "crypto" | "stocks";
};

/**
 * Group activity rows into HistoricalLots. Pure.
 *   - capture_date = date of the position's earliest created_at (when the cron
 *     first captured it). crypto_positions/stock_positions have no created_at
 *     column, so this comes from activity_log.
 *   - deltas = positionQtyDelta(action, before, after) per row, dated by
 *     COALESCE(effective_date, created_at-date).
 *   - A lot is kept only if backdated: earliest effective_date < capture_date.
 *     Otherwise its augment range [effective, capture) is empty (no work).
 */
export function buildHistoricalLots(rows: ActivityForLot[]): HistoricalLot[] {
  const byPos = new Map<string, ActivityForLot[]>();
  for (const r of rows) {
    if (!byPos.has(r.entity_id)) byPos.set(r.entity_id, []);
    byPos.get(r.entity_id)!.push(r);
  }

  const lots: HistoricalLot[] = [];
  for (const [positionId, group] of byPos) {
    const first = group[0];
    let captureDate = group[0].created_at.slice(0, 10);
    const deltas: QtyDelta[] = [];
    for (const r of group) {
      const day = r.created_at.slice(0, 10);
      if (day < captureDate) captureDate = day;
      const qtyDelta = positionQtyDelta(
        r.action,
        r.before_quantity ?? 0,
        r.after_quantity ?? 0,
      );
      if (qtyDelta === 0) continue;
      deltas.push({
        effective_date: r.effective_date ?? day,
        qty_delta: qtyDelta,
      });
    }
    if (deltas.length === 0) continue;

    const earliestEffective = deltas.reduce(
      (min, d) => (d.effective_date < min ? d.effective_date : min),
      deltas[0].effective_date,
    );
    if (earliestEffective >= captureDate) continue; // not backdated → skip

    lots.push({
      position_id: positionId,
      asset_kind: first.asset_kind,
      asset_key: first.asset_key,
      fetch_symbol: first.fetch_symbol,
      native_currency: first.native_currency,
      asset_class: first.asset_class,
      capture_date: captureDate,
      deltas,
    });
  }
  return lots;
}

/**
 * Ensure the cache holds prices for every lot's asset over [earliestEffective,
 * captureEnd], plus USD-pivot FX for every native currency + EUR. Fetches only
 * MISSING (asset_key) series (coarse, idempotent — re-fetch is harmless thanks
 * to the UNIQUE constraint), upserts via the service-role admin client (the
 * only role allowed to write), and returns ALL relevant cached rows. Network
 * failures degrade gracefully (the lot simply won't be in the returned set →
 * caller leaves it on the back-fill).
 */
export async function ensureHistoricalPricesCached(
  lots: HistoricalLot[],
): Promise<HistoricalPriceRow[]> {
  if (lots.length === 0) return [];
  const admin = createAdminClient();

  // Global range to fetch: earliest effective_date → latest capture_date.
  let rangeStart = lots[0].deltas[0].effective_date;
  let rangeEnd = lots[0].capture_date;
  const currencies = new Set<string>(["EUR"]); // always need EUR for the mirror
  const assetSeries = new Map<string, { kind: "crypto" | "stock"; symbol: string; currency: string }>();
  for (const lot of lots) {
    for (const d of lot.deltas) if (d.effective_date < rangeStart) rangeStart = d.effective_date;
    if (lot.capture_date > rangeEnd) rangeEnd = lot.capture_date;
    if (lot.native_currency !== "USD") currencies.add(lot.native_currency);
    assetSeries.set(`${lot.asset_kind}:${lot.asset_key}`, {
      kind: lot.asset_kind,
      symbol: lot.fetch_symbol,
      currency: lot.native_currency,
    });
  }

  // Which series already have ANY cached rows? (coverage gate, coarse).
  const { data: existing } = await admin
    .from("historical_prices")
    .select("asset_kind, asset_key");
  const cachedKeys = new Set(
    (existing ?? []).map((r) => `${r.asset_kind}:${r.asset_key}`),
  );

  const toUpsert: HistoricalPriceRow[] = [];

  // Asset price series (crypto/stock) via Yahoo.
  for (const [key, meta] of assetSeries) {
    if (cachedKeys.has(key)) continue;
    const assetKey = key.slice(key.indexOf(":") + 1);
    const points = await fetchYahooDailyHistory(meta.symbol, rangeStart, rangeEnd);
    for (const p of points) {
      toUpsert.push({
        asset_kind: meta.kind,
        asset_key: assetKey,
        price_date: p.date,
        price: p.price,
        currency: meta.currency,
      });
    }
  }

  // FX series via Frankfurter (USD-pivot).
  for (const cur of currencies) {
    if (cachedKeys.has(`fx:${cur}`)) continue;
    const points = await fetchFxUsdPivotHistory(cur, rangeStart, rangeEnd);
    for (const p of points) {
      toUpsert.push({
        asset_kind: "fx",
        asset_key: cur,
        price_date: p.date,
        price: p.price,
        currency: "USD",
      });
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await admin
      .from("historical_prices")
      .upsert(toUpsert, { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true });
    if (error) {
      // Non-fatal: log + breadcrumb, return whatever is already cached.
      console.error("[historical] cache upsert failed:", error.message);
      Sentry.captureException(new Error(`historical_prices upsert failed: ${error.message}`));
    }
  }

  // Read back every row for the assets + currencies we care about. All keys
  // live in the single asset_key column, so one .in() over the union suffices
  // (an fx code colliding with a ticker is harmless — buildPriceIndex groups by
  // asset_kind:asset_key, keeping them distinct).
  const assetKeys = [...assetSeries.keys()].map((k) => k.slice(k.indexOf(":") + 1));
  const allKeys = [...new Set([...assetKeys, ...currencies])];
  const { data: rows, error: readErr } = await admin
    .from("historical_prices")
    .select("asset_kind, asset_key, price_date, price, currency")
    .in("asset_key", allKeys);
  if (readErr) {
    console.error("[historical] cache read failed:", readErr.message);
    return [];
  }
  return (rows ?? []).map<HistoricalPriceRow>((r) => ({
    asset_kind: r.asset_kind as HistoricalPriceRow["asset_kind"],
    asset_key: r.asset_key as string,
    price_date: r.price_date as string,
    price: Number(r.price),
    currency: r.currency as string,
  }));
}

/**
 * Gather a user's backdated crypto/stock lots from the activity log + asset
 * joins, build HistoricalLots, ensure their prices are cached, and return both.
 *
 * Pass the appropriate client + userId, mirroring fetchManualNavInputsFor:
 *   - Authenticated server client + the resolved auth.uid() → RLS-scoped read.
 *   - Admin client + explicit owner userId → cross-user (share/comparison).
 * Cache writes always use the service-role admin client internally (the only
 * role allowed to write historical_prices), regardless of the read client.
 */
export async function fetchHistoricalPriceInputsFor(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ lots: HistoricalLot[]; prices: HistoricalPriceRow[] }> {
  // Backdated crypto/stock activity: is_adjustment OR effective_date set, with
  // the joined asset metadata needed to build a lot. The join shape is
  // normalized into ActivityForLot below.
  const [cryptoRes, stockRes] = await Promise.all([
    supabase
      .from("activity_log")
      .select("entity_id, action, effective_date, created_at, before_snapshot, after_snapshot")
      .eq("user_id", userId)
      .eq("entity_type", "crypto_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("activity_log")
      .select("entity_id, action, effective_date, created_at, before_snapshot, after_snapshot")
      .eq("user_id", userId)
      .eq("entity_type", "stock_position")
      .is("undone_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (cryptoRes.error) throw new Error(`Failed to load crypto activity: ${cryptoRes.error.message}`);
  if (stockRes.error) throw new Error(`Failed to load stock activity: ${stockRes.error.message}`);

  // Resolve asset metadata for the entity_ids we saw (coingecko_id / ticker /
  // yahoo_ticker / currency). Two small lookups keyed by position id.
  const cryptoMeta = await loadCryptoPositionMeta(supabase, userId);
  const stockMeta = await loadStockPositionMeta(supabase, userId);

  const activity: ActivityForLot[] = [];
  for (const r of cryptoRes.data ?? []) {
    const meta = cryptoMeta.get(r.entity_id as string);
    if (!meta) continue;
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "crypto_position",
      action: r.action as string,
      effective_date: (r.effective_date as string) ?? null,
      created_at: r.created_at as string,
      before_quantity: before?.quantity ?? null,
      after_quantity: after?.quantity ?? null,
      asset_kind: "crypto",
      asset_key: meta.coingecko_id,
      fetch_symbol: `${meta.ticker.toUpperCase()}-USD`,
      native_currency: "USD",
      asset_class: "crypto",
    });
  }
  for (const r of stockRes.data ?? []) {
    const meta = stockMeta.get(r.entity_id as string);
    if (!meta || !meta.yahoo_ticker) continue; // kind='manual' has no ticker → skip
    const before = r.before_snapshot as { quantity?: number } | null;
    const after = r.after_snapshot as { quantity?: number } | null;
    activity.push({
      entity_id: r.entity_id as string,
      entity_type: "stock_position",
      action: r.action as string,
      effective_date: (r.effective_date as string) ?? null,
      created_at: r.created_at as string,
      before_quantity: before?.quantity ?? null,
      after_quantity: after?.quantity ?? null,
      asset_kind: "stock",
      asset_key: meta.yahoo_ticker,
      fetch_symbol: meta.yahoo_ticker,
      native_currency: meta.currency ?? "USD",
      asset_class: "stocks",
    });
  }

  const lots = buildHistoricalLots(activity);

  Sentry.addBreadcrumb({
    category: "historical-prices",
    message: "Historical price inputs fetched",
    data: { backdatedLots: lots.length },
    level: lots.length > 0 ? "info" : "debug",
  });

  if (lots.length === 0) return { lots: [], prices: [] };
  const prices = await ensureHistoricalPricesCached(lots);

  // Graceful degradation: keep only lots whose asset actually has cached prices.
  const pricedKeys = new Set(prices.map((p) => `${p.asset_kind}:${p.asset_key}`));
  const pricedLots = lots.filter((l) => pricedKeys.has(`${l.asset_kind}:${l.asset_key}`));
  return { lots: pricedLots, prices };
}

/** position_id → { coingecko_id, ticker } for the user's crypto positions. */
async function loadCryptoPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { coingecko_id: string; ticker: string }>> {
  const { data, error } = await supabase
    .from("crypto_positions")
    .select("id, crypto_assets!inner(coingecko_id, ticker, user_id)")
    .eq("crypto_assets.user_id", userId)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to load crypto position meta: ${error.message}`);
  const map = new Map<string, { coingecko_id: string; ticker: string }>();
  for (const row of data ?? []) {
    const a = pickJoinedRecord<{ coingecko_id: string; ticker: string }>(row.crypto_assets);
    if (a) map.set(row.id as string, { coingecko_id: a.coingecko_id, ticker: a.ticker });
  }
  return map;
}

/** position_id → { yahoo_ticker, currency } for the user's stock positions. */
async function loadStockPositionMeta(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, { yahoo_ticker: string | null; currency: string }>> {
  const { data, error } = await supabase
    .from("stock_positions")
    .select("id, stock_assets!inner(yahoo_ticker, currency, user_id)")
    .eq("stock_assets.user_id", userId)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to load stock position meta: ${error.message}`);
  const map = new Map<string, { yahoo_ticker: string | null; currency: string }>();
  for (const row of data ?? []) {
    const a = pickJoinedRecord<{ yahoo_ticker: string | null; currency: string }>(row.stock_assets);
    if (a) map.set(row.id as string, { yahoo_ticker: a.yahoo_ticker, currency: a.currency });
  }
  return map;
}
```

- [ ] **Step 4: Run unit tests (pure builder)**

Run: `npx vitest run __tests__/unit/historical-prices-augmentation.test.ts`
Expected: PASS (all suites incl. `buildHistoricalLots`).

- [ ] **Step 5: Write the integration test for cache idempotency + RLS**

Create `__tests__/integration/historical-prices-cache.test.ts`. Mirror the setup of an existing integration test (e.g. the manual-nav or backfill integration tests) for client creation + cleanup. The assertions that matter:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAnonClient, createAuthedClient } from "../integration/setup"; // match existing helpers

const admin = createAdminClient();

afterEach(async () => {
  await admin.from("historical_prices").delete().eq("asset_key", "test-coin");
});

describe("historical_prices cache (RLS + idempotency)", () => {
  it("upsert is idempotent on (asset_kind, asset_key, price_date)", async () => {
    const row = { asset_kind: "crypto", asset_key: "test-coin", price_date: "2021-01-01", price: 100, currency: "USD" };
    await admin.from("historical_prices").upsert([row], { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true });
    await admin.from("historical_prices").upsert([{ ...row, price: 999 }], { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true });
    const { data } = await admin.from("historical_prices").select("price").eq("asset_key", "test-coin");
    expect(data).toHaveLength(1);
    expect(Number(data![0].price)).toBe(100); // first write wins (ignoreDuplicates)
  });

  it("an authenticated user can SELECT but cannot INSERT", async () => {
    await admin.from("historical_prices").upsert(
      [{ asset_kind: "crypto", asset_key: "test-coin", price_date: "2021-01-02", price: 50, currency: "USD" }],
      { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
    );
    const authed = await createAuthedClient(); // an active user
    const { data: readable } = await authed.from("historical_prices").select("*").eq("asset_key", "test-coin");
    expect((readable ?? []).length).toBeGreaterThan(0); // SELECT allowed

    const { error: writeErr } = await authed
      .from("historical_prices")
      .insert({ asset_kind: "crypto", asset_key: "test-coin", price_date: "2099-01-01", price: 1, currency: "USD" });
    expect(writeErr).not.toBeNull(); // no write policy → RLS blocks
  });

  it("anon cannot read (REVOKEd)", async () => {
    const anon = createAnonClient();
    const { data, error } = await anon.from("historical_prices").select("*").limit(1);
    expect(data ?? []).toHaveLength(0);
    expect(error === null || error !== null).toBe(true); // permission-denied or empty
  });
});
```

> **Engineer note:** match `createAuthedClient` / `createAnonClient` to whatever `__tests__/integration/setup.ts` actually exports (the memory notes `createTestUser()` uses `auth.signUp()`). Adjust import names to the real helpers; keep the three assertions (idempotency, authenticated read-but-not-write, anon blocked).

- [ ] **Step 6: Run the integration test**

Run (local Supabase must be running): `npx vitest run --project integration __tests__/integration/historical-prices-cache.test.ts`
Expected: PASS. (If "Database error" flakiness from parallel signUp, re-run — documented gotcha.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/portfolio/historical-prices-augmentation.ts __tests__/unit/historical-prices-augmentation.test.ts __tests__/integration/historical-prices-cache.test.ts
git commit -m "feat: historical-price I/O (buildHistoricalLots, ensureHistoricalPricesCached, fetchHistoricalPriceInputsFor)"
```

---

## Task 7: Back-fill exclusion — third set in `getAdjustmentDeltas`

**Files:**
- Modify: `src/lib/actions/activity-log.ts` (`getAdjustmentDeltas`, lines 441-583)
- Test: `__tests__/integration/` (extend an existing back-fill test, or add one)

A crypto/stock lot whose asset has cached historical prices is now valued by synthesis → it must be excluded from the flat back-fill, exactly as `manualStockPosIds` excludes manual NAV positions. Consistent-by-construction with the augmentation gate (both ask "does this asset have cached prices?").

- [ ] **Step 1: Add the historically-priced position-id fetch**

In `src/lib/actions/activity-log.ts`, locate the parallel fetch at lines 469-488 (the `stablecoinRes` / `manualStockPosRes` block). Extend it to also gather the historically-priced position ids. Replace the `Promise.all([...])` and the two `Set` constructions with:

```typescript
  // Also gather crypto/stock positions whose asset has cached historical
  // prices. Those lots are now valued by augmentAndExtendSnapshots
  // (qty × historical-price), so including their is_adjustment entries in the
  // flat back-fill `value + (finalCumDelta - cumDelta)` would double-count and
  // project today's value onto pre-purchase dates. Consistent-by-construction
  // with the augmentation gate in getSnapshots: both key off "asset has cached
  // historical prices". A lot with no cached prices stays on the back-fill.
  const [stablecoinRes, manualStockPosRes, histPricesRes] = await Promise.all([
    supabase
      .from("crypto_positions")
      .select("id, crypto_assets!inner(subcategory)")
      .ilike("crypto_assets.subcategory", "stablecoin")
      .eq("crypto_assets.user_id", resolvedUserId),
    supabase
      .from("stock_positions")
      .select("id, stock_assets!inner(kind, user_id)")
      .eq("stock_assets.user_id", resolvedUserId)
      .eq("stock_assets.kind", "manual"),
    supabase
      .from("historical_prices")
      .select("asset_kind, asset_key"),
  ]);
  if (stablecoinRes.error) throw new Error(`Failed to load stablecoin positions: ${stablecoinRes.error.message}`);
  if (manualStockPosRes.error) throw new Error(`Failed to load manual stock positions: ${manualStockPosRes.error.message}`);
  if (histPricesRes.error) throw new Error(`Failed to load historical price coverage: ${histPricesRes.error.message}`);
  const stablecoinPosIds = new Set(
    (stablecoinRes.data ?? []).map((p) => p.id as string)
  );
  const manualStockPosIds = new Set(
    (manualStockPosRes.data ?? []).map((p) => p.id as string)
  );

  // asset_keys (coingecko_id / yahoo_ticker) that have any cached history.
  const histCryptoKeys = new Set<string>();
  const histStockKeys = new Set<string>();
  for (const r of histPricesRes.data ?? []) {
    if (r.asset_kind === "crypto") histCryptoKeys.add(r.asset_key as string);
    else if (r.asset_kind === "stock") histStockKeys.add(r.asset_key as string);
  }

  // Resolve which of the user's positions map to those covered asset_keys.
  const historicallyPricedPosIds = new Set<string>();
  if (histCryptoKeys.size > 0) {
    const { data: cp } = await supabase
      .from("crypto_positions")
      .select("id, crypto_assets!inner(coingecko_id, user_id)")
      .eq("crypto_assets.user_id", resolvedUserId);
    for (const row of cp ?? []) {
      const cg = (Array.isArray(row.crypto_assets) ? row.crypto_assets[0] : row.crypto_assets) as { coingecko_id?: string } | null;
      if (cg?.coingecko_id && histCryptoKeys.has(cg.coingecko_id)) {
        historicallyPricedPosIds.add(row.id as string);
      }
    }
  }
  if (histStockKeys.size > 0) {
    const { data: sp } = await supabase
      .from("stock_positions")
      .select("id, stock_assets!inner(yahoo_ticker, user_id)")
      .eq("stock_assets.user_id", resolvedUserId);
    for (const row of sp ?? []) {
      const sa = (Array.isArray(row.stock_assets) ? row.stock_assets[0] : row.stock_assets) as { yahoo_ticker?: string | null } | null;
      if (sa?.yahoo_ticker && histStockKeys.has(sa.yahoo_ticker)) {
        historicallyPricedPosIds.add(row.id as string);
      }
    }
  }
```

- [ ] **Step 2: Skip historically-priced positions in the accumulation loop**

In the `for (const row of sorted)` loop (starts at line 539), directly after the existing `manualStockPosIds` skip block (lines 545-551), add:

```typescript
    // Skip crypto/stock positions valued by historical-price synthesis — they
    // contribute to snapshots via augmentAndExtendSnapshots, not the back-fill.
    if (
      (row.entity_type === "crypto_position" || row.entity_type === "stock_position") &&
      typeof row.entity_id === "string" &&
      historicallyPricedPosIds.has(row.entity_id)
    ) {
      continue;
    }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Add a regression test (extend existing back-fill coverage)**

Find the existing test exercising `getAdjustmentDeltas` (search: `grep -rln "getAdjustmentDeltas" __tests__/`). Add a case proving a position whose `coingecko_id` has rows in `historical_prices` is **absent** from the returned cumulative deltas, while one without cached prices is **present** (graceful degradation). If there is no integration test for it, add one in `__tests__/integration/` seeding: a backdated crypto adjustment entry + a `historical_prices` row for its coin → assert that coin's delta is excluded.

Run: `npx vitest run --project integration -t "getAdjustmentDeltas"` (or the file you extended)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/activity-log.ts __tests__/
git commit -m "feat: exclude historically-priced lots from getAdjustmentDeltas back-fill"
```

---

## Task 8: Thread into the two real augmentation sites

**Files:**
- Modify: `src/lib/actions/snapshots.ts` (`getSnapshots`, lines 133-167)
- Modify: `src/lib/actions/shared-portfolio.ts` (lines 218-226)

Call `fetchHistoricalPriceInputsFor` + `augmentAndExtendSnapshots` at the same point `augmentSnapshotsWithManualNavs` already runs. (`comparison.ts` inherits via `getSnapshots`/`getSharedPortfolio`; `assemble.ts` is the live path and needs no change.)

- [ ] **Step 1: Update `getSnapshots`**

In `src/lib/actions/snapshots.ts`, extend the import at lines 11-14:

```typescript
import {
  augmentSnapshotsWithManualNavs,
  fetchManualNavInputsFor,
} from "@/lib/portfolio/manual-nav-augmentation";
import {
  fetchHistoricalPriceInputsFor,
  augmentAndExtendSnapshots,
} from "@/lib/portfolio/historical-prices-augmentation";
```

Replace the parallel fetch + return (lines 149-166) so the historical inputs are fetched alongside, and applied after the manual-NAV augmentation:

```typescript
  const [snapshotsRes, manualInputs, historicalInputs] = await Promise.all([
    supabase
      .from("portfolio_snapshots")
      .select("*")
      .eq("user_id", user.id)
      .gte("snapshot_date", sinceStr)
      .order("snapshot_date", { ascending: true })
      .limit(MAX_SNAPSHOTS_LIMIT),
    fetchManualNavInputsFor(supabase, user.id),
    fetchHistoricalPriceInputsFor(supabase, user.id),
  ]);

  if (snapshotsRes.error) {
    console.error("[snapshots] Failed to fetch snapshots:", snapshotsRes.error.message);
    throw new Error(`Failed to load portfolio history: ${snapshotsRes.error.message}`);
  }

  const raw = (snapshotsRes.data ?? []).map<PortfolioSnapshot>(normalizeSnapshot);
  const withManual = augmentSnapshotsWithManualNavs(raw, manualInputs.positions, manualInputs.navs);
  return augmentAndExtendSnapshots(withManual, historicalInputs.lots, historicalInputs.prices);
```

> **Why fetch the FULL window, not just `days`:** `getSnapshots(days)` filters `snapshot_date >= sinceStr`. The synthesis prepends rows *earlier* than `sinceStr`, so a 30-day request would still gain pre-30-day synthesized rows. That is correct and desired — the chart's selected range is applied downstream by the chart component, and period cards call `findSnapshotAt` which binary-searches the full returned array. No change needed to the `gte` filter; the synthesized rows simply extend the array's lower bound. (If a future requirement needs to *cap* synthesis to the requested window, pass `sinceStr` into `augmentAndExtendSnapshots` — not needed for Phase 1.)

- [ ] **Step 2: Update `getSharedPortfolio`**

In `src/lib/actions/shared-portfolio.ts`, extend the import at lines 24-25 (same module as manual-nav):

```typescript
import {
  augmentSnapshotsWithManualNavs,
  fetchManualNavInputsFor,
} from "@/lib/portfolio/manual-nav-augmentation";
import {
  fetchHistoricalPriceInputsFor,
  augmentAndExtendSnapshots,
} from "@/lib/portfolio/historical-prices-augmentation";
```

Replace the augmentation block (lines 223-226) — note this path uses the `admin` client + explicit `userId` (viewer ≠ owner):

```typescript
  const manualInputs = await fetchManualNavInputsFor(admin, userId);
  const historicalInputs = await fetchHistoricalPriceInputsFor(admin, userId);
  const withManual = manualInputs.positions.length > 0
    ? augmentSnapshotsWithManualNavs(snapshots, manualInputs.positions, manualInputs.navs)
    : snapshots;
  const augmentedSnapshots = augmentAndExtendSnapshots(
    withManual,
    historicalInputs.lots,
    historicalInputs.prices,
  );
```

(The rest of the function already consumes `augmentedSnapshots` via `findSnapshotAt` — no further change.)

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the full unit + component + integration suite**

Run: `npm test && npm run test:component`
Expected: all green.
Run (local Supabase up): `npx vitest run --project integration`
Expected: all green (re-run on transient signUp "Database error").

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/snapshots.ts src/lib/actions/shared-portfolio.ts
git commit -m "feat: thread historical-price extension into getSnapshots + getSharedPortfolio"
```

---

## Task 9: End-to-end verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Full automated gate**

Run:
```bash
npm run lint && npm run typecheck && npm run build && npm test && npm run test:component
```
Expected: all pass. With local Supabase: `npm run test:integration` also green.

- [ ] **Step 2: Manual smoke against local dev**

Run `npm run dev`, sign in as a test user, and:
1. Add a crypto position (e.g. BTC) with an `effective_date` ~2 years back and a sizable quantity (backdated lot).
2. Load the dashboard chart with the "1Y" / "All" range.

Expected:
- The chart line **extends back to the purchase date** and follows the real BTC price curve (not a flat line at today's value).
- The line shows **$0 contribution before** the purchase date (the invariant — verify the synthesized series starts exactly at `effective_date`).
- Period-change cards (7d/30d/1y) reflect the lot's real appreciation, not a flat back-fill.
- No console errors; the S&P line still starts at the first real snapshot (Phase 2 will extend it — interim state, expected on the feature branch).

- [ ] **Step 3: Verify graceful degradation**

Temporarily simulate a fetch failure (e.g. disconnect network or point the Yahoo URL at an unreachable host in a scratch run) and confirm: the backdated lot falls back to the **flat back-fill** (no crash, no blank chart). Restore.

- [ ] **Step 4: Update memory + spec status**

Update `~/.claude/projects/-Users-lxp-simple-portfolio-tracker/memory/chart-correctness-architecture.md`: mark Phase 1 implemented, note the `capture_date` double-count guard and crypto/stock-only scope. Add a one-liner to the spec's status. (Migration count moves to 20 — update CLAUDE.md's DB row + migration list.)

- [ ] **Step 5: Commit the docs/memory updates**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-05-27-historical-prices-augmentation-design.md
git commit -m "docs: mark historical-prices Phase 1 complete; migration count → 20"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** historical_prices table (Task 1) ✓; pure synthesis at PortfolioSnapshot level (Tasks 2-4) ✓; augment AND synthesize across `[effective, capture)` and `[earliest, first-snapshot)` (Task 4) ✓; $0-before-purchase invariant (Task 3 dedicated test + Task 4) ✓; Yahoo crypto/stock + Frankfurter FX with explicit period1/period2 (Task 5) ✓; lazy fetch-on-read + graceful degradation (Task 6) ✓; back-fill third exclusion set (Task 7) ✓; threading into the real augmentation sites (Task 8) ✓; daily granularity ✓. **Resolved Open Question 1** (RLS/grants): RLS-on + authenticated SELECT policy + anon REVOKE + service-role writes (Task 1). **Open Question 3** (concurrency under 10s): mitigated — `ensureHistoricalPricesCached` fetches each asset series at most once (1-3 calls), cached forever; if first-load latency proves real with many simultaneous first-fetches, add a concurrency cap later (deferred, not needed for the single-user app).
- **Scope correction vs spec:** cash/stablecoin synthesis deferred (back-fill exact); 2 integration sites not 4; `capture_date` guard added. All documented in "Planning Refinements".
- **Type consistency:** `HistoricalPriceRow`, `QtyDelta`, `HistoricalLot`, `ActivityForLot` are defined once (Tasks 2/3/6) and reused verbatim; `augmentAndExtendSnapshots(snapshots, lots, prices)` signature is stable across Tasks 4, 6, 8; `lotContributionAtDate(lot, date, priceIndex, fxIndex)` stable across Tasks 3-4.
- **Placeholder scan:** no TBD/"add error handling"/"similar to Task N". Tests carry real assertions; integration-test helper names flagged for the engineer to match against the real `setup.ts`.
