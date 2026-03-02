# Portfolio Transfers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unified sell/buy/move system that converts between any asset types across any institutions, treated as linked adjustments to preserve S&P benchmark accuracy.

**Architecture:** One `executeTransfer()` server action orchestrates two legs (reduce source, increase destination), both flagged `is_adjustment=true` and linked by `transfer_group_id` UUID. One `TransferDialog` component with three modes (sell/buy/move). Existing CRUD functions are reused — only their opts get a new `transferGroupId` field threaded to `logActivity()`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase PostgreSQL, React 19, Tailwind CSS 4, Sonner toasts.

**Testing:** No test framework. Verify via `npm run build` (type-checks + compilation) and manual browser testing.

**Design doc:** `docs/plans/2026-03-02-portfolio-transfers-design.md`

---

## Task 1: Schema Migration + Transfer Types

**Files:**
- Create: `supabase/migrations/045_transfer_support.sql`
- Modify: `src/lib/types.ts`

### Step 1: Create the migration

Use the `supabase-migration` skill or create manually. The migration adds `transfer_group_id` to `activity_log` and `last_was_transfer` to all 5 entity tables:

```sql
-- Transfer group linking for paired sell/buy/move operations
ALTER TABLE activity_log ADD COLUMN transfer_group_id UUID;
CREATE INDEX idx_activity_log_transfer_group
  ON activity_log(transfer_group_id) WHERE transfer_group_id IS NOT NULL;

-- Badge: distinguish transfers from manual adjustments
ALTER TABLE crypto_positions  ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE stock_positions   ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bank_accounts     ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE broker_deposits   ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exchange_deposits ADD COLUMN last_was_transfer BOOLEAN NOT NULL DEFAULT false;
```

Apply via Supabase MCP `apply_migration` tool. Project ID: `jaxjhmkehoyrkcxpbzay`.

### Step 2: Add transfer types to `src/lib/types.ts`

Add at the end of the file, before the closing exports:

```typescript
// ─── Portfolio Transfers ────────────────────────────────

export type TransferMode = "sell" | "buy" | "move";

export type TransferSide =
  | { type: "crypto_position"; assetId: string; walletId: string; quantity: number }
  | { type: "stock_position";  assetId: string; brokerId: string; quantity: number }
  | { type: "exchange_deposit"; walletId: string; currency: string; amount: number }
  | { type: "broker_deposit";   brokerId: string; currency: string; amount: number }
  | { type: "bank_account";     accountId: string; amount: number };

export interface TransferInput {
  mode: TransferMode;
  source: TransferSide;
  destination: TransferSide;
  newCryptoAsset?: CryptoAssetInput;
  newStockAsset?: StockAssetInput;
}

export interface TransferResult {
  success: boolean;
  transferGroupId: string;
  error?: string;
  partialFailure?: boolean;
}
```

### Step 3: Add `last_was_transfer` to entity interfaces

In `src/lib/types.ts`, add `last_was_transfer?: boolean;` to each of these interfaces (next to the existing `last_was_adjustment` field):

- `BankAccount` (around line 62)
- `ExchangeDeposit` interface (find it — has `last_was_adjustment`)
- `BrokerDeposit` interface
- `CryptoPosition` interface
- `StockPosition` interface

### Step 4: Verify build

```bash
npm run build
```
Expected: clean build, no type errors.

### Step 5: Commit

```bash
git add supabase/migrations/045_transfer_support.sql src/lib/types.ts
git commit -m "feat: add transfer types and schema migration"
```

---

## Task 2: Plumbing — logActivity + CRUD Opts

Thread `transferGroupId` through all 11 CRUD functions to `logActivity()`, and set `last_was_transfer` when present.

**Files:**
- Modify: `src/lib/actions/activity-log.ts` (line 38)
- Modify: `src/lib/actions/stocks.ts` (lines 264, 387, 402)
- Modify: `src/lib/actions/crypto.ts` (lines 236, 357)
- Modify: `src/lib/actions/exchange-deposits.ts` (lines 33, 100)
- Modify: `src/lib/actions/broker-deposits.ts` (lines 32, 92)
- Modify: `src/lib/actions/bank-accounts.ts` (lines 25, 148)

### Step 1: Extend `logActivity()`

In `src/lib/actions/activity-log.ts`, add `transfer_group_id` to the params type (after `delta_eur` line ~50):

```typescript
  delta_eur?: number | null;
  transfer_group_id?: string;  // ← ADD THIS
```

