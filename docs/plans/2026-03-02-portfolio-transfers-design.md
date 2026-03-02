# Portfolio Transfers — Design Document

## Problem
When converting between assets (sell stock for cash, swap crypto, move between institutions),
there's no way to do it without manually editing both sides independently. This creates
mismatched activity log entries and incorrect S&P benchmark cash flows.

## Solution
A unified **two-legged transfer** system: every sell/buy/move is modeled as
`source leg (reduce) → destination leg (increase)`, both flagged as `is_adjustment = true`
and linked by a shared `transfer_group_id`.

## Architecture: Approach A — Unified Transfer Action

One `executeTransfer()` server action handles all combinations.
One `TransferDialog` component with three modes (sell/buy/move).

---

## 1. Schema Migration

```sql
-- Link transfer legs in activity_log
ALTER TABLE activity_log ADD COLUMN transfer_group_id UUID;
CREATE INDEX idx_activity_log_transfer_group
  ON activity_log(transfer_group_id) WHERE transfer_group_id IS NOT NULL;

-- Badge: distinguish transfers from manual adjustments
ALTER TABLE crypto_positions ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stock_positions ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bank_accounts ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE broker_deposits ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exchange_deposits ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
```

## 2. Types

```typescript
type TransferMode = "sell" | "buy" | "move";

type TransferSide =
  | { type: "crypto_position"; assetId: string; walletId: string; quantity: number }
  | { type: "stock_position";  assetId: string; brokerId: string; quantity: number }
  | { type: "exchange_deposit"; walletId: string; currency: string; amount: number }
  | { type: "broker_deposit";   brokerId: string; currency: string; amount: number }
  | { type: "bank_account";     accountId: string; amount: number };

interface TransferInput {
  mode: TransferMode;
  source: TransferSide;
  destination: TransferSide;
  newCryptoAsset?: CryptoAssetInput;
  newStockAsset?: StockAssetInput;
}

type TransferResult =
  | { success: true; transferGroupId: string; partialFailure?: boolean }
  | { success: false; error: string; transferGroupId?: string; partialFailure?: boolean };
```

## 3. Server Action — `executeTransfer()`

**File:** `src/lib/actions/transfers.ts`

### Flow

1. Generate `transferGroupId = crypto.randomUUID()`
2. If `newAsset` provided → create it (`createCryptoAsset` or `createStockAsset`)
3. Fetch current state of source entity (current qty/amount)
4. **Execute source leg** — reduce position or cash via existing CRUD function
   - `opts = { isAdjustment: true, transferGroupId, ...prices }`
   - Position hitting qty=0 → existing upsert handles soft-delete
5. **Execute destination leg** (wrapped in try-catch)
   - Check if destination entity exists → create or update accordingly
   - `opts = { isAdjustment: true, transferGroupId, ...prices }`
6. **On destination failure:**
   - Retry once (handles transient errors)
   - If still fails → rollback source (restore original qty/amount)
   - If rollback fails → return `partialFailure` with detailed error
7. `revalidatePath("/dashboard/accounts")`
8. Return `{ success: true, transferGroupId }`

### Delta Accounting

Both legs are `is_adjustment = true`:
- `deriveCashFlows()` ignores both → S&P benchmark unaffected
- Chart compensation: `value + (finalCumDelta - cumDelta)` absorbs both deltas
- Fee/slippage is implicit: source delta ≠ destination delta → net = fee loss

Example:
```
Source:  sell 10 VWCE.DE → delta_eur = -1,200
Dest:   receive EUR     → delta_eur = +1,180
Net:    -20 EUR (broker fee, captured naturally)
```

## 4. Plumbing Changes

### `logActivity()` — add parameter

```typescript
transfer_group_id?: string;  // NEW — nullable UUID
```

### CRUD function opts — add `transferGroupId`

All 11 functions thread it to `logActivity()`:
- `upsertStockPosition`, `deleteStockPosition`
- `upsertPosition` (crypto), `deletePosition` (crypto)
- `createExchangeDeposit`, `updateExchangeDeposit`
- `createBrokerDeposit`, `updateBrokerDeposit`
- `createBankAccount`, `updateBankAccount`

Each function adds to its `logActivity()` call:
```typescript
transfer_group_id: opts?.transferGroupId,
```

### `last_was_transfer` flag

CRUD functions set both flags when called from a transfer:
```typescript
last_was_adjustment: opts?.isAdjustment ?? false,
last_was_transfer: opts?.transferGroupId != null,
```

## 5. Undo Extension — Paired Transfer Undo

### `undoActivity()` change

When an entry has `transfer_group_id`:
1. Find all entries with the same `transfer_group_id` where `undone_at IS NULL`
2. Undo each leg independently (existing logic, extracted to `undoSingleEntry()`)
3. Mark all as undone
4. Return "Transfer reversed (both legs undone)"

Order of leg undo doesn't matter — each reversal is independent.

## 6. UI — TransferDialog Component

**File:** `src/components/ui/transfer-dialog.tsx`

### Layout

```
┌─ Transfer: Sell VWCE.DE ───────────────────────┐
│                                                 │
│  FROM                                           │
│  ┌─────────────────────────────────────────┐    │
│  │ VWCE.DE — Vanguard FTSE All-World       │    │
│  │ Location: [DEGIRO ▼]                    │    │
│  │ Quantity: [10________]                  │    │
│  │ Value: €1,200.00 (at €120.00/share)     │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│                    → €1,200.00                  │
│                                                 │
│  TO                                             │
│  ┌─────────────────────────────────────────┐    │
│  │ Type: [Cash ▼]                          │    │
│  │ Asset: [EUR at DEGIRO ▼] [+ Add new...] │    │
│  │ Amount: [1,200.00____] (editable)       │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Fee/difference: -€0.00                         │
│                                                 │
│  [Cancel]                    [Execute Transfer] │
└─────────────────────────────────────────────────┘
```

