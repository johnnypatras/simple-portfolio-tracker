# Test Infrastructure Design

## Overview

Add automated regression tests to catch data-integrity bugs before they reach production.
Two-layer approach: fast unit tests (no DB) + integration tests (local Supabase).
GitHub Actions CI runs both on every push.

## Stack

| Tool | Purpose |
|------|---------|
| Vitest | Test runner (native ESM, TypeScript, path aliases) |
| Supabase CLI | Local Postgres + Auth for integration tests |
| GitHub Actions | CI pipeline (free tier, ~2 min/run) |

## File Structure

```
__tests__/
├── unit/                              # ~45 cases, ~2-3s, no DB
│   ├── validation.test.ts
│   ├── rate-limit.test.ts
│   ├── csv.test.ts
│   ├── holdings.test.ts
│   ├── fx.test.ts
│   ├── activity-log.test.ts
│   ├── aggregate.test.ts
│   ├── dashboard-insights.test.ts
│   ├── shares.test.ts
│   └── import-backup.test.ts
├── integration/                       # ~55 cases, ~20-25s, needs local Supabase
│   ├── setup.ts
│   ├── transfer-cleanup.test.ts
│   ├── transfer-balance-validation.test.ts
│   ├── undo-transfer-group.test.ts
│   ├── activity-log-undo.test.ts
│   ├── register-invite.test.ts
│   ├── migration-bootstrap.test.ts
│   ├── rls-enforcement.test.ts
│   ├── cascade-soft-delete.test.ts
│   ├── snapshot-validation.test.ts
│   ├── benchmark.test.ts
│   └── middleware.test.ts
vitest.config.ts
.github/workflows/test.yml
```

## npm Scripts

```json
{
  "test": "vitest run --project unit",
  "test:integration": "vitest run --project integration",
  "test:all": "vitest run",
  "test:watch": "vitest --project unit"
}
```

## Unit Tests (~45 cases)

### validation.test.ts
- validateAmount: positive passes, negative/NaN/zero throws
- validateCurrency: valid ISO passes, invalid/empty throws
- validateUUID: valid UUID passes, invalid throws
- validateName: normal passes, empty throws

### rate-limit.test.ts
- First request succeeds
- Requests within limit all pass
- Request exceeding limit blocked
- Window slides — old requests expire
- Concurrent burst — only `limit` pass
- Different IPs are independent

### csv.test.ts
- Normal strings unchanged
- Commas trigger quoting
- Formula injection neutralized (=, +, -, @, \t, \r prefixes)
- toCsv produces valid CSV output

### holdings.test.ts
- Crypto/stock/cash holdings map correctly
- Empty data returns empty array
- Path prefix applied correctly (/dashboard vs /share/token)

### fx.test.ts
- Same currency → no conversion
- Valid rate → correct math
- Missing rate → returns unconverted + warns
- Zero rate → handled (not silent doubling)
- getFXRatesSafe on error → fallback {base: 1}
- API timeout vs 500 behavior differences

### activity-log.test.ts
- computeDeltaFromSnapshots: before/after delta math
- Null before → uses full after amount (creation)
- Null after → negative delta (deletion)
- Same currency → no FX needed

### aggregate.test.ts
- Stablecoin classified as cash, not crypto
- Missing FX rate → no silent zero
- Component sum matches total (crypto+stocks+cash)
- Empty portfolio → all zeros, no crash

### dashboard-insights.test.ts
- Dividend yield with NaN/zero → no crash
- APY income uses APY-bearing balance only
- Currency exposure with non-USD/EUR stablecoins

### shares.test.ts
- Expired token → rejected
- Revoked token → rejected
- Valid token with scope → correct scope level

### import-backup.test.ts
- v1 backup accepted (backward compat)
- Missing required fields → rejected
- Invalid data values → rejected

## Integration Tests (~55 cases)