And in the insert object (after `delta_eur` line ~72):

```typescript
      delta_eur: params.delta_eur ?? null,
      transfer_group_id: params.transfer_group_id ?? null,  // ← ADD THIS
```

### Step 2: Extend stock action opts

In `src/lib/actions/stocks.ts`:

**`upsertStockPosition()`** — add to opts type:
```typescript
export async function upsertStockPosition(input: StockPositionInput, opts?: {
  isAdjustment?: boolean;
  currentPriceNative?: number;
  assetCurrency?: string;
  transferGroupId?: string;  // ← ADD
})
```

Add `last_was_transfer` to the insert/update calls:
```typescript
last_was_adjustment: opts?.isAdjustment ?? false,
last_was_transfer: opts?.transferGroupId != null,  // ← ADD after every last_was_adjustment
```

Add to BOTH `logActivity()` calls in this function:
```typescript
transfer_group_id: opts?.transferGroupId,  // ← ADD
```

**`deleteStockPosition()`** — same pattern:
```typescript
export async function deleteStockPosition(positionId: string, opts?: {
  isAdjustment?: boolean;
  currentPriceNative?: number;
  assetCurrency?: string;
  transferGroupId?: string;  // ← ADD
})
```

Add `transfer_group_id: opts?.transferGroupId` to its `logActivity()` call.

### Step 3: Extend crypto action opts

In `src/lib/actions/crypto.ts`:

**`upsertPosition()`**:
```typescript
export async function upsertPosition(input: CryptoPositionInput, opts?: {
  isAdjustment?: boolean;
  currentPriceUsd?: number;
  currentPriceEur?: number;
  transferGroupId?: string;  // ← ADD
})
```

Add `last_was_transfer: opts?.transferGroupId != null` to insert/update objects.
Add `transfer_group_id: opts?.transferGroupId` to both `logActivity()` calls.

**`deletePosition()`** — same pattern.

### Step 4: Extend exchange deposit opts

In `src/lib/actions/exchange-deposits.ts`:

**`createExchangeDeposit()`**:
```typescript
export async function createExchangeDeposit(
  input: ExchangeDepositInput,
  opts?: { isAdjustment?: boolean; transferGroupId?: string }  // ← ADD
)
```

Add `last_was_transfer: opts?.transferGroupId != null` to the insert object.
Add `transfer_group_id: opts?.transferGroupId` to its `logActivity()` call.

**`updateExchangeDeposit()`** — same pattern for update object and logActivity call.

### Step 5: Extend broker deposit opts

In `src/lib/actions/broker-deposits.ts`:

**`createBrokerDeposit()`** and **`updateBrokerDeposit()`** — same pattern as exchange deposits.

### Step 6: Extend bank account opts

In `src/lib/actions/bank-accounts.ts`:

**`createBankAccount()`** — add `transferGroupId?: string` to opts. Add to insert + logActivity.

**`updateBankAccount()`** — add `transferGroupId?: string` to opts. Add to update + logActivity. Also add `last_was_transfer: opts?.transferGroupId != null` to the update payload.

### Step 7: Verify build

```bash
npm run build
```
Expected: clean build. All existing callers are unaffected (new field is optional).

### Step 8: Commit

```bash
git add src/lib/actions/activity-log.ts src/lib/actions/stocks.ts src/lib/actions/crypto.ts \
  src/lib/actions/exchange-deposits.ts src/lib/actions/broker-deposits.ts src/lib/actions/bank-accounts.ts
git commit -m "feat: thread transferGroupId through CRUD functions to logActivity"
```

---

## Task 3: `executeTransfer()` Server Action

**Files:**
- Create: `src/lib/actions/transfers.ts`

### Step 1: Create the server action

Create `src/lib/actions/transfers.ts` with the complete transfer orchestration logic.

The function needs to:
1. Generate a `transferGroupId` UUID
2. Optionally create a new asset (crypto or stock) if the destination asset doesn't exist
3. Fetch current state of source entity
4. Execute source leg (reduce) using existing CRUD functions with `{ isAdjustment: true, transferGroupId }`
5. Execute destination leg (increase) in try-catch
6. On destination failure: retry once, then rollback source, then report partial failure
7. Revalidate paths

**Key implementation details:**

