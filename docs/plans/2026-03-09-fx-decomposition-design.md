# Design: Accurate Per-Class FX Decomposition

## Problem

The Prices/FX split in per-class change tooltips (7d/30d/1y) overattributes FX impact for mixed-currency classes. `deriveClassFx()` computes a blended FX% and applies it to the full class value, but EUR-denominated positions have zero FX sensitivity. This inflates "EUR/USD" and deflates "Prices".

**Concrete example (Cash 7d)**: Tooltip shows Prices -€270, EUR/USD +€728. Actual stablecoin drift ~-€60, actual FX ~€518. The €210 excess FX gets subtracted from Prices.

**Affected classes**:
- Cash: ~50% EUR / ~50% USD stablecoins — severe (2x overattribution)
- Stocks: ~75% USD / ~25% EUR-traded — moderate
- Crypto: 100% USD-priced — no issue
- Total portfolio: uses `total_value_eur` directly — no issue
- 24h period: uses per-position `fxChangeForCurrency()` — no issue (already correct)

## Solution

### New snapshot columns (migration 050)

```sql
-- Per-class EUR values (exact, enables direct pastClassEur without estimation)
ALTER TABLE portfolio_snapshots ADD COLUMN crypto_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_value_eur NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_value_eur   NUMERIC(20,2);

-- Home-currency subtotals: EUR value of EUR-denominated positions only
-- Used to compute FX-sensitive fraction per class
ALTER TABLE portfolio_snapshots ADD COLUMN stocks_eur_denominated_value NUMERIC(20,2);
ALTER TABLE portfolio_snapshots ADD COLUMN cash_eur_denominated_value   NUMERIC(20,2);
```

No `crypto_eur_denominated_value` — crypto is 100% USD-priced (always 0).

### Backfill strategy

| Column | Method | Accuracy |
|--------|--------|----------|
| `*_value_eur` | SQL: `*_value_usd × (total_value_eur / total_value_usd)` | 100% (implied rate = actual EUR/USD) |
| `cash_eur_denominated_value` | One-time script: replay activity_log balances at each snapshot date | 100% |
| `stocks_eur_denominated_value` | One-time script: Yahoo historical prices × activity_log quantities | 100% |

**Backfill scope**: 20 distinct snapshot dates (Feb 18 → Mar 9), 11 EUR stock tickers, ~14 EUR cash positions.

### Aggregate changes (`aggregate.ts`)

Add to `PortfolioSummary`:
```typescript
stocksEurDenominatedEur: number;  // EUR value of EUR-traded stocks
cashEurDenominatedEur: number;    // EUR value of EUR-denominated cash
```

Computed in existing per-position loops — accumulate positions where `currency === primaryCurrency` (generalized, not hardcoded to EUR).

### Snapshot writes

`saveSnapshot()` and Edge Function `daily-snapshot` write all 5 new columns from the aggregate.

### Dashboard FX fix (`deriveClassFx`)

New signature adds `pastHomeCurrencyEur` and `currentHomeCurrencyEur`:

```typescript
// FX-sensitive portion = class value minus home-currency positions
const pastFxSensitiveEur = pastClassEur - (pastHomeCurrencyEur ?? 0);
const currentFxSensitiveEur = currentClassEur - (currentHomeCurrencyEur ?? 0);

// Average fraction handles mix changes over the period
const avgFxFraction = (pastClassEur > 0 && currentClassEur > 0)
  ? ((pastFxSensitiveEur / pastClassEur) + (currentFxSensitiveEur / currentClassEur)) / 2
  : 1;

// Apply FX only to the FX-sensitive portion
fxAbs = fullFxAbs * avgFxFraction;
```

For old snapshots without the new columns: falls back to `avgFxFraction = 1` (current behavior).

## Files touched

| File | Change |
|------|--------|
| `supabase/migrations/050_*.sql` | Add 5 columns, backfill `*_value_eur` |
| `src/lib/types.ts` | Update `PortfolioSnapshot` interface |
| `src/lib/portfolio/aggregate.ts` | Add `stocksEurDenominatedEur`, `cashEurDenominatedEur` |
| `src/lib/actions/snapshot.ts` | Write new columns in `saveSnapshot()` |
| `supabase/functions/daily-snapshot/` | Write new columns |
| `src/components/dashboard/dashboard-grid.tsx` | Fix `deriveClassFx()` |
| `src/app/share/[token]/page.tsx` | Pass new summary fields if needed |
| One-time backfill script (deleted after use) | Yahoo prices + activity_log replay |

## Expected results

- Cash "Prices": -€270 → ~-€60 (actual stablecoin drift)
- Cash "EUR/USD": +€728 → ~€518 (only USD portion)
- Stocks: FX no longer applied to EUR-traded ETFs
- Total and 24h: unchanged (already correct)
- Old snapshots without new columns: graceful fallback to current behavior
