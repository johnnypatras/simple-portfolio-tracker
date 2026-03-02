# Buy Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the TransferDialog buy-mode stub with a guided purchase wizard that creates missing entities inline (institution, asset, cash deposit).

**Architecture:** Extend `TransferInput` to make `source` optional and add `newBroker`, `newWallet`, `newCashDeposit`. Server-side `executeTransfer()` handles inline entity creation before the transfer. Client-side buy mode in TransferDialog gets a progressive form: asset search → institution picker → cash prompt → summary.

**Tech Stack:** Next.js server actions, Supabase, React state machine, existing search APIs (`/api/stocks/search`, `/api/crypto/search`, `/api/crypto/detail`)

---

### Task 1: Make `createBroker` and `createWallet` return the created ID

These functions are currently void. The buy flow needs their IDs to set up positions and cash deposits.

**Files:**
- Modify: `src/lib/actions/brokers.ts:25-133`
- Modify: `src/lib/actions/wallets.ts:25-131`

**Step 1: Update `createBroker` return type and add return statement**

In `src/lib/actions/brokers.ts`, change the function signature to return `Promise<string>` and add `return created.id;` before the closing brace (before the `revalidatePath` calls — move return after them).

```typescript
// Line 25: change to
export async function createBroker(
  input: BrokerInput,
  opts?: {
    also_wallet?: boolean;
    wallet_type?: WalletType;
    wallet_privacy?: PrivacyLabel | null;
    wallet_chain?: string | null;
    also_bank?: boolean;
  }
): Promise<string> {
  // ... existing body ...

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");

  return created!.id;  // created is from .select("*").single() above
}
```

**Step 2: Update `createWallet` return type and add return statement**

Same pattern in `src/lib/actions/wallets.ts`:

```typescript
// Line 25: change to
export async function createWallet(
  input: WalletInput,
  opts?: { also_broker?: boolean; also_bank?: boolean }
): Promise<string> {
  // ... existing body ...

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/accounts");
  if (opts?.also_bank) revalidatePath("/dashboard/cash");

  return created!.id;
}
```

**Step 3: Build to verify no callers break**

Run: `npm run build`
Expected: Clean build (existing callers ignore the return value, so no breakage)

**Step 4: Commit**

```
feat: make createBroker and createWallet return the created ID
```

---

### Task 2: Extend `TransferInput` type — optional source + new fields

**Files:**
- Modify: `src/lib/types.ts:531-540`

**Step 1: Update TransferInput interface**

```typescript
export interface TransferInput {
  mode: TransferMode;
  source?: TransferSide;        // optional now — null = skip cash for buy
  destination: TransferSide;
  newCryptoAsset?: CryptoAssetInput;
  newStockAsset?: StockAssetInput;
  newBroker?: { name: string };
  newWallet?: { name: string };
  newCashDeposit?: { amount: number; currency: string; isAdjustment: boolean };
  /** ISO date string (YYYY-MM-DD) for backdated transfers. Defaults to today. */
  effectiveDate?: string;
}
```

Key change: `source` goes from `TransferSide` to `TransferSide | undefined`.

**Step 2: Build to check for type errors**

Run: `npm run build`
Expected: Type errors in `transfers.ts` where `source` is passed to functions expecting `TransferSide`. This is expected and will be fixed in Task 3.

**Step 3: Commit**

```
feat: make source optional on TransferInput for buy mode
```

---

### Task 3: Extend `executeTransfer()` — inline entity creation + single-legged path

**Files:**
- Modify: `src/lib/actions/transfers.ts`

**Step 1: Add imports for createBroker, createWallet, deposit functions**

At the top of `transfers.ts`, add:

```typescript
import { createBroker } from "@/lib/actions/brokers";
import { createWallet } from "@/lib/actions/wallets";
import { createBankAccount } from "@/lib/actions/bank-accounts";
```

Note: `createExchangeDeposit` and `createBrokerDeposit` are already imported.