For the **source leg** — determine which CRUD function to call based on `source.type`:
- `"crypto_position"` → fetch current qty, call `upsertPosition({ quantity: currentQty - source.quantity })` with adjustment + transfer opts. If result qty ≤ 0, existing upsert handles soft-delete.
- `"stock_position"` → fetch current qty, call `upsertStockPosition({ quantity: currentQty - source.quantity })` with opts.
- `"exchange_deposit"` → fetch current amount, call `updateExchangeDeposit(id, { amount: currentAmount - source.amount })` with opts.
- `"broker_deposit"` → same pattern with broker deposits.
- `"bank_account"` → call `updateBankAccount(id, { balance: currentBalance - source.amount })` with opts.

For the **destination leg** — similar but check if entity exists first:
- Position types: call upsert (handles create-or-update automatically).
- Cash types: query for existing row by (wallet_id/broker_id, currency) or account_id. If exists → update (add amount). If not → create.

For **price lookups** (needed for delta calculation on position legs):
- Crypto: import and call the price-fetching functions to get current USD/EUR prices.
- Stock: import and call Yahoo price-fetching to get current native price + currency.
- Cash: no price lookup needed (delta = amount directly).

For **rollback on destination failure**:
```typescript
try {
  await executeDestinationLeg(destination, transferGroupId, prices);
} catch (destErr) {
  // Retry once
  try {
    await executeDestinationLeg(destination, transferGroupId, prices);
  } catch {
    // Rollback source: restore to original state
    try {
      await rollbackSourceLeg(source, originalState, transferGroupId);
    } catch (rollbackErr) {
      return {
        success: false,
        transferGroupId,
        partialFailure: true,
        error: `Transfer failed and rollback failed. Source was modified. Original state: ${JSON.stringify(originalState)}. Please check your positions.`,
      };
    }
    return {
      success: false,
      transferGroupId,
      error: destErr instanceof Error ? destErr.message : "Destination leg failed",
    };
  }
}
```

The function should also accept current price data as an optional parameter (pre-fetched by the UI) to avoid redundant price lookups.

### Step 2: Verify build

```bash
npm run build
```

### Step 3: Commit

```bash
git add src/lib/actions/transfers.ts
git commit -m "feat: add executeTransfer server action for sell/buy/move"
```

---

## Task 4: Undo Extension for Paired Transfers

**Files:**
- Modify: `src/lib/actions/undo.ts`

### Step 1: Extract single-entry undo logic

Refactor `undoActivity()` to extract the core reversal logic into a helper `undoSingleEntry()`. The existing function body (lines ~46–189) becomes `undoSingleEntry()`, and `undoActivity()` becomes a thin wrapper that checks for `transfer_group_id`.

### Step 2: Add paired undo logic

At the top of `undoActivity()`, after fetching the log entry, add:

```typescript
// Paired transfer undo — reverse both legs
if (log.transfer_group_id) {
  const { data: groupEntries } = await supabase
    .from("activity_log")
    .select("*")
    .eq("transfer_group_id", log.transfer_group_id)
    .is("undone_at", null)
    .order("created_at", { ascending: true });

  if (!groupEntries?.length) {
    return { success: false, message: "No active transfer legs found" };
  }

  const errors: string[] = [];
  for (const entry of groupEntries) {
    const result = await undoSingleEntry(entry, supabase, user.id);
    if (!result.success) errors.push(result.message);
  }

  if (errors.length > 0) {
    return { success: false, message: `Partial undo: ${errors.join("; ")}` };
  }

  return { success: true, message: "Transfer reversed (both legs undone)" };
}

// Original single-entry undo logic
return undoSingleEntry(log, supabase, user.id);
```

### Step 3: Verify build

```bash
npm run build
```

### Step 4: Commit

```bash
git add src/lib/actions/undo.ts
git commit -m "feat: paired undo for transfer groups"
```

---

## Task 5: TransferDialog Component

**Files:**
- Create: `src/components/ui/transfer-dialog.tsx`

This is the largest task. The dialog is a modal with source/destination sections, auto-calculation, and inline asset creation.

### Step 1: Create the component skeleton

Create `src/components/ui/transfer-dialog.tsx`.

**Props:**
```typescript
interface TransferDialogProps {
  open: boolean;
  onClose: () => void;
  mode: TransferMode;
  // Pre-filled source (for sell/move modes)
  initialSource?: {
    type: "crypto_position" | "stock_position";
    assetId: string;
    assetName: string;
    assetTicker: string;
    locationId: string;  // walletId or brokerId
    locationName: string;
    currentQty: number;
    currency: string;
    currentPrice?: number;  // native price
    currentPriceUsd?: number;
    currentPriceEur?: number;
  };
  // Pre-filled destination (for buy mode)
  initialDestination?: { /* same shape */ };
}
```

