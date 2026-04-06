# Multi-Chain Crypto Asset Support

## Problem
The current unique constraint `(user_id, coingecko_id) WHERE deleted_at IS NULL` allows only one asset per coin per user. Users cannot track the same coin (e.g., ETH) on multiple chains (e.g., Linea, Arbitrum, Ethereum mainnet) separately.

## Proposed Change
Allow multiple rows with the same `coingecko_id` per user, distinguished by `chain`.

New constraint: `(user_id, coingecko_id, COALESCE(chain, '')) WHERE deleted_at IS NULL`

## Impact Analysis

### Works as-is (22 areas)
Aggregation, prices (CoinGecko returns one price per coin regardless of chain), snapshots, charts, Edge Function, undo, splits, transfers (use `crypto_asset_id` not `coingecko_id`), exports (CSV includes chain), activity log, backfill, shared portfolio, dashboard insights (merges by ticker — correct), comparison (merges by coin — correct), position editor, delete/update by ID, all API routes, all page-level coinIds construction.

### Breaks (2 areas)
1. `createCryptoAsset` 23505 fallback — queries `.single()` by `coingecko_id` only
2. Import merge dedup — Map keyed by `coingecko_id` only (last-write-wins)

### Needs change (3 areas)
3. Transfer dialog buy-mode — `find()` by `coingecko_id` matches first chain
4. `updateCryptoAsset` — no friendly error when changing chain to occupied value
5. Integration tests — need multi-chain scenarios

### UX improvements (2 areas)
6. Command palette — duplicate entries for same coin on different chains
7. Add-crypto-modal — no indication same coin exists on another chain

## Implementation Steps

### Step 1: Migration
Create migration `012_multi_chain_crypto.sql`:
```sql
-- Allow same coingecko_id on different chains for the same user
DROP INDEX IF EXISTS "uq_crypto_assets_active";
CREATE UNIQUE INDEX "uq_crypto_assets_active" ON "public"."crypto_assets"
  USING btree ("user_id", "coingecko_id", COALESCE("chain", ''))
  WHERE ("deleted_at" IS NULL);
```

### Step 2: Fix createCryptoAsset 23505 fallback
File: `src/lib/actions/crypto.ts`, lines ~109-114

Current:
```ts
.eq("coingecko_id", input.coingecko_id)
.is("deleted_at", null)
.single()
```

Fix: Add chain filter to match the new constraint:
```ts
.eq("coingecko_id", input.coingecko_id)
.eq("chain", input.chain ?? null)
.is("deleted_at", null)
.single()
```

Note: Supabase `.eq("chain", null)` does NOT match `IS NULL`. Need to use `.is("chain", null)` when chain is null, or `.eq("chain", chain)` when chain has a value. Use conditional:
```ts
const q = supabase.from("crypto_assets").select("id")
  .eq("user_id", user.id)
  .eq("coingecko_id", input.coingecko_id)
  .is("deleted_at", null);
if (input.chain) q.eq("chain", input.chain);
else q.is("chain", null);
const { data: existing } = await q.single();
```

### Step 3: Fix import merge dedup
File: `src/lib/actions/import.ts`, lines ~484-493

Current:
```ts
existingCryptoMap.set(c.coingecko_id, c.id);
// lookup:
existingCryptoMap.get(asset.coingecko_id)
```

Fix: Include chain in the map key and the SELECT:
```ts
// Fetch chain too
const { data: existingCrypto } = await supabase
  .from("crypto_assets")
  .select("id, coingecko_id, chain")
  .eq("user_id", uid)
  .is("deleted_at", null);
for (const c of existingCrypto ?? []) {
  existingCryptoMap.set(`${c.coingecko_id}|${c.chain ?? ''}`, c.id);
}

// Lookup:
const existingId = isReplace ? null : (existingCryptoMap.get(`${asset.coingecko_id}|${asset.chain ?? ''}`) ?? null);
```