**Step 2: Add inline entity creation steps before the existing asset creation**

In `executeTransfer()`, after the authentication block and before `// Step 1: Create new assets if needed`:

```typescript
    // ── Step 0: Create inline entities (buy mode) ────────
    // Order: institution → asset → cash deposit

    // 0a: Create new broker/wallet if requested
    if (input.newBroker) {
      const brokerId = await createBroker({ name: input.newBroker.name });
      // Patch destination's brokerId if it's a stock_position or broker_deposit
      if (destination.type === "stock_position") {
        destination = { ...destination, brokerId };
      }
      // Also patch source if it's a broker_deposit (cash side)
      if (input.source?.type === "broker_deposit") {
        input = { ...input, source: { ...input.source, brokerId } };
      }
    }

    if (input.newWallet) {
      const walletId = await createWallet({
        name: input.newWallet.name,
        wallet_type: "custodial",
      });
      // Patch destination's walletId if it's a crypto_position or exchange_deposit
      if (destination.type === "crypto_position") {
        destination = { ...destination, walletId };
      }
      if (input.source?.type === "exchange_deposit") {
        input = { ...input, source: { ...input.source, walletId } };
      }
    }

    // 0b: Create new cash deposit if requested (the cash entity at the institution)
    if (input.newCashDeposit && input.source) {
      if (input.source.type === "broker_deposit") {
        await createBrokerDeposit(
          {
            broker_id: input.source.brokerId,
            currency: input.newCashDeposit.currency,
            amount: input.newCashDeposit.amount,
          },
          {
            isAdjustment: input.newCashDeposit.isAdjustment,
            effectiveDate: input.effectiveDate,
          }
        );
      } else if (input.source.type === "exchange_deposit") {
        await createExchangeDeposit(
          {
            wallet_id: input.source.walletId,
            currency: input.newCashDeposit.currency,
            amount: input.newCashDeposit.amount,
          },
          {
            isAdjustment: input.newCashDeposit.isAdjustment,
            effectiveDate: input.effectiveDate,
          }
        );
      }
    }
```

**Step 3: Guard the source-dependent steps with optional checks**

Wrap the existing Steps 2-5 (fetch source state, validate balance, fetch prices, execute source leg) in an `if (input.source)` block:

```typescript
    let originalState: SourceOriginalState | null = null;
    let prices: TransferPrices = { source: {}, destination: {} };

    if (input.source) {
      // ── Step 2: Fetch current state of source entity ────
      originalState = await fetchSourceState(supabase, input.source);

      // ── Step 3: Validate sufficient balance ─────────────
      validateSufficientBalance(input.source, originalState);

      // ── Step 4: Fetch current prices for delta calculation ──
      prices = await fetchPrices(supabase, input.source, destination);

      // ── Step 5: Execute source leg (reduce) ─────────────
      await executeSourceLeg(input.source, originalState, transferGroupId, prices.source, input.effectiveDate);
    } else {
      // Single-legged buy: fetch destination prices only
      prices = { source: {}, destination: {} };
      const destPrices = await fetchSingleSidePrices(supabase, destination);
      prices.destination = destPrices;
    }
```

For the destination leg (Step 6), the retry+rollback logic should also be guarded:

```typescript
    // ── Step 6: Execute destination leg ───────────────────
    try {
      await executeDestLeg(supabase, destination, input.source ? transferGroupId : undefined, prices.destination, input.effectiveDate);
    } catch (destErr) {
      if (input.source && originalState) {
        // Retry once, then rollback source
        try {
          await executeDestLeg(supabase, destination, transferGroupId, prices.destination, input.effectiveDate);
        } catch (retryErr) {
          try {
            await rollbackSource(input.source, originalState, transferGroupId, prices.source, input.effectiveDate);
          } catch (rollbackErr) {
            return { success: false, error: `...`, transferGroupId, partialFailure: true };
          }
          return { success: false, error: `...`, transferGroupId };
        }
      } else {
        // Single-legged: no rollback needed
        return { success: false, error: destErr instanceof Error ? destErr.message : "Failed to create position" };
      }
    }
```

