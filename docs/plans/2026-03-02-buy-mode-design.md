# Buy Mode — Design Document

## Problem
The transfer system requires all entities (institution, asset, cash) to pre-exist before recording
a buy. On a fresh or incomplete portfolio, the user must visit 3 separate pages (Settings → Stocks/Crypto → Accounts)
before they can record a simple purchase. Buy mode in TransferDialog is currently a stub.

## Solution
Extend TransferDialog's buy mode into a **guided progressive form** that creates missing entities
inline. The user describes what they bought, and the system figures out what needs creating.

Cash tracking is prompted but **skippable** — if skipped, the buy degrades to a simple position
creation (no transfer, no cash side).

## Architecture: Progressive Single-Page Buy

The dialog keeps the existing FROM/TO layout but reframes it for buy context:
- **BUYING** section (destination): asset search + institution picker + quantity
- **PAYING WITH** section (source): cash at that institution (auto-detected or prompted)
- **SUMMARY** section: compact overview before final submission

---

## 1. Buy Flow

### Layout

```
┌─ Record Buy ──────────────────────────────────┐
│                                                │
│  BUYING                                        │
│  ┌────────────────────────────────────────┐    │
│  │ [🔍 Search stocks or crypto...      ] │    │
│  │ → VWCE.DE — Vanguard FTSE All-World   │    │
│  │ Location: [DEGIRO ▼] [+ Create new]   │    │
│  │ Quantity: [10________]                │    │
│  │ Value: €1,200.00                      │    │
│  └────────────────────────────────────────┘    │
│                                                │
│  PAYING WITH                                   │
│  ┌────────────────────────────────────────┐    │
│  │ 💡 No EUR cash tracked at DEGIRO.      │    │
│  │ Current balance at DEGIRO? [5,000___] │    │
│  │ ☑ Portfolio adjustment (existing $)   │    │
│  │                    [Skip cash tracking]│    │
│  └────────────────────────────────────────┘    │
│                                                │
│  Date: [2026-02-15]                            │
│                                                │
│  ┌─ Summary ─────────────────────────────┐    │
│  │ Buy 10 × VWCE.DE at DEGIRO  €1,200   │    │
│  │ Cash: EUR@DEGIRO €5,000 → €3,800     │    │
│  │ Date: 2026-02-15                      │    │
│  │ Creating: DEGIRO (broker), VWCE (asset)│   │
│  │ Fee: -€20.00                          │    │
│  └────────────────────────────────────────┘    │
│                                                │
│  [Cancel]                  [Record Purchase]   │
└────────────────────────────────────────────────┘
```

### BUYING section

- **Asset picker**: tabs for Stock / Crypto
  - Existing assets in portfolio shown in dropdown
  - Search input queries `/api/stocks/search` or `/api/crypto/search`
  - Selecting a search result auto-fills ticker, name, currency
  - For crypto: background call to `/api/crypto/detail` for chain/subcategory auto-detection
- **Location picker**: dropdown of brokers (stocks) or wallets (crypto)
  - "+ Create new" option at bottom → expands inline name field
  - Creates broker (stocks) or custodial wallet (crypto) with minimal fields (name only)
  - Chain/privacy for wallets deferred — user edits in Settings later
- **Quantity**: number input
- **Value**: auto-calculated from `quantity × currentPrice`, read-only display

### PAYING WITH section (conditional)

Three states based on what exists:

| State | What shows |
|-------|-----------|
| Cash deposit exists (sufficient) | Auto-selected. Shows: "EUR at DEGIRO: €5,000 → €3,800" |
| Cash deposit exists (insufficient) | Auto-selected. Shows balance. Transfer will fail with "insufficient balance" on submit. |
| No cash deposit at institution | Amber info: "No EUR cash tracked at [institution]." Balance input + adjustment checkbox + "Skip cash tracking" link |
| User skipped | Section collapsed, greyed out text: "Cash not tracked" |

**Currency matching**: auto-detects from asset currency (EUR stock → look for EUR deposit).

**Adjustment checkbox**: default checked (catch-up scenario — "this money was already there").
Unchecked = real deposit (S&P benchmark tracks it as new money entering portfolio).

### SUMMARY section

Compact read-only overview shown above the submit button:
- What: `Buy {qty} × {ticker} at {institution}` + value
- Cash: `{currency}@{institution} {before} → {after}` (hidden if cash skipped)
- Date: selected date
- Creating: list of entities being created (hidden if none)
- Fee: shown only when cash amount ≠ position value (amber text)

### Date picker

Existing `effectiveDate` date input (already implemented). Defaults to today, max=today.

---

## 2. Inline Entity Creation

### Institution (broker/wallet)

- Triggered by selecting "+ Create new" in location dropdown
- Minimal form: name field only
- Stocks → `createBroker({ name })`
- Crypto → `createWallet({ name, wallet_type: "custodial" })`
- Created before transfer execution (needs ID for position + cash)
- Chains, privacy, roles → user edits later in Settings

### Asset (stock/crypto)

- Triggered when user selects a search result not in their portfolio
- Stock: auto-fills from Yahoo search → `StockAssetInput { ticker, name, yahoo_ticker, currency, category }`
- Crypto: auto-fills from CoinGecko search + detail call → `CryptoAssetInput { ticker, name, coingecko_id, chain, subcategory, image_url }`
- Uses existing `newStockAsset` / `newCryptoAsset` on `TransferInput`

### Cash deposit