### Mode-dependent behavior

| Element | Sell | Buy | Move |
|---------|------|-----|------|
| Source pre-filled | Asset + location | User picks | Asset + location |
| Dest pre-filled | User picks | Asset + location | User picks location |
| Source types | Position | Cash or position | Any |
| Dest types | Cash or position | Position | Same asset type |
| Auto-calc | Src qty × price → dest | Dest qty × price → src | Src qty = dest qty |

### Amount auto-calculation with override

- Pre-fill destination from `sourceQty × currentPrice / destPrice`
- User can edit destination amount freely
- If edited ≠ auto-calculated, show the difference as "Fee: -€X.XX" in amber
- Fee indicator helps user verify they entered the correct amount

### Inline asset creation

When destination asset doesn't exist:
1. Dropdown includes "Add new..." option at bottom
2. Clicking opens CoinGecko/Yahoo search (reuse existing search components)
3. User selects asset → details populate destination section
4. On execute, `newAsset` input creates the asset before the transfer

## 7. UI — Entry Points

### Stock Position Editor (`stock-position-editor.tsx`)

Two icon buttons in the modal header (next to asset name):
- **Sell** icon → opens TransferDialog(mode="sell", source=this stock)
- **Buy** icon → opens TransferDialog(mode="buy", destination=this stock)

### Crypto Position Editor (`position-editor.tsx`)

Same pattern as stocks.

### Position rows — Move button

Per-broker/per-wallet row, a **Move** icon:
- Opens TransferDialog(mode="move", source=this asset at this location)
- Destination pre-scoped to same asset, different location

### Accounts page — Per-institution Transfer

Each institution card gets a **Transfer** icon:
- Opens TransferDialog with no pre-fills, scoped to that institution
- User picks source and destination from institution's assets/cash

## 8. Badge System

### Precedence

```typescript
if (entity.last_was_transfer) → "Xfer" badge
else if (entity.last_was_adjustment) → "Adj." badge
else → no badge
```

### Styling

| Badge | Text | Color | Tooltip |
|-------|------|-------|---------|
| Transfer | `Xfer` | `text-teal-400` | "Last change was a sell/buy/move transfer" |
| Adjustment | `Adj.` | `text-amber-400` | "Not a real transaction — portfolio balance correction" |

---

## Decisions Made

| Decision | Why |
|----------|-----|
| All combinations (any asset ↔ any asset/cash) | Covers crypto swaps, stock sells, bank transfers, cross-institution moves |
| Auto-calculate with override | Fast for approximate, editable for precision (captures fees naturally) |
| Both legs as `is_adjustment = true` | S&P benchmark ignores internal transfers (not deposits/withdrawals) |
| `transfer_group_id` on activity_log | Links legs for paired undo, future grouped display, transfer history |
| `last_was_transfer` column on entity tables | Distinguishes transfer badge from adjustment badge without extra queries |
| Paired undo | Undo either leg → both legs reversed atomically |
| Retry + rollback on destination failure | Handles transient errors; detailed error on complete failure |
| Inline asset creation in dialog | Friction-free for swaps where destination asset is new (BTC → ETH) |
| Approach A (unified action) over C (generic engine) | DRY without over-abstraction; extend to N-leg later if needed |
| Currency excluded from editable stock fields | Changing currency recomputes all historical cash flows (too risky) |

## Integration Concerns & Mitigations

| # | Concern | Severity | Mitigation |
|---|---------|----------|------------|
| 1 | Thread `transferGroupId` through 11 functions | Low | Mechanical, additive (new optional field) |
| 2 | Cash destination might not exist | Low | Check-then-create-or-update per cash type |
| 3 | Delta calculation asymmetry | None | Existing mechanism handles correctly |
| 4 | Undo for transfers | Medium | Paired undo via `transfer_group_id` |
| 5 | "Adj." vs "Xfer" badge | Low | `last_was_transfer` column, precedence check |
| 6 | Partial failure between legs | Medium | Retry once + rollback + detailed error |
| 7 | revalidatePath coverage | Low | Add `/dashboard/accounts` in `executeTransfer()` |
| 8 | Orphaned asset on inline creation fail | Low | Acceptable — shows with 0 positions |

## Files Modified / Created

### New files
- `src/lib/actions/transfers.ts` — `executeTransfer()` server action
- `src/components/ui/transfer-dialog.tsx` — TransferDialog component
- `supabase/migrations/045_transfer_group_and_badge.sql` — schema migration

### Modified files
- `src/lib/actions/activity-log.ts` — add `transfer_group_id` to `logActivity()`
- `src/lib/actions/stocks.ts` — add `transferGroupId` to opts
- `src/lib/actions/crypto.ts` — add `transferGroupId` to opts
- `src/lib/actions/exchange-deposits.ts` — add `transferGroupId` to opts
- `src/lib/actions/broker-deposits.ts` — add `transferGroupId` to opts
- `src/lib/actions/bank-accounts.ts` — add `transferGroupId` to opts
- `src/lib/actions/undo.ts` — paired undo for transfer groups
- `src/lib/types.ts` — TransferSide, TransferInput, TransferResult types
- `src/components/stocks/stock-position-editor.tsx` — sell/buy/move buttons
- `src/components/crypto/position-editor.tsx` — sell/buy/move buttons
- `src/components/accounts/*.tsx` — per-institution transfer button