Also: when `!input.source`, don't generate `transferGroupId` (or generate it but don't pass it):
```typescript
  const transferGroupId = input.source ? crypto.randomUUID() : "";
```

**Step 4: Add `fetchSingleSidePrices` helper**

Extract the destination-side price fetching from existing `fetchPrices()` into a reusable helper:

```typescript
async function fetchSingleSidePrices(
  supabase: SupabaseClient,
  side: TransferSide
): Promise<SidePrices> {
  if (side.type === "crypto_position") {
    const { data: asset } = await supabase
      .from("crypto_assets")
      .select("coingecko_id")
      .eq("id", side.assetId)
      .single();
    if (asset?.coingecko_id) {
      const priceMap = await getPrices([asset.coingecko_id]);
      const p = priceMap[asset.coingecko_id];
      if (p) return { priceUsd: p.usd, priceEur: p.eur, currency: "USD" };
    }
  }
  if (side.type === "stock_position") {
    const { data: asset } = await supabase
      .from("stock_assets")
      .select("yahoo_ticker, currency")
      .eq("id", side.assetId)
      .single();
    if (asset?.yahoo_ticker) {
      const stockPrices = await getStockPrices([asset.yahoo_ticker]);
      const sp = stockPrices[asset.yahoo_ticker];
      if (sp) return { priceNative: sp.price, currency: asset.currency ?? "USD" };
    }
  }
  return {};
}
```

**Step 5: Update `executeDestLeg` to accept optional transferGroupId**

Change the `transferGroupId` parameter to `transferGroupId: string | undefined` and thread it conditionally.

**Step 6: Build and fix any remaining type errors**

Run: `npm run build`
Fix any issues from the optional source plumbing.

**Step 7: Commit**

```
feat: extend executeTransfer for buy mode — inline entity creation and single-legged path
```

---

### Task 4: Buy mode UI — BUYING section (asset search + institution picker + quantity)

This is the largest UI task. TransferDialog's buy mode replaces the stub with a progressive form.

**Files:**
- Modify: `src/components/ui/transfer-dialog.tsx`

**Step 1: Add new state for buy mode**

```typescript
  // ── Buy mode state ──
  const [buyAssetType, setBuyAssetType] = useState<"stock" | "crypto">("stock");
  const [buySearchQuery, setBuySearchQuery] = useState("");
  const [buySearchResults, setBuySearchResults] = useState<(YahooSearchResult | CoinGeckoSearchResult)[]>([]);
  const [buySearching, setBuySearching] = useState(false);
  const [buySelectedAsset, setBuySelectedAsset] = useState<YahooSearchResult | CoinGeckoSearchResult | null>(null);
  const [buyAssetCurrency, setBuyAssetCurrency] = useState("USD");
  const [buyLocationId, setBuyLocationId] = useState("");
  const [buyNewLocationName, setBuyNewLocationName] = useState("");
  const [buyCreatingNewLocation, setBuyCreatingNewLocation] = useState(false);
  const [buyQuantity, setBuyQuantity] = useState("");
  const [buyValue, setBuyValue] = useState<number | null>(null);
  // Crypto-specific
  const [buyDetectingChain, setBuyDetectingChain] = useState(false);
  const [buyDetectedChain, setBuyDetectedChain] = useState<string | null>(null);
  const [buyDetectedSubcategory, setBuyDetectedSubcategory] = useState<string | null>(null);
```

**Step 2: Add new state for PAYING WITH section**

```typescript
  // ── Cash tracking state ──
  type CashState = "auto" | "prompt" | "skipped";
  const [cashState, setCashState] = useState<CashState>("auto");
  const [cashBalance, setCashBalance] = useState("");
  const [cashIsAdjustment, setCashIsAdjustment] = useState(true);
  const [existingCashDeposit, setExistingCashDeposit] = useState<{ id: string; amount: number } | null>(null);
```

