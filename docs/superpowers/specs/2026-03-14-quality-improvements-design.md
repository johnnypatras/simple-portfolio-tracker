# Quality Improvements — B+ to A-

## Goal

Five targeted improvements to push the app's quality ratings from B/B+ toward A- across monitoring, testing, error handling, financial calculations, and data integrity.

## Scope

| # | Improvement | Dimension | Before → After |
|---|------------|-----------|----------------|
| 1 | Stale snapshot dashboard banner | Monitoring | B- → B+ |
| 2 | Integration tests (cashflow write, transfer rollback, FX failure) | Test Coverage | B+ → A- |
| 3 | Retry button for pending/failed activity rows | Error Handling | B+ → A- |
| 4 | Stale FX rate indicator | Financial Calculations | B+ → A- |
| 5 | Import replace pre-backup | Data Integrity | B+ → A- |

---

## 1. Stale Snapshot Dashboard Banner

### Problem

The daily cron (`pg_cron` → Edge Function `daily-snapshot`) can fail silently. The `/api/health` endpoint detects stale snapshots (>26h) but no one proactively checks it. Users see potentially outdated portfolio values with no warning.

### Solution

Query latest snapshot age on dashboard server render. Show amber banner when >26h old.

### Implementation

**Dashboard server component** (`src/app/dashboard/page.tsx`):
- Add a query to the existing `Promise.all`: fetch latest `portfolio_snapshots.snapshot_date` for the user, compute age in hours.
- Pass `snapshotStaleHours: number | null` to a new `<StaleSnapshotBanner>` component.

**New component** (`src/components/dashboard/stale-snapshot-banner.tsx`):
```tsx
interface StaleSnapshotBannerProps {
  staleHours: number | null;
}
```
- Returns `null` when `staleHours` is null or ≤26.
- Amber banner with `Clock` icon: "{X} hours since last portfolio snapshot — daily update may have failed."
- Same styling as `ChartWarningBanner` (amber-500/10, text-amber-400, text-xs).

**Render location**: Inside `PortfolioChart` — add `snapshotStaleHours?: number` prop, render `<StaleSnapshotBanner>` before `<ChartWarningBanner>`. Only `dashboard/page.tsx` passes this prop.

### Threshold

26 hours (same as `/api/health`). The cron runs at 23:59 UTC. A 26h threshold allows for ~2h of execution delay before flagging.

### Testing

Component test: renders nothing at null/≤26h, renders amber banner at 27h+, shows correct hour count.

---

## 2. Integration Tests — Cashflow Write Path, Transfer Rollback, FX Failure

### Problem

29 integration tests cover core flows but miss: cashflow write-time computation, transfer compensation rollback, and FX failure status tracking — all critical paths added or modified recently.

### New test files

**`__tests__/integration/cashflow-write.test.ts`** (~6 cases):

| Case | What it verifies |
|------|-----------------|
| Create crypto position | `cashflow_amount_usd` non-null, `cashflow_status = 'complete'` on activity_log |
| Create cash deposit (EUR) | EUR→USD conversion via `toUsdAndEur`, both amounts stored |
| Create with `isAdjustment: true` | `cashflow_status IS NULL`, `delta_status = 'complete'`, `delta_usd` non-null |
| Toggle adjustment ON | Cashflow fields cleared, delta fields computed |
| Toggle adjustment OFF | Delta fields cleared, cashflow fields computed |
| Zero qty change (update same value) | `cashflow_amount_usd = 0`, status still `'complete'` |

**`__tests__/integration/transfer-rollback.test.ts`** (~3 cases):

| Case | What it verifies |
|------|-----------------|
| Successful transfer | Both legs created, both `is_adjustment = true`, `transfer_group_id` matches |
| Destination failure → rollback | Source position restored to original quantity after destination fails |
| Activity log entries | Both legs logged with correct adjustment flag and transfer_group_id |

**`__tests__/integration/fx-failure.test.ts`** (~3 cases):