**State:**
- `sourceType`: which entity type is source
- `sourceAssetId`, `sourceLocationId`, `sourceQuantity`
- `destType`, `destAssetId`, `destLocationId`, `destAmount`/`destQuantity`
- `autoCalcAmount`: computed from prices, shown as placeholder
- `manualOverride`: whether user edited the destination amount
- `fee`: difference between auto-calc and manual entry
- `loading`, `error`
- Data fetched on mount: `wallets`, `brokers`, `bankAccounts`, `cryptoAssets`, `stockAssets`, `prices`

**Key behaviors:**
1. On mount, fetch cross-domain data via server actions (`getWallets`, `getBrokers`, `getBankAccounts`, `getCryptoAssetsWithPositions`, `getStockAssetsWithPositions`).
2. When source quantity changes, auto-calculate destination amount: `sourceQty × sourcePrice / destPrice` (for asset→asset) or `sourceQty × sourcePrice` (for asset→cash, converted to dest currency).
3. When user edits destination amount, show fee indicator: `fee = autoCalcAmount - userEnteredAmount`.
4. On execute: call `executeTransfer()` server action, show loading, handle errors, close + toast on success.

**Layout (Tailwind CSS):**
```
Modal (existing Modal component)
├── div.space-y-4
│   ├── Source section
│   │   ├── label "FROM" (text-xs text-zinc-500)
│   │   ├── Asset display or picker
│   │   ├── Location dropdown
│   │   ├── Quantity input
│   │   └── Value display (text-xs text-zinc-500)
│   ├── Arrow/divider (centered → icon + computed value)
│   ├── Destination section
│   │   ├── label "TO" (text-xs text-zinc-500)
│   │   ├── Entity type tabs or dropdown (Cash / Crypto / Stock)
│   │   ├── Asset picker (dropdown + "Add new..." at bottom)
│   │   ├── Location dropdown
│   │   ├── Amount/quantity input (pre-filled, editable)
│   │   └── Fee indicator (if override, amber text)
│   ├── Error display (if any)
│   └── Action button row
│       ├── Cancel
│       └── Execute Transfer (blue-600, disabled when loading)
```

### Step 2: Implement the source section

The source section behavior depends on mode:
- **Sell/Move**: pre-filled from `initialSource` prop. Asset and location are read-only. Only quantity is editable.
- **Buy**: user picks source. Show entity type tabs, then asset/cash picker, then amount input.

### Step 3: Implement the destination section

- **Buy/Move**: partially pre-filled. For buy, asset is pre-filled. For move, asset is same but location is editable.
- **Sell**: user picks destination. Show entity type tabs (Cash/Crypto/Stock), then pickers.
- **"Add new..." option**: at the bottom of the asset dropdown. When clicked, show inline search component (reuse `CryptoSearchDialog` or `StockSearchInput` patterns from existing code — check `src/components/crypto/` and `src/components/stocks/` for the search components).

### Step 4: Implement auto-calculation

```typescript
// When source quantity or prices change:
const autoCalcDestAmount = useMemo(() => {
  if (!sourcePrice || !sourceQuantity) return null;
  const sourceValue = sourceQuantity * sourcePrice;

  if (destType is cash) {
    // Convert sourceValue to dest currency using FX rates
    return convertCurrency(sourceValue, sourceCurrency, destCurrency);
  }
  if (destType is position && destPrice) {
    // Convert to destination asset quantity
    return sourceValue / destPrice;
  }
  return sourceValue;
}, [sourceQuantity, sourcePrice, destPrice, currencies]);
```

Pre-fill the destination input with `autoCalcDestAmount`. If user edits it, set `manualOverride = true` and compute fee.

### Step 5: Implement the execute handler

```typescript
async function handleExecute() {
  setLoading(true);
  setError(null);
  try {
    const result = await executeTransfer({
      mode,
      source: buildSourceSide(),
      destination: buildDestSide(),
      newCryptoAsset: newAssetData?.type === "crypto" ? newAssetData.input : undefined,
      newStockAsset: newAssetData?.type === "stock" ? newAssetData.input : undefined,
    });
    if (!result.success) {
      setError(result.error ?? "Transfer failed");
      if (result.partialFailure) {
        toast.error("Transfer partially failed — check positions");
      }
      return;
    }
    toast.success(`Transfer complete`);
    onClose();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Transfer failed");
  } finally {
    setLoading(false);
  }
}
```