- Triggered when user fills in balance (doesn't skip)
- Creates `broker_deposit` (stocks) or `exchange_deposit` (crypto)
- Amount = user-entered balance
- `is_adjustment` = checkbox state
- Uses `effectiveDate` for the activity log entry
- Created before transfer deducts from it

### Execution order

1. Create institution (if `newBroker`/`newWallet`) → get ID
2. Patch destination's `brokerId`/`walletId` with new ID
3. Create asset (if `newStockAsset`/`newCryptoAsset`) → get ID
4. Patch destination's `assetId` with new ID
5. Create cash deposit (if `newCashDeposit`) at institution
6. If source exists → normal two-legged transfer
7. If no source (skipped cash) → single-legged position creation

---

## 3. Server-Side Changes

### `TransferInput` additions

```typescript
interface TransferInput {
  mode: TransferMode;
  source?: TransferSide;        // optional now (null = skip cash for buy)
  destination: TransferSide;
  newCryptoAsset?: CryptoAssetInput;
  newStockAsset?: StockAssetInput;
  newBroker?: { name: string };
  newWallet?: { name: string };
  newCashDeposit?: { amount: number; currency: string; isAdjustment: boolean };
  effectiveDate?: string;
}
```

### `executeTransfer()` changes

- `source` becomes optional (currently required)
- New pre-transfer steps: create institution → create asset → create cash deposit
- Patch destination IDs from newly created entities
- When `source` is null: skip source leg, skip rollback logic, no `transfer_group_id`
- Single-legged buy calls CRUD directly with `isAdjustment` from input

### Single-legged buy path

When `source` is omitted:
- No `transferGroupId` generated (not a transfer)
- Just `upsertStockPosition()` or `upsertPosition()` with `effectiveDate`
- `isAdjustment` passed from input (user's checkbox choice)
- No paired undo needed (simple single-entry undo)
- Activity log shows "created" not "transferred"

---

## 4. Entry Points

### New: "Record Buy" on dashboard tables

- Stock table header: new button next to "+ Add"
- Crypto table header: same pattern
- Icon: `TrendingUp`
- Opens TransferDialog in `mode="buy"` with no pre-fills
- Asset search in dialog lets user pick existing or search for new

### Existing (unchanged)

- Position editor "Buy" button → buy mode, asset pre-filled as destination
- Position editor "Sell" button → sell mode, asset pre-filled as source
- Position editor "Move" button → move mode
- Accounts page transfer button → sell mode, no pre-fills

---

## 5. Scenarios Covered

| # | Institution | Asset | Cash | Behavior |
|---|-------------|-------|------|----------|
| 1 | Exists | Exists | Exists (sufficient) | Normal two-legged transfer |
| 2 | Exists | Exists | Exists (insufficient) | Fails "insufficient balance" |
| 3 | Exists | Exists | None | Prompt cash or skip → two-leg or single-leg |
| 4 | Exists | New | Exists | Create asset → two-legged transfer |
| 5 | Exists | New | None | Create asset → prompt cash or skip |
| 6 | New | New | None | Create institution → create asset → prompt cash or skip |
| 7 | New | Exists | None | Create institution → prompt cash or skip |

---

## Decisions Made

| Decision | Why |
|----------|-----|
| Progressive single-page over multi-step wizard | Familiar FROM/TO layout, fewer clicks, no new UI patterns |
| Cash tracking prompted but skippable | Captures data when users want it, doesn't block recording a position |
| Skip cash = simple position creation | Identical to existing add-stock flow, no fabricated entities |
| Cash import uses adjustment checkbox | User decides: catch-up (adjustment, S&P ignores) vs real deposit (S&P tracks) |
| Minimal institution creation (name only) | Reduces friction; chains/privacy edited later in Settings |
| Crypto auto-detect chain/subcategory | Matches existing add-crypto modal behavior, ~1s background call |
| Summary before submit | Quick review of what will be created/modified before committing |
| source becomes optional on TransferInput | Enables single-legged buys without special casing the type system |

## Deferred

| What | Why |
|------|-----|
| Insufficient cash handling (auto-update prompt) | Edge case — user updates cash in Accounts page. v2 enhancement. |
| Cross-institution cash source (buy at DEGIRO, pay from Alpha Bank) | Two separate operations: bank→broker transfer, then buy |
| Inline wallet chain/privacy selection | Minimal friction; user edits later |
| Self-custody wallet creation from buy flow | Only custodial exchange wallets created inline |

## Files Modified / Created

### Modified files
- `src/components/ui/transfer-dialog.tsx` — buy mode implementation (search, inline creation, cash prompt, summary)
- `src/lib/actions/transfers.ts` — optional source, inline entity creation, single-legged path
- `src/lib/types.ts` — TransferInput additions (newBroker, newWallet, newCashDeposit, optional source)
- `src/components/stocks/stock-table.tsx` — "Record Buy" button
- `src/components/crypto/crypto-table.tsx` — "Record Buy" button

### Reused (no changes needed)
- `/api/stocks/search` — stock search API
- `/api/crypto/search` — crypto search API
- `/api/crypto/detail` — chain/subcategory detection
- `src/lib/actions/stocks.ts` — `createStockAsset()`, `upsertStockPosition()`
- `src/lib/actions/crypto.ts` — `createCryptoAsset()`, `upsertPosition()`
- `src/lib/actions/brokers.ts` — `createBroker()`
- `src/lib/actions/wallets.ts` — `createWallet()`
- `src/lib/actions/exchange-deposits.ts` — `createExchangeDeposit()`
- `src/lib/actions/broker-deposits.ts` — `createBrokerDeposit()`
