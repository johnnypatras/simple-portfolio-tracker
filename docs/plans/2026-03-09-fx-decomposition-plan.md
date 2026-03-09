# FX Decomposition Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix overattributed FX in per-class change tooltips (7d/30d/1y) for mixed-currency asset classes.

**Architecture:** Add 5 snapshot columns (per-class EUR + home-currency subtotals), compute them in aggregate/snapshot/Edge Function, use FX-sensitive fraction in `deriveClassFx()`. One-time backfill script for historical snapshots using activity_log replay + Yahoo historical prices.

**Tech Stack:** Supabase PostgreSQL, TypeScript, Yahoo Finance v8 chart API, Next.js server actions.

**Design doc:** `docs/plans/2026-03-09-fx-decomposition-design.md`

---

### Task 1: Migration — Add snapshot columns

**Files:**
- Create: `supabase/migrations/050_fx_decomposition_columns.sql`

**Step 1: Write the migration**

```sql
-- Per-class EUR values (computed from class_usd × implied EUR/USD rate)
ALTER TABLE portfolio_snapshots ADD COLUMN crypto_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_value_eur   NUMERIC(20,2);

-- Home-currency (EUR) denominated subtotals per class
-- These track the EUR value of positions denominated in the user's home currency (EUR).
-- Positions in home currency have zero FX sensitivity.
-- crypto has no EUR-denominated positions (all USD-priced via CoinGecko), so no column needed.
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_eur_denominated_value NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_eur_denominated_value   NUMERIC(20,2);

-- Backfill *_value_eur from existing USD values using portfolio's implied EUR/USD rate.
-- This is mathematically exact: the ratio total_eur/total_usd IS the EUR/USD rate
-- used when the snapshot was created.
UPDATE portfolio_snapshots
SET crypto_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(crypto_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END,
    stocks_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(stocks_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END,
    cash_value_eur = CASE
      WHEN total_value_usd > 0
      THEN ROUND(cash_value_usd * (total_value_eur / total_value_usd), 2)
      ELSE 0
    END
WHERE total_value_usd > 0;
```

Note: `stocks_eur_denominated_value` and `cash_eur_denominated_value` are left NULL — backfilled by the one-time script in Task 6.

**Step 2: Apply migration**

```bash
supabase db push
```

**Step 3: Commit**

```
feat: add per-class EUR and home-currency snapshot columns (migration 050)
```

---

### Task 2: Update TypeScript types

**Files:**
- Modify: `src/lib/types.ts:267-277` (PortfolioSnapshot interface)

**Step 1: Add new fields to PortfolioSnapshot**

Add after `cash_value_usd`:

```typescript
export interface PortfolioSnapshot {
  id: string;
  user_id: string;
  snapshot_date: string;
  total_value_usd: number;
  total_value_eur: number;
  crypto_value_usd: number;
  stocks_value_usd: number;
  cash_value_usd: number;
  crypto_value_eur: number | null;
  stocks_value_eur: number | null;
  cash_value_eur: number | null;
  stocks_eur_denominated_value: number | null;
  cash_eur_denominated_value: number | null;
  created_at: string;
}
```

All nullable — old snapshots before migration may have NULL until backfill runs.

**Step 2: Build to verify no type errors**

```bash
npm run build
```

There WILL be type errors in snapshots.ts and dashboard-grid.tsx — that's expected, they'll be fixed in subsequent tasks.

**Step 3: Commit**

```
feat: add per-class EUR fields to PortfolioSnapshot type
```

---

### Task 3: Update aggregate to compute home-currency subtotals

**Files:**
- Modify: `src/lib/portfolio/aggregate.ts:20-65` (PortfolioSummary interface)
- Modify: `src/lib/portfolio/aggregate.ts:263-312` (computation loops)
- Modify: `src/lib/portfolio/aggregate.ts:314-345` (return object)

**Step 1: Add fields to PortfolioSummary**

In the interface (after `cashValueEur: number;`), add:

```typescript
// EUR value of positions denominated in the user's home currency (zero FX sensitivity)
stocksHomeCurrencyEur: number;
cashHomeCurrencyEur: number;
```

**Step 2: Accumulate in computation loops**

In the `if (fxRatesUsd && fxRatesEur)` block (~line 270), add counters:

```typescript
let stocksHomeCurrencyEur = 0;
let cashHomeCurrencyEur = 0;
```

Inside the stock loop (~line 273), after `stocksValueEur +=`:

```typescript
if (asset.currency === primaryCurrency) {
  stocksHomeCurrencyEur += convertToBase(valueNative, asset.currency, "EUR", fxRatesEur);
}
```

Inside each cash loop (banks ~282, exchange deposits ~286, broker deposits ~290), after `fiatCashValueEur +=`:

```typescript
if (bank.currency === primaryCurrency) {  // or deposit.currency
  cashHomeCurrencyEur += convertToBase(bank.balance, bank.currency, "EUR", fxRatesEur);
}
```

Note: stablecoins are always USD — never home currency for a EUR user.

Also add a legacy fallback in the `else` block (~line 294): set both to 0 or estimate from `primaryCurrency`.

**Step 3: Add to return object**

In the return (~line 314), add:

```typescript
stocksHomeCurrencyEur,
cashHomeCurrencyEur,
```

**Step 4: Build to verify**

```bash
npm run build
```

**Step 5: Commit**

```
feat: compute home-currency subtotals in aggregate
```

---

### Task 4: Update saveSnapshot and dashboard page

**Files:**
- Modify: `src/lib/actions/snapshots.ts:22-82` (saveSnapshot function signature + upsert)
- Modify: `src/app/dashboard/page.tsx:154-159` (saveSnapshot caller)

**Step 1: Extend saveSnapshot signature**

Add new params to the `values` object in `saveSnapshot()`:

```typescript
export async function saveSnapshot(values: {
  totalValueUsd: number;
  totalValueEur: number;
  cryptoValueUsd: number;
  stocksValueUsd: number;
  cashValueUsd: number;
  cryptoValueEur: number;
  stocksValueEur: number;
  cashValueEur: number;
  stocksHomeCurrencyEur: number;
  cashHomeCurrencyEur: number;
}): Promise<void> {
```

Add rounding for new values (after existing `round2` calls):

```typescript
const cryptoEur = round2(values.cryptoValueEur);
const stocksEur = round2(values.stocksValueEur);
const cashEur = round2(values.cashValueEur);
const stocksHomeCurEur = round2(values.stocksHomeCurrencyEur);
const cashHomeCurEur = round2(values.cashHomeCurrencyEur);
```

Add to the upsert object:

```typescript
crypto_value_eur: cryptoEur,
stocks_value_eur: stocksEur,
cash_value_eur: cashEur,
stocks_eur_denominated_value: stocksHomeCurEur,
cash_eur_denominated_value: cashHomeCurEur,
```

**Step 2: Update dashboard page caller**

In `src/app/dashboard/page.tsx:154-159`, add new fields from summary:

```typescript
saveSnapshot({
  totalValueUsd: summary.totalValueUsd,
  totalValueEur: summary.totalValueEur,
  cryptoValueUsd: summary.cryptoValueUsd,
  stocksValueUsd: summary.stocksValueUsd,
  cashValueUsd: summary.cashValueUsd,
  cryptoValueEur: summary.cryptoValueEur,
  stocksValueEur: summary.stocksValueEur,
  cashValueEur: summary.cashValueEur,
  stocksHomeCurrencyEur: summary.stocksHomeCurrencyEur,
  cashHomeCurrencyEur: summary.cashHomeCurrencyEur,
});
```

**Step 3: Build**

```bash
npm run build
```

**Step 4: Commit**

```
feat: write per-class EUR and home-currency values to snapshots
```

---

### Task 5: Update Edge Function

**Files:**
- Modify: `supabase/functions/daily-snapshot/index.ts:190-261`

**Step 1: Add counters in the per-user loop**

After `let fiatCashValueEur = 0;` (~line 232), add:

```typescript
let stocksHomeCurrencyEur = 0;
let cashHomeCurrencyEur = 0;
```

Inside the stock loop (~line 222), after `stocksValueEur +=`:

```typescript
if (quote.currency === "EUR") {
  stocksHomeCurrencyEur += convertToBase(valueNative, quote.currency, "EUR", fxEur);
}
```

Inside the cash loop (~line 233), after `fiatCashValueEur +=`:

```typescript
if (item.currency === "EUR") {
  cashHomeCurrencyEur += convertToBase(item.amount, item.currency, "EUR", fxEur);
}
```

**Step 2: Update snapshot type and push object**

Update the type definition (~line 190) to include the new columns.

Update the push object (~line 253):

```typescript
snapshots.push({
  user_id: userId,
  snapshot_date: today,
  total_value_usd: round2(totalValueUsd),
  total_value_eur: round2(totalValueEur),
  crypto_value_usd: round2(cryptoValueUsd),
  stocks_value_usd: round2(stocksValueUsd),
  cash_value_usd: round2(cashValueUsd),
  crypto_value_eur: round2(cryptoValueEur),
  stocks_value_eur: round2(stocksValueEur),
  cash_value_eur: round2(fiatCashValueEur + stablecoinValueEur),
  stocks_eur_denominated_value: round2(stocksHomeCurrencyEur),
  cash_eur_denominated_value: round2(cashHomeCurrencyEur),
});
```

**Step 3: Deploy**

```bash
supabase functions deploy daily-snapshot
```

**Step 4: Commit**

```
feat: write per-class EUR values in daily-snapshot Edge Function
```

---

### Task 6: One-time backfill script

**Files:**
- Create: `scripts/backfill-eur-denominated.ts` (deleted after use)

This is a standalone Node.js script (run with `npx tsx`) that:

1. Fetches all snapshot dates with non-null `total_value_usd > 0`
2. For `cash_eur_denominated_value`: reconstructs EUR bank/deposit balances at each date from activity_log
3. For `stocks_eur_denominated_value`: fetches Yahoo v8 chart historical prices for EUR-traded tickers, reconstructs stock quantities from activity_log, computes `SUM(qty × price)`
4. UPDATEs each snapshot

**Step 1: Write the script**

Key approach for historical reconstruction:

```typescript
// For each entity (bank_account, exchange_deposit, broker_deposit, stock_position),
// the value at date D is determined by the most recent activity_log entry where
// created_at <= D. The after_snapshot JSONB stores the state after that change.
//
// For entities that existed before activity_log was introduced,
// the "created" entry's after_snapshot has the initial value.
//
// If no activity_log entry exists before date D for an entity, it didn't exist yet.

async function getEntityValueAtDate(
  supabase: SupabaseClient,
  entityId: string,
  entityType: string,
  field: string, // "balance" for bank_accounts, "amount" for deposits, "quantity" for positions
  date: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("activity_log")
    .select("after_snapshot")
    .eq("entity_id", entityId)
    .eq("entity_type", entityType)
    .lte("created_at", date + "T23:59:59Z")
    .is("undone_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.after_snapshot) return null;
  const val = parseFloat(data.after_snapshot[field]);
  return isNaN(val) ? null : val;
}
```

For Yahoo historical prices:

```typescript
// Yahoo v8 chart API — same as used by src/lib/prices/yahoo.ts
// GET https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=3mo&interval=1d
// Returns daily OHLC with timestamps. Use regularMarketPrice (close) for each date.

async function fetchYahooHistory(ticker: string): Promise<Map<string, number>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=3mo&interval=1d`;
  const res = await fetch(url);
  const json = await res.json();
  const result = json.chart.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const map = new Map<string, number>();
  for (let i = 0; i < timestamps.length; i++) {
    const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
    if (closes[i] != null) map.set(date, closes[i]);
  }
  return map;
}
```

Main loop:

```typescript
// 1. Fetch all snapshot dates
// 2. Fetch EUR bank_accounts, exchange_deposits, broker_deposits (currency = 'EUR')
// 3. Fetch EUR stock_assets + their positions
// 4. Fetch Yahoo prices for EUR stock tickers
// 5. For each snapshot date:
//    a. Reconstruct EUR cash balances → sum → cash_eur_denominated_value
//    b. Reconstruct EUR stock quantities × Yahoo close price → sum → stocks_eur_denominated_value
//    c. UPDATE portfolio_snapshots SET ... WHERE snapshot_date = D AND user_id = U
```

The script uses the Supabase admin client (service role key) from `.env.local`.

**Step 2: Run the script**

```bash
npx tsx scripts/backfill-eur-denominated.ts
```

Verify by querying:

```sql
SELECT snapshot_date, cash_eur_denominated_value, stocks_eur_denominated_value
FROM portfolio_snapshots WHERE total_value_usd > 0 ORDER BY snapshot_date;
```

**Step 3: Commit (script included for audit trail, can delete later)**

```
chore: one-time backfill for EUR-denominated snapshot values
```

---

### Task 7: Fix deriveClassFx in dashboard-grid

**Files:**
- Modify: `src/components/dashboard/dashboard-grid.tsx:192-278` (deriveClassFx + 3 per-class functions)

**Step 1: Update deriveClassFx signature**

```typescript
function deriveClassFx(
  currentClassValue: number,
  currentClassUsd: number,
  currentClassEur: number,
  pastClassUsd: number,
  snapshot: PortfolioSnapshot,
  // New: home-currency portions for accurate FX attribution
  currentHomeCurrencyEur?: number,
  pastHomeCurrencyEur?: number | null,
): { fxPct: number; fxAbs: number; pastClassEur: number } {
```

**Step 2: Use snapshot EUR values when available**

Replace the `pastClassEur` estimation:

```typescript
// Use exact past EUR from snapshot if available, else estimate via implied rate
const snapTotalUsd = snapshot.total_value_usd ?? 0;
const snapTotalEur = snapshot.total_value_eur ?? 0;
if (snapTotalUsd === 0 || snapTotalEur === 0 || pastClassUsd === 0)
  return { fxPct: 0, fxAbs: 0, pastClassEur: 0 };

const impliedRate = snapTotalEur / snapTotalUsd;
const pastClassEur = pastClassUsd * impliedRate;
```

(This part stays the same — the implied rate is exact.)

**Step 3: Adjust fxAbs for FX-sensitive fraction**

After computing `fxAbs` from the full value, adjust:

```typescript
// Adjust fxAbs: only apply FX to the foreign-currency (non-home) portion
if (currentHomeCurrencyEur != null && pastHomeCurrencyEur != null
    && currentClassEur > 0 && pastClassEur > 0) {
  const currentFxFraction = 1 - (currentHomeCurrencyEur / currentClassEur);
  const pastFxFraction = 1 - (pastHomeCurrencyEur / pastClassEur);
  // Average of past and present fractions handles mix changes over the period
  const avgFxFraction = (currentFxFraction + pastFxFraction) / 2;
  fxAbs = fxAbs * Math.max(0, Math.min(1, avgFxFraction));
}
```

**Step 4: Pass new params from each per-class function**

For `getCryptoChangeForPeriod`: no change needed (crypto is 100% FX-sensitive, no home currency).

For `getStockChangeForPeriod`:

```typescript
const { fxPct, fxAbs, pastClassEur } = deriveClassFx(
  stocksValue, stocksValueUsd, stocksValueEur, pastUsd, snapshot,
  summary.stocksHomeCurrencyEur,
  snapshot.stocks_eur_denominated_value,
);
```

For `getCashChangeForPeriod`:

```typescript
const { fxPct, fxAbs, pastClassEur } = deriveClassFx(
  cashValue, cashValueUsd, cashValueEur, pastUsd, snapshot,
  summary.cashHomeCurrencyEur,
  snapshot.cash_eur_denominated_value,
);
```

**Step 5: Build and test**

```bash
npm run build && npm test
```

**Step 6: Commit**

```
fix: use FX-sensitive fraction for accurate per-class Prices/FX decomposition
```

---

### Task 8: Update CLAUDE.md and verify

**Files:**
- Modify: `CLAUDE.md` (migration count 49 → 50)
- Modify: `src/lib/types.ts` (if not already updated)

**Step 1: Update CLAUDE.md migration count**

Change `49 migrations` to `50 migrations`.

**Step 2: Full verification**

```bash
npm run build && npm run lint && npm test
```

**Step 3: Visual verification in browser**

- Open dashboard, hover Banks & Deposits tooltip (7d)
- Confirm "Prices" is ~-€60 (not -€270)
- Confirm "EUR/USD" is ~€518 (not €728)
- Check Equities tooltip — FX should be reduced (not applied to EUR ETFs)
- Check Crypto tooltip — should be unchanged (100% USD)
- Check 24h period — should be unchanged (already per-position)
- Check Total portfolio — should be unchanged

**Step 4: Commit**

```
docs: update migration count for fx decomposition columns
```