### Step 6: Verify build

```bash
npm run build
```

### Step 7: Commit

```bash
git add src/components/ui/transfer-dialog.tsx
git commit -m "feat: add TransferDialog component for sell/buy/move"
```

---

## Task 6: Entry Points — Position Editors

**Files:**
- Modify: `src/components/stocks/stock-position-editor.tsx`
- Modify: `src/components/crypto/position-editor.tsx`

### Step 1: Stock position editor — add sell/buy buttons

In `src/components/stocks/stock-position-editor.tsx`:

1. Import `TransferDialog` and `TransferMode` and relevant icons (`ArrowRightLeft`, `TrendingDown`, `TrendingUp` from lucide-react).
2. Add state: `transferMode: TransferMode | null` and `transferOpen: boolean`.
3. Add buttons in the modal header area (after the title), or just below the asset identity fields section:

```tsx
{/* Sell / Buy / Move actions */}
<div className="flex items-center gap-1.5 pt-1">
  <button
    onClick={() => { setTransferMode("sell"); setTransferOpen(true); }}
    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50 transition-colors"
    title="Sell this asset"
  >
    <TrendingDown className="w-3 h-3" /> Sell
  </button>
  <button
    onClick={() => { setTransferMode("buy"); setTransferOpen(true); }}
    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50 transition-colors"
    title="Buy more of this asset"
  >
    <TrendingUp className="w-3 h-3" /> Buy
  </button>
</div>
```

4. Add Move button per position row (next to the delete button):

```tsx
<button
  onClick={() => {
    // Pre-fill source with this position's broker
    setTransferMode("move");
    setTransferOpen(true);
  }}
  className="p-1.5 sm:p-2 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
  title="Move to another broker"
>
  <ArrowRightLeft className="w-4 h-4" />
</button>
```

5. Render the TransferDialog:

```tsx
{transferOpen && transferMode && (
  <TransferDialog
    open={transferOpen}
    onClose={() => setTransferOpen(false)}
    mode={transferMode}
    initialSource={transferMode !== "buy" ? {
      type: "stock_position",
      assetId: asset.id,
      assetName: asset.name,
      assetTicker: asset.ticker,
      locationId: /* brokerId from the clicked row for move, or first position's broker for sell */,
      locationName: /* broker name */,
      currentQty: /* qty */,
      currency: asset.currency,
      currentPrice: prices?.[asset.yahoo_ticker ?? ""]?.price,
    } : undefined}
    initialDestination={transferMode === "buy" ? {
      type: "stock_position",
      assetId: asset.id,
      assetName: asset.name,
      assetTicker: asset.ticker,
      /* ... */
    } : undefined}
  />
)}
```

### Step 2: Crypto position editor — same pattern

In `src/components/crypto/position-editor.tsx`, add the same sell/buy buttons and per-position move button. The key difference:
- Source type is `"crypto_position"` instead of `"stock_position"`
- Location is `walletId` instead of `brokerId`
- Price comes from CoinGecko data (`currentPriceUsd`, `currentPriceEur`) instead of Yahoo

### Step 3: Verify build

```bash
npm run build
```

### Step 4: Commit

```bash
git add src/components/stocks/stock-position-editor.tsx src/components/crypto/position-editor.tsx
git commit -m "feat: add sell/buy/move entry points to position editors"
```

---

## Task 7: Entry Point — Accounts Page

**Files:**
- Modify: `src/components/accounts/*.tsx` (find the institution card/row component)

### Step 1: Explore the accounts page structure

Read the accounts page components to understand where to add the per-institution Transfer button. Look for the component that renders institution cards/rows.

```bash
# Find the right file
ls src/components/accounts/
```

### Step 2: Add Transfer button per institution

Add an `ArrowRightLeft` icon button on each institution header/card. When clicked, open `TransferDialog` with no pre-fills but scoped to that institution's assets.

The dialog opens in a "general" mode — user picks both source and destination. Filter the initial dropdown options to show assets at this institution first.

### Step 3: Verify build + commit

```bash
npm run build
git add src/components/accounts/
git commit -m "feat: add per-institution transfer button on accounts page"
```

---

## Task 8: Badge System — Xfer vs Adj