**Step 3: Add debounced search effect for buy mode**

```typescript
  const buyDebounceRef = useRef<NodeJS.Timeout>(null);

  useEffect(() => {
    if (mode !== "buy" || buySearchQuery.length < 2) {
      setBuySearchResults([]);
      return;
    }
    setBuySearching(true);
    if (buyDebounceRef.current) clearTimeout(buyDebounceRef.current);

    buyDebounceRef.current = setTimeout(async () => {
      try {
        const endpoint = buyAssetType === "stock"
          ? `/api/stocks/search?q=${encodeURIComponent(buySearchQuery)}`
          : `/api/crypto/search?q=${encodeURIComponent(buySearchQuery)}`;
        const res = await fetch(endpoint);
        const data = await res.json();
        setBuySearchResults(data);
      } catch {
        setBuySearchResults([]);
      } finally {
        setBuySearching(false);
      }
    }, 350);

    return () => { if (buyDebounceRef.current) clearTimeout(buyDebounceRef.current); };
  }, [buySearchQuery, buyAssetType, mode]);
```

**Step 4: Add `handleBuyAssetSelect` callback**

When user picks a search result:
- Set `buySelectedAsset`
- Auto-fill `buyAssetCurrency`
- For crypto: fire `/api/crypto/detail` for chain/subcategory detection
- Check if asset already exists in portfolio (match by yahoo_ticker or coingecko_id)

```typescript
  const handleBuyAssetSelect = useCallback(async (result: YahooSearchResult | CoinGeckoSearchResult) => {
    setBuySelectedAsset(result);
    setBuySearchQuery("");
    setBuySearchResults([]);

    if (buyAssetType === "stock") {
      const r = result as YahooSearchResult;
      setBuyAssetCurrency(r.currency ?? "USD");
    } else {
      const r = result as CoinGeckoSearchResult;
      setBuyAssetCurrency("USD"); // crypto always USD
      // Auto-detect chain
      setBuyDetectingChain(true);
      try {
        const res = await fetch(`/api/crypto/detail?id=${encodeURIComponent(r.id)}`);
        if (res.ok) {
          const detail = await res.json();
          setBuyDetectedChain(detail.chain ?? null);
          setBuyDetectedSubcategory(detail.subcategory ?? null);
        }
      } catch { /* ignore */ }
      setBuyDetectingChain(false);
    }
  }, [buyAssetType]);
```

**Step 5: Add cash auto-detection effect**

When `buyLocationId` changes, check if a matching cash deposit exists at that institution in the asset's currency:

```typescript
  useEffect(() => {
    if (mode !== "buy" || !buyLocationId || buyCreatingNewLocation) {
      setExistingCashDeposit(null);
      setCashState("prompt");
      return;
    }
    // Check for existing cash deposit matching asset currency
    if (buyAssetType === "stock") {
      const deposit = brokerDeposits.find(
        (d) => d.broker_id === buyLocationId && d.currency === buyAssetCurrency
      );
      if (deposit) {
        setExistingCashDeposit({ id: deposit.id, amount: deposit.amount });
        setCashState("auto");
      } else {
        setExistingCashDeposit(null);
        setCashState("prompt");
      }
    } else {
      const deposit = exchangeDeposits.find(
        (d) => d.wallet_id === buyLocationId && d.currency === buyAssetCurrency
      );
      if (deposit) {
        setExistingCashDeposit({ id: deposit.id, amount: deposit.amount });
        setCashState("auto");
      } else {
        setExistingCashDeposit(null);
        setCashState("prompt");
      }
    }
  }, [buyLocationId, buyAssetCurrency, buyAssetType, brokerDeposits, exchangeDeposits, mode, buyCreatingNewLocation]);
```

**Step 6: Render BUYING section**