### setup.ts (shared)
- Reads local Supabase URL/keys via `supabase status --output json`
- Creates fresh test user per test file via admin API
- Provides authenticated Supabase client (RLS applies)
- Cleanup: delete user after tests (cascade deletes all data)

### transfer-cleanup.test.ts
- Successful transfer → entities persist
- Failed destination → orphans cleaned up (broker, wallet, deposit hard-deleted + activity_log entries removed)
- Partial failure (rollback failed) → entities preserved
- Cleanup order respects FK (deposits before wallets/brokers)

### transfer-balance-validation.test.ts
- Insufficient crypto balance → rejected before entity creation
- Insufficient deposit balance → rejected
- Sufficient balance → succeeds

### undo-transfer-group.test.ts
- Successful undo → both legs reversed atomically
- Atomicity: partial failure rolls back ALL changes
- Already undone → rejects double undo
- Audit trail: undone entries created, undone_at set
- RLS: can't undo another user's transfer

### activity-log-undo.test.ts
- Undo "created" → entity soft-deleted
- Undo "removed" → entity restored
- Undo "updated" → before_snapshot restored
- Undo already-undone → rejected
- Undo entry with no entity_id → rejected

### register-invite.test.ts
- Valid invite → registration succeeds
- Used invite → rejected
- Race condition → exactly one wins, loser cleaned up
- Cleanup failure → orphaned user edge case
- Expired invite boundary
- Rate limiting → 6th attempt blocked

### migration-bootstrap.test.ts
- Fresh `supabase db reset` applies all 48 migrations
- All 18 expected tables exist
- RLS enabled on all user-data tables
- undo_transfer_group RPC callable

### rls-enforcement.test.ts
- User A's data invisible to User B (per table family):
  crypto_assets, crypto_positions, stock_assets, stock_positions,
  wallets, brokers, bank_accounts, exchange_deposits, broker_deposits,
  activity_log, portfolio_snapshots
- User B can't UPDATE User A's data
- User B can't DELETE User A's activity_log

### cascade-soft-delete.test.ts
- Delete wallet → positions + deposits cascade
- Delete broker → positions + deposits cascade
- Restore wallet → children restored
- Delete crypto asset → positions cascade
- Cascade doesn't cross users
- Account deletion cascades all data
- clearAllData keeps account, removes portfolio

### snapshot-validation.test.ts
- Component sum matches total (within $1 drift)
- Zero holdings → all zeros, no errors
- Same-day duplicate → upsert not insert
- Rounding accumulation across 4 components
- No previous snapshot → sanity check skipped gracefully
- Timezone boundary (midnight UTC vs user timezone)

### benchmark.test.ts
- Cash flow with missing historical price → flagged, not silently zeroed
- Adjustment entries excluded from cash flows
- EUR stock → FX conversion to USD for cash flow

### middleware.test.ts
- Unauthenticated → redirect to /login
- Pending user → can only access /pending
- Share pages skip auth
- Missing profile → handled gracefully

## GitHub Actions CI

### Trigger
Every push to `main` and every pull request.

### Pipeline
1. Checkout + install deps (~30s, cached)
2. Lint (`npm run lint`)
3. Build (`npm run build`)
4. Unit tests (`npm test`)
5. Start Supabase (`supabase start`)
6. Integration tests (`npm run test:integration`)
7. Stop Supabase

### Runner
`ubuntu-latest` (free tier, 2000 min/month).

### Failure behavior
Red X on commit, email notification. Vercel still deploys (non-blocking).

## Excluded (lower priority)

- Yahoo crumb auth — external API, hard to mock meaningfully
- backfillCryptoImages — cosmetic, not data integrity
- changePassword with 2FA — manual test easier
- Dividend yield precision — display only
- Currency exposure threshold — display only

## Dependencies

- `vitest` (devDependency)
- `supabase` CLI (already installed v2.75.0)
- Docker (already installed v28.5.2)
- `supabase init` needed (one-time, creates config.toml)