**Files:**
- Modify: `src/components/stocks/stock-position-editor.tsx`
- Modify: `src/components/crypto/position-editor.tsx`
- Potentially: cash deposit editors if they show badges

### Step 1: Update badge precedence in stock editor

Find the existing "Adj." badge rendering (around the `adjOverrides` / `last_was_adjustment` check). Add `last_was_transfer` check with higher precedence:

```tsx
{/* Badge: Transfer > Adjustment */}
{existingPosition?.last_was_transfer && !justSaved && (
  <span className="text-[10px] text-teal-400 font-medium" title="Last change was a sell/buy/move transfer">
    Xfer
  </span>
)}
{!existingPosition?.last_was_transfer && (adjOverrides[brokerId] ?? existingPosition?.last_was_adjustment) && !justSaved && (
  <span className="text-[10px] text-amber-400 font-medium" title="Not a real transaction — portfolio balance correction">
    Adj.
  </span>
)}
```

### Step 2: Same in crypto editor

Apply the same badge precedence logic.

### Step 3: Verify build + commit

```bash
npm run build
git add src/components/stocks/stock-position-editor.tsx src/components/crypto/position-editor.tsx
git commit -m "feat: add Xfer badge for transfer operations"
```

---

## Task 9: Final Integration Verification

### Step 1: Full build

```bash
npm run build
npm run lint
```
Expected: clean build, no lint errors.

### Step 2: Manual browser testing checklist

Start dev server: `npm run dev`

1. **Stock sell flow:**
   - Open a stock position editor → click "Sell"
   - Verify dialog shows source pre-filled
   - Select "Cash" destination → pick broker deposit
   - Enter quantity → verify auto-calculated amount
   - Override amount → verify fee indicator appears
   - Execute → verify position reduced, cash increased
   - Check activity log → two entries with same `transfer_group_id`

2. **Crypto swap flow:**
   - Open a crypto position editor → click "Sell"
   - Select "Crypto" destination → pick another crypto asset
   - Execute → verify source reduced, destination increased
   - Both entries are `is_adjustment = true`

3. **Move flow:**
   - Open position editor → click Move icon on a position row
   - Pick destination broker/wallet
   - Execute → verify position moved, same quantity on both sides

4. **Undo flow:**
   - In activity log / history, undo a transfer entry
   - Verify BOTH legs are reversed

5. **Edge cases:**
   - Sell entire position (qty → 0) → verify soft-delete
   - Transfer to non-existing cash deposit → verify creation
   - Duplicate yahoo_ticker on inline stock creation → verify error
   - Destination failure → verify source rollback

6. **Badge verification:**
   - After a transfer, re-open the position editor
   - Verify "Xfer" badge appears (teal) instead of "Adj." (amber)

7. **S&P benchmark:**
   - Navigate to portfolio chart
   - Verify S&P line is unchanged after a transfer
   - Toggle adjustment compensation → verify transfer deltas are included

### Step 3: Update project CLAUDE.md

Add to the Key Decisions table:
```
| Transfer system as linked adjustments | Sell/buy/move are two-legged ops, both `is_adjustment=true`, linked by `transfer_group_id`. S&P benchmark unaffected. Fees implicit in delta difference. |
```

Update migration count: 44 → 45.

### Step 4: Final commit (if any fixes needed)

```bash
git add -A
git commit -m "fix: integration fixes for transfer system"
```

---

## File Summary

| Action | File |
|--------|------|
| CREATE | `supabase/migrations/045_transfer_support.sql` |
| CREATE | `src/lib/actions/transfers.ts` |
| CREATE | `src/components/ui/transfer-dialog.tsx` |
| MODIFY | `src/lib/types.ts` |
| MODIFY | `src/lib/actions/activity-log.ts` |
| MODIFY | `src/lib/actions/stocks.ts` |
| MODIFY | `src/lib/actions/crypto.ts` |
| MODIFY | `src/lib/actions/exchange-deposits.ts` |
| MODIFY | `src/lib/actions/broker-deposits.ts` |
| MODIFY | `src/lib/actions/bank-accounts.ts` |
| MODIFY | `src/lib/actions/undo.ts` |
| MODIFY | `src/components/stocks/stock-position-editor.tsx` |
| MODIFY | `src/components/crypto/position-editor.tsx` |
| MODIFY | `src/components/accounts/*.tsx` |
| MODIFY | `CLAUDE.md` |