Replace the existing buy mode stub `<p>Select the source of funds...</p>` with the full buy form. The BUYING section renders:
- Stock/Crypto tabs (similar to existing `DEST_TABS` pattern)
- Search input with debounced results dropdown
- When asset selected: show ticker + name + currency
- Location picker dropdown (brokers for stock, custodial wallets for crypto) with "+ Create new" option
- Quantity input
- Auto-calculated value display

**Step 7: Render PAYING WITH section**

Below the arrow divider, render the conditional cash section based on `cashState`:
- `auto`: Show existing deposit balance and projected after-buy balance
- `prompt`: Amber info about no cash tracked, balance input + adjustment checkbox + "Skip" link
- `skipped`: Collapsed grey text "Cash not tracked"

**Step 8: Render SUMMARY section**

Above the submit button, show a compact read-only summary:
- Buy line: `Buy {qty} × {ticker} at {institution}` + value
- Cash line: `{currency}@{institution} {before} → {after}` (hidden if skipped)
- Date line
- Creating line: list entities being created (hidden if none)
- Fee line: shown if manually edited amount ≠ calculated value

**Step 9: Update `handleExecute` for buy mode**

Replace the buy stub with actual execution:

```typescript
    if (mode === "buy") {
      if (!buySelectedAsset) { setError("Select an asset"); return; }
      const qty = parseFloat(buyQuantity);
      if (isNaN(qty) || qty <= 0) { setError("Enter a valid quantity"); return; }

      // Determine if asset is new or existing
      let existingAssetId: string | null = null;
      let newAsset: StockAssetInput | CryptoAssetInput | undefined;

      if (buyAssetType === "stock") {
        const r = buySelectedAsset as YahooSearchResult;
        const existing = stockAssets.find((a) => a.yahoo_ticker === r.symbol);
        if (existing) {
          existingAssetId = existing.id;
        } else {
          newAsset = {
            ticker: extractBaseTicker(r.symbol),
            name: r.longname || r.shortname,
            yahoo_ticker: r.symbol,
            currency: r.currency ?? "USD",
            category: inferCategory(r.quoteType),
          } as StockAssetInput;
        }
      } else {
        const r = buySelectedAsset as CoinGeckoSearchResult;
        const existing = cryptoAssets.find((a) => a.coingecko_id === r.id);
        if (existing) {
          existingAssetId = existing.id;
        } else {
          newAsset = {
            ticker: r.symbol.toUpperCase(),
            name: r.name,
            coingecko_id: r.id,
            chain: buyDetectedChain,
            subcategory: buyDetectedSubcategory,
            image_url: r.large ?? r.thumb ?? null,
          } as CryptoAssetInput;
        }
      }

      // Build destination
      const locationId = buyCreatingNewLocation ? "PENDING" : buyLocationId;
      const destination: TransferSide = buyAssetType === "stock"
        ? { type: "stock_position", assetId: existingAssetId ?? "PENDING", brokerId: locationId, quantity: qty }
        : { type: "crypto_position", assetId: existingAssetId ?? "PENDING", walletId: locationId, quantity: qty };

      // Build source (cash side) — null if skipped
      let source: TransferSide | undefined;
      if (cashState !== "skipped") {
        if (buyAssetType === "stock") {
          source = { type: "broker_deposit", brokerId: locationId, currency: buyAssetCurrency, amount: buyValue ?? 0 };
        } else {
          source = { type: "exchange_deposit", walletId: locationId, currency: buyAssetCurrency, amount: buyValue ?? 0 };
        }
      }

      const input: TransferInput = {
        mode: "buy",
        source,
        destination,
        newStockAsset: buyAssetType === "stock" && newAsset ? newAsset as StockAssetInput : undefined,
        newCryptoAsset: buyAssetType === "crypto" && newAsset ? newAsset as CryptoAssetInput : undefined,
        newBroker: buyAssetType === "stock" && buyCreatingNewLocation ? { name: buyNewLocationName } : undefined,
        newWallet: buyAssetType === "crypto" && buyCreatingNewLocation ? { name: buyNewLocationName } : undefined,
        newCashDeposit: cashState === "prompt" && cashBalance
          ? { amount: parseFloat(cashBalance), currency: buyAssetCurrency, isAdjustment: cashIsAdjustment }
          : undefined,
        effectiveDate: effectiveDate || undefined,
      };

      setExecuting(true);
      try {
        const result = await executeTransfer(input);
        if (result.success) {
          toast.success(`Recorded purchase of ${buyQuantity} ${buySelectedAsset ? ('symbol' in buySelectedAsset ? buySelectedAsset.symbol : buySelectedAsset.symbol) : 'asset'}`);
          onSuccess?.();
          onClose();
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Purchase failed");
      } finally {
        setExecuting(false);
      }
      return;
    }
```