| Case | What it verifies |
|------|-----------------|
| FX API failure on adjustment | `delta_status = 'pending'` (not silently NULL) |
| FX API failure on non-adjustment | `cashflow_status = 'pending'` |
| Pending row found by backfill query | Row matches backfill's `.or()` filter |

### Mocking strategy

Integration tests use real Supabase but server actions run in-process. For FX failure tests:
- Mock `@/lib/prices/fx` (`getFXRates`) to throw, using the same `vi.mock` pattern as existing server action tests.
- DB calls remain real (local Supabase via Docker).

For transfer rollback:
- The destination leg failure can be triggered by passing an invalid entity ID or by mocking the destination server action to throw after the source leg succeeds.

### Pattern

Same as existing integration tests: `createTestUser()` from `__tests__/integration/setup.ts`, authenticated Supabase client, cleanup via `docker exec psql`.

---

## 3. Retry Button for Pending/Failed Activity Rows

### Problem

The cashflow status icons (added in the precomputed-cashflows feature) show pending/failed status but offer no action. Users see the problem but can't fix it.

### Solution

Add a "Retry" button next to pending/failed status icons. Clicking retries computation for that specific row.

### Server action

**New function in `src/lib/actions/backfill.ts`:**
```typescript
export async function backfillSingleRow(rowId: string): Promise<{
  success: boolean;
  error?: string;
}>
```

- Validates UUID.
- Queries the specific row (with auth — `user_id` must match).
- Runs the same computation logic as the batch backfill (cash entities: direct from snapshots via `cashDelta` + `toUsdAndEur`, position entities: `computeDeltaFromSnapshots`).
- **Skips throttle and exhaustion gates** — no 24h cooldown, no 3-day exhaustion. User clicking "Retry" is explicit intent to try now. Simply attempt the computation and report the result.
- Updates status to `'complete'` on success, keeps current status on failure.
- Returns success/failure for UI feedback.

### UI changes

**`src/components/ui/cashflow-status-icon.tsx`:**
- Add optional props: `onRetry?: () => Promise<void>`, `logId?: string`.
- When `onRetry` is provided, render a small `RefreshCw` icon button next to the status icon.
- On click: show loading spinner (replace both icons with `Loader2`), call `onRetry()`, then:
  - Success: icons disappear (status is now `'complete'`, component re-renders via `revalidatePath`).
  - Failure: icons stay, show toast with error message.

**`src/components/history/activity-timeline.tsx`:**
- Pass `onRetry` callback to `CashflowStatusIcon` only in non-readOnly mode (not on share pages).
- The callback calls `backfillSingleRow(log.id)` and triggers `router.refresh()` on success.

### Styling

- `RefreshCw` icon: `w-3 h-3 text-zinc-500 hover:text-zinc-300 cursor-pointer` — subtle, doesn't dominate the status icon.
- Loading state: `Loader2` with `animate-spin`, same size as status icon.

### Testing

Component test: renders retry button when `onRetry` provided, doesn't render when omitted, shows loading state on click.

---

## 4. Stale FX Rate Indicator

### Problem

The dashboard shows EUR/USD-converted values but gives no indication when the FX rate is stale (>24h old) or unavailable (Yahoo fetch failed). Users see potentially wrong cross-currency values with no warning.

### Solution

Check the EUR/USD quote's `regularMarketTime` timestamp. Show a subtle indicator when stale or missing.

### Implementation

**Data flow:**
1. `dashboard/page.tsx` and `cash/page.tsx` already fetch `getStockPrices(["EURUSD=X"])`.
2. The `YahooStockPriceData` type does NOT currently include `regularMarketTime`. Two changes needed:
   - In `src/lib/prices/yahoo.ts`: extract `regularMarketTime` from the Yahoo v7 `QuoteResult` (the raw API returns it) and include in the returned data.
   - In `src/lib/types.ts`: add `regularMarketTime?: number` to `YahooStockPriceData`.