### Step 4: Fix transfer dialog buy-mode
File: `src/components/ui/transfer-dialog.tsx`, lines ~709 and ~1356

Two locations use `coingecko_id`-only matching:

**Location A (line ~709)** — existingAssetId lookup:
```ts
const existing = cryptoAssets.find((a) => a.coingecko_id === r.id);
```

**Location B (line ~1356)** — "Creating:" label check:
```ts
!cryptoAssets.find((a) => a.coingecko_id === (buySelectedAsset as CoinGeckoSearchResult).id)
```

Fix both: Also match chain. `buyDetectedChain` already exists in the dialog state. If a chain is specified, prefer an exact match; otherwise match any:
```ts
const existing = cryptoAssets.find((a) =>
  a.coingecko_id === r.id &&
  (buyDetectedChain == null || a.chain === buyDetectedChain || a.chain == null)
);
```

### Step 5: Friendly error on chain collision in updateCryptoAsset
File: `src/lib/actions/crypto.ts`, in updateCryptoAsset

When the user changes the chain of an asset to a value that already exists for the same `coingecko_id`, the DB will reject with 23505. Catch this and return a friendly error:
```ts
if (error?.code === "23505") {
  throw new Error(`You already have ${ticker} on the "${fields.chain}" chain. Use the existing entry instead.`);
}
```

### Step 6: Command palette chain labels
File: `src/lib/portfolio/holdings.ts`, lines ~38-58

When building `HoldingItem` entries, check if multiple assets share the same `coingecko_id`. If so, append the chain to the name:
```ts
// Pre-compute which coingecko_ids have multiple chains
const chainCounts = new Map<string, number>();
for (const a of cryptoAssets) {
  chainCounts.set(a.coingecko_id, (chainCounts.get(a.coingecko_id) ?? 0) + 1);
}

// In the mapping:
const needsChainLabel = (chainCounts.get(a.coingecko_id) ?? 0) > 1;
return {
  name: needsChainLabel && a.chain ? `${a.name} (${a.chain})` : a.name,
  // ...
};
```

Note: `crypto-columns.tsx` already shows chain per-row in its own column (line ~551), so no change needed there. `accounts-view.tsx` groups by wallet, not by asset name, so no change needed there either.

### Step 7: Add-crypto-modal chain awareness
File: `src/components/crypto/add-crypto-modal.tsx`

When the user selects a coin from search results, check if it already exists in their portfolio. If it exists on a different chain, show an informational message:
```
"You already have ETH on Ethereum mainnet. Adding on Linea will create a separate entry."
```

This is purely informational — don't block the action.

Note: Requires threading `existingAssets` (or a simplified `{coingecko_id, chain}[]`) as a new prop from `crypto-table.tsx` → `add-crypto-modal.tsx`.

### Step 8: Integration tests
File: `__tests__/integration/crypto-actions.test.ts`

Add test cases:
- Creating same `coingecko_id` with different chains succeeds and returns different IDs
- Creating same `coingecko_id` with same chain returns existing ID (dedup)
- Deleting one chain's asset doesn't affect the other chain's asset
- Positions on different chain assets are independent

File: `__tests__/integration/import-constraints.test.ts`

Add test case:
- Merge import with multi-chain assets maps positions to correct chain-specific asset

## Out of scope (separate follow-up)

### Transfer destination wallet filtering
Currently, move mode shows ALL wallets as destinations regardless of asset type compatibility (e.g., MetaMask shows for BTC moves). This is a UX improvement unrelated to the data model change. Should be done separately to keep this PR focused.

## Risk assessment
- **Low risk**: 22 of 29 code paths work as-is
- **No data migration needed**: existing data has `chain = null`, which is valid under the new constraint
- **Backward compatible**: existing imports/exports include chain field already
- **Price accuracy**: unaffected — CoinGecko returns one price per coin regardless of chain