**Step 10: Update `canSubmit` for buy mode**

```typescript
  const canSubmit = useMemo(() => {
    if (executing) return false;
    if (mode === "buy") {
      if (!buySelectedAsset) return false;
      const qty = parseFloat(buyQuantity);
      if (isNaN(qty) || qty <= 0) return false;
      if (!buyLocationId && !buyCreatingNewLocation) return false;
      if (buyCreatingNewLocation && !buyNewLocationName.trim()) return false;
      // Cash: must have deposit info or be skipped
      if (cashState === "prompt" && !cashBalance) return false;
      return true;
    }
    return buildSource() !== null && buildDest() !== null;
  }, [executing, mode, buySelectedAsset, buyQuantity, buyLocationId,
      buyCreatingNewLocation, buyNewLocationName, cashState, cashBalance,
      buildSource, buildDest]);
```

**Step 11: Update dialog title for buy mode**

Change title logic for buy mode when no prefilled asset:
```typescript
  const title = useMemo(() => {
    if (mode === "buy") {
      if (prefilled?.assetTicker) return `Buy ${prefilled.assetTicker}`;
      if (buySelectedAsset) {
        const symbol = 'symbol' in buySelectedAsset ? buySelectedAsset.symbol : buySelectedAsset.symbol;
        return `Buy ${symbol}`;
      }
      return "Record Buy";
    }
    const name = prefilled?.assetTicker ?? "Asset";
    switch (mode) {
      case "sell": return `Sell ${name}`;
      case "move": return `Move ${name}`;
    }
  }, [mode, prefilled?.assetTicker, buySelectedAsset]);
```

**Step 12: Add imports**

Add to the top of transfer-dialog.tsx:
```typescript
import type { YahooSearchResult, CoinGeckoSearchResult } from "@/lib/types";
```

Also import the helper functions from add-stock-modal (or inline them):
- `extractBaseTicker` — extract base ticker from Yahoo symbol
- `inferCategory` — infer asset category from quoteType

Since these are small pure functions, inline them or copy them.

**Step 13: Reset buy state on dialog open**

In the existing reset useEffect, add:
```typescript
    setBuyAssetType("stock");
    setBuySearchQuery("");
    setBuySearchResults([]);
    setBuySelectedAsset(null);
    setBuyAssetCurrency("USD");
    setBuyLocationId("");
    setBuyNewLocationName("");
    setBuyCreatingNewLocation(false);
    setBuyQuantity("");
    setBuyValue(null);
    setBuyDetectingChain(false);
    setBuyDetectedChain(null);
    setBuyDetectedSubcategory(null);
    setCashState("auto");
    setCashBalance("");
    setCashIsAdjustment(true);
    setExistingCashDeposit(null);
```

**Step 14: Auto-calculate buy value**