3. Compute staleness: `Date.now()/1000 - regularMarketTime > 86400` (>24h).
4. Pass `fxStale?: boolean` and `fxUnavailable?: boolean` to the summary display components.

**`dashboard/page.tsx`:**
```typescript
const eurUsdData = eurUsdBatch["EURUSD=X"];
const fxStale = eurUsdData?.regularMarketTime
  ? Date.now() / 1000 - eurUsdData.regularMarketTime > 86400
  : false;
const fxUnavailable = !eurUsdData?.price;
```

**UI indicator** — new component `src/components/ui/fx-status-indicator.tsx`:
```tsx
interface FxStatusIndicatorProps {
  stale: boolean;
  unavailable: boolean;
}
```
- `unavailable`: red `AlertTriangle` (w-3 h-3) with tooltip "FX rate unavailable — values shown in original currency."
- `stale`: amber `Clock` (w-3 h-3) with tooltip "FX rate is stale (>24h old)."
- Neither: returns `null`.

**Render location**: Next to the currency toggle (`CurrencyToggle` or `SearchPill` area in the dashboard layout). Small inline icon that doesn't disrupt layout.

**Scope**: Only EUR/USD rate — this is the primary FX rate for dual-currency display. Not per-stock currency rates.

### Testing

Component test: renders nothing when fresh, amber when stale, red when unavailable.

---

## 5. Import Replace Pre-Backup

### Problem

Import "replace" mode deletes 10 tables then imports. If import fails mid-way (e.g., malformed data, DB constraint violation), the user's portfolio is partially or fully deleted with no recovery path.

### Solution

Before clearing, capture a full backup using the existing `exportBackup()` function. If import fails, return the backup in the error response for client-side auto-download.

### Implementation

**`src/lib/actions/import.ts` — replace path (around line 199):**

Before the delete loop:
```typescript
if (isReplace) {
  // Safety net: capture full backup before destructive operation
  let safetyBackup: PortfolioBackup;
  try {
    safetyBackup = await exportFullJson();
  } catch (err) {
    return { ok: false, error: "Failed to create safety backup — aborting replace to protect your data." };
  }

  // ... existing delete loop ...
  // ... existing import logic ...

  // On any failure after this point, include backup in response
}
```

Import `exportFullJson` and `PortfolioBackup` from `@/lib/actions/export`.

**Type change:**

The `ImportResult` type (used by `importFromJson` and consumed by `import-export-settings.tsx`) needs the backup field:

```typescript
// Add to existing type
backup?: PortfolioBackup;
```

Any `return { ok: false, error: ... }` after the delete loop includes `backup: safetyBackup`.

Note: The backup is serialized as part of the server action response. For this app's scale (~20 assets, <100KB) this is fine. No separate download endpoint needed.

**Client-side handler** (`src/components/settings/import-export-settings.tsx` — where `importFromJson` result is consumed):

```typescript
if (!result.ok && result.backup) {
  // Auto-download the backup
  const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `portfolio-backup-${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);

  toast.error("Import failed. Your previous data has been downloaded as a backup.");
}
```

### Edge cases

- **`exportFullJson()` throws**: Caught by try/catch, abort before deleting anything. Return error immediately — never delete without a safety net.
- **Backup blob size**: For this invite-only app with ~20 assets, the backup JSON is small (<100KB). No memory concerns.
- **Merge mode**: Unaffected — merge mode doesn't delete, so no backup needed.

### Testing

Unit test: verify `exportFullJson` is called before delete in replace mode. Verify abort if export throws. Verify backup included in error response on import failure.

---

## What's NOT in Scope

- Sentry cron monitoring for the Edge Function (Deno runtime incompatibility)
- Vercel KV or Redis rate limiting (accepted tradeoff for invite-only)
- DB transactions for transfers (accepted tradeoff — app-level compensation is sufficient)
- E2E/Playwright tests (separate initiative)
- Stablecoin retroactive classification fix (accepted tradeoff)