```typescript
  useEffect(() => {
    if (mode !== "buy") return;
    const qty = parseFloat(buyQuantity);
    if (isNaN(qty) || qty <= 0 || !buySelectedAsset) {
      setBuyValue(null);
      return;
    }
    if (buyAssetType === "stock") {
      const r = buySelectedAsset as YahooSearchResult;
      if (r.price) setBuyValue(qty * r.price);
    } else {
      // Crypto price comes from search result if available
      const r = buySelectedAsset as CoinGeckoSearchResult;
      // CoinGecko search doesn't include price — leave null, user enters manually
      setBuyValue(null);
    }
  }, [buyQuantity, buySelectedAsset, buyAssetType, mode]);
```

**Step 15: Update submit button text for buy mode**

```typescript
{mode === "buy" ? "Record Purchase" : "Execute Transfer"}
```

**Step 16: Build and fix any issues**

Run: `npm run build`

**Step 17: Commit**

```
feat: implement buy mode UI in TransferDialog
```

---

### Task 5: Add "Record Buy" entry points on stock-table and crypto-table

**Files:**
- Modify: `src/components/stocks/stock-table.tsx`
- Modify: `src/components/crypto/crypto-table.tsx`

**Step 1: Add buy mode state to stock-table**

In `stock-table.tsx`, add state:
```typescript
const [buyOpen, setBuyOpen] = useState(false);
```

**Step 2: Add "Record Buy" button next to existing "+ Add" button**

In the desktop button area (~line 518), add after the existing "+ Add" button:
```typescript
<button
  onClick={() => setBuyOpen(true)}
  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors"
>
  <TrendingUp className="w-3.5 h-3.5" />
  Record Buy
</button>
```

Also in the mobile toolbar area (~line 503), add a similar compact button.

**Step 3: Add TransferDialog for buy mode**

After the existing AddStockModal in the modals section (~line 1228):
```typescript
<TransferDialog
  open={buyOpen}
  onClose={() => setBuyOpen(false)}
  onSuccess={() => { router.refresh(); setBuyOpen(false); }}
  mode="buy"
/>
```

Import `TransferDialog` and `useRouter`.

**Step 4: Repeat for crypto-table**

Same pattern: add `buyOpen` state, "Record Buy" button, `TransferDialog` with `mode="buy"`.

**Step 5: Build**

Run: `npm run build`

**Step 6: Commit**

```
feat: add Record Buy entry points to stock and crypto tables
```

---

### Task 6: Build verification and edge case testing

**Files:** None (verification only)

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 2: Manual verification checklist**

- [ ] Open stock table → "Record Buy" button visible
- [ ] Click "Record Buy" → TransferDialog opens in buy mode
- [ ] Search for a stock → results appear
- [ ] Select stock → auto-fills ticker, name, currency
- [ ] Select existing broker → if cash exists, auto-selects; if not, prompts
- [ ] Create new broker → inline name field appears
- [ ] Enter quantity → value auto-calculates (if stock has price)
- [ ] Skip cash → summary shows "Cash not tracked"
- [ ] Enter cash balance → summary shows before→after
- [ ] Submit → position created, cash updated
- [ ] Same flow for crypto
- [ ] Backdated buy (pick past date) → activity log has correct date

**Step 3: Commit any fixes**

```
fix: buy mode edge cases
```

---

## Files Modified / Created Summary

| File | Change |
|------|--------|
| `src/lib/actions/brokers.ts` | `createBroker` returns `Promise<string>` |
| `src/lib/actions/wallets.ts` | `createWallet` returns `Promise<string>` |
| `src/lib/types.ts` | `TransferInput.source` optional, add `newBroker`, `newWallet`, `newCashDeposit` |
| `src/lib/actions/transfers.ts` | Inline entity creation, optional source, single-legged path, `fetchSingleSidePrices` |
| `src/components/ui/transfer-dialog.tsx` | Full buy mode UI (search, location, cash, summary) |
| `src/components/stocks/stock-table.tsx` | "Record Buy" button + TransferDialog |
| `src/components/crypto/crypto-table.tsx` | "Record Buy" button + TransferDialog |

## Design Reference

See `docs/plans/2026-03-02-buy-mode-design.md` for the full design document with scenario matrix, UI mockup, and deferred items.
