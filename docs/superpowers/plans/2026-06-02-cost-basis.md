# Cost Basis & Realized/Unrealized P&L — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user record/edit the actual amount paid (incl. fees) + date on every transaction (existing & new), classify income as Yield (cost €0, benchmark-excluded), and show accurate average-cost / realized / unrealized P&L plus a corrected S&P benchmark — without disturbing the market-priced value line.

**Architecture:** A thin, mostly-additive layer over the existing `activity_log`. Two new boolean columns; one pure average-cost engine (`cost-basis.ts`); two pure classifier helpers; a per-asset Transactions drawer with a guided, self-explanatory type-selector modal; the backdate-recompute fix; and a cost-basis chart overlay. EUR (base currency) is authoritative for headline P&L. All numbers are computed read-time, so old and new rows flow through identical code.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript · Supabase (Postgres + RLS) · Recharts · Vitest (unit/component/integration). Branch `feat/cost-basis`, stacked on `feat/historical-prices-chart` (#94). Spec: `docs/superpowers/specs/2026-06-02-cost-basis-design.md`.

**Two cross-cutting requirements (apply to EVERY UI task — do not treat as optional):**
- **UI-LOCKDOWN CHECK:** for each control, enumerate its disabled/blocked/dead-end states and prove there is always a clear way out (never a trap). Each UI task lists its lockdown matrix; tests assert the disabled/blocked states render a reason, not a silent dead control.
- **EXPLANATORY COPY:** every tickbox/button/type-option carries simple, accurate helper text describing what it does and what will happen. The verbatim strings live in `src/lib/cost-basis-copy.ts` (Task 2.0) so they're tested once and reused; components import them.

---

## File Structure (all phases)

**New files**
- `supabase/migrations/021_transaction_cost_basis.sql` — `is_yield` + `cashflow_user_set` columns.
- `src/lib/transaction-kind.ts` — pure `classifyTransaction(row)` + `TransactionKind` type + `quantityDelta(row)`.
- `src/lib/cost-basis-copy.ts` — all verbatim UI helper strings (type guidance, tooltips, lockdown reasons).
- `src/lib/portfolio/cost-basis.ts` — pure `computeCostBasis(txnsAsc, currentValue)` engine + `costBasisSeries()` for the overlay.
- `src/lib/actions/transactions.ts` — `addTransaction` / `editTransaction` / `markAsYield` server actions (ownership-verified).
- `src/components/transactions/transactions-drawer.tsx` — per-asset drawer (list, grouping, filter, multi-select).
- `src/components/transactions/transaction-modal.tsx` — Add/Edit modal with the type selector + guidance.
- `__tests__/unit/transaction-kind.test.ts`, `__tests__/unit/cost-basis.test.ts`, `__tests__/unit/cost-basis-backdate.test.ts`
- `__tests__/component/transaction-modal.test.tsx`, `__tests__/component/transactions-drawer.test.tsx`
- `__tests__/integration/transactions.test.ts`, `__tests__/integration/cost-basis-benchmark.test.ts`

**Modified files**
- `src/types/database.ts` — regenerated after the migration (CI drift-checked).
- `src/lib/actions/activity-log.ts` — `logActivity`'s inline params already accept `cashflow_amount_*`/`cashflow_status`; add `is_yield`, `cashflow_user_set` passthrough (there is **no** named `CreateActivityLogParams` type).
- `src/lib/activity-fx.ts` — `amountOverride?` on `computeActivityFx` + `computeActivityFxWithConversion`; new `cashflowUserSet` on `FxResult` (`emptyFx()` defaults false).
- `src/lib/actions/crypto.ts` — `upsertPosition` accepts a `cashflowOverride` (B1).
- `src/lib/actions/stocks.ts` — `upsertStockPosition` accepts a `cashflowOverride` (B1-STOCKS; also the manual-NAV cost path).
- `src/lib/actions/cash-accounts.ts` — `CashAccountOpts` accepts a `cashflowOverride` (cash uses `computeFx`/`computeCashflow`, not `computeActivityFx`).
- `src/lib/actions/splits.ts` — `SplitLeg.cost?`; `splitActivityEntry` uses per-leg cost + stores `details.split_direction`; `backdateActivityEntry` recompute hook.
- `src/lib/actions/benchmark.ts` — `deriveCashFlows` excludes `is_yield`, uses user-authored amount; `getHistoricalBenchmarkExtension` also returns the per-class `buildCostBasisSeries` + loads the `delta` streams (C2/C3).
- `src/lib/portfolio/historical-prices-augmentation.ts` — new `buildCostBasisSeries`; split sign reads `split_direction × split_quantity` (C1, ~861-864/899-902).
- `src/lib/portfolio/chart-enrichment.ts` — `seedDisp = lookupCostAtOrBefore(costSeries, chartStart, viewMode) ?? firstSliceVal` (#94 seed re-anchor; Task 3.4).
- `src/app/dashboard/page.tsx` + `src/app/share/[token]/page.tsx` — thread the cost-basis-series prop into `PortfolioChart` (C2).
- `src/lib/portfolio/aggregate.ts` / `assemble.ts` / `shared-portfolio.ts` — thread cost-basis outputs for display.
- `src/components/history/activity-timeline.tsx` — unchanged by C1 (still renders positive `split_quantity`); listed so the implementer verifies no regression.
- `src/components/crypto/crypto-table.tsx`, `stocks/stock-table.tsx`, `cash/cash-table.tsx` — row history icon + P&L columns.
- `src/components/history/split-modal.tsx` — per-leg cost field.
- `src/components/dashboard/portfolio-chart.tsx` (or equivalent) — cost overlay line + the new cost-series prop.

---

# PHASE 1 — Data layer + cost capture + backdate-recompute fix

*Outcome: every transaction can carry a user-authored amount + the two new flags; backdating no longer leaves a stale benchmark amount. Verifiable by integration tests on the benchmark.*

> ⚠ **Sequencing + DB gate (review-3 H4 / L1):** the cost-override primitives (1.4b) and the ownership-verified
> `transactions.ts` actions (authored in Task 2.5) are **dependencies of the Phase-1 integration tests (1.6)**.
> So build the `addTransaction`/`editTransaction` skeleton — with the `.eq(id).eq(user_id)` + UPDATE +
> `.is(undone_at,null)` contract — **here, before 1.6**; Task 2.5 then completes the type→primitive mapping.
> And run **`supabase db reset`** before EVERY integration step in this phase (applies migration 021), or the
> tests fail with "column is_yield does not exist".

### Task 1.1: Migration — two boolean columns

**Files:**
- Create: `supabase/migrations/021_transaction_cost_basis.sql`
- Modify (generated): `src/types/database.ts`

- [ ] **Step 1: Write the migration**
```sql
-- 021_transaction_cost_basis.sql
ALTER TABLE activity_log
  ADD COLUMN is_yield          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cashflow_user_set BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN activity_log.is_yield IS
  'Income/return (interest, staking, airdrop): units added at cost 0, excluded from benchmark cash flows. Distinct from is_adjustment.';
COMMENT ON COLUMN activity_log.cashflow_user_set IS
  'True when the user explicitly typed the amount; false = auto-computed market value. Backdate-recompute only touches false rows.';
```

- [ ] **Step 2: Apply + regenerate types**
```bash
supabase db reset   # applies 001..021 locally
supabase gen types typescript --local 2>/dev/null | sed '/^Connecting to db/d' > src/types/database.ts
```
Expected: `git diff src/types/database.ts` shows `is_yield: boolean` + `cashflow_user_set: boolean` on `activity_log` Row/Insert/Update.

- [ ] **Step 3: Verify typecheck + drift**
Run: `npm run typecheck` → Expected: passes (no consumers broke; columns are additive).

- [ ] **Step 4: Commit**
```bash
git add supabase/migrations/021_transaction_cost_basis.sql src/types/database.ts
git commit -m "feat(cost-basis): migration — is_yield + cashflow_user_set columns"
```

### Task 1.2: `cost-basis-copy.ts` — all verbatim UI strings (tested once)

**Files:**
- Create: `src/lib/cost-basis-copy.ts`
- Test: `__tests__/unit/cost-basis-copy.test.ts`

- [ ] **Step 1: Write the failing test** (asserts every control has non-empty, specific copy — prevents silent gaps)
```ts
import { TYPE_GUIDANCE, COST_COPY } from "@/lib/cost-basis-copy";
describe("cost-basis copy", () => {
  it("has guidance for every transaction type", () => {
    for (const k of ["buy","sell","yield","deposit","withdrawal","transfer"] as const) {
      expect(TYPE_GUIDANCE[k].length).toBeGreaterThan(20);
    }
  });
  it("yield guidance states cost 0 + benchmark exclusion in plain words", () => {
    expect(TYPE_GUIDANCE.yield).toMatch(/earned/i);
    expect(TYPE_GUIDANCE.yield).toMatch(/not.*contribution|cost.*0|free/i);
  });
  it("amount-optional hint mentions the market-value fallback", () => {
    expect(COST_COPY.amountOptionalHint).toMatch(/market value/i);
  });
  it("multi-currency tooltip explains the EUR/USD divergence", () => {
    expect(COST_COPY.fxDivergenceTooltip).toMatch(/exchange.?rate/i);
  });
});
```
- [ ] **Step 2: Run → FAIL** (`Cannot find module '@/lib/cost-basis-copy'`). Run: `npm test -- cost-basis-copy`.
- [ ] **Step 3: Implement** (these are the user-facing source of truth; keep simple + accurate)
```ts
export const TYPE_GUIDANCE = {
  buy:        "Bought with new money you added. Moving cash you already track into this? Use Transfer instead — otherwise it double-counts against the S&P.",
  sell:       "Sold for cash. This locks in a gain or loss. If the cash stays in an account you track, record it as a Transfer.",
  yield:      "Interest, staking, rewards, or an airdrop — units you earned, didn't pay for. Counted as profit (cost 0); not a contribution to the S&P comparison.",
  deposit:    "External money in (e.g. salary, savings). Counts as a contribution in the S&P comparison.",
  withdrawal: "Money leaving your tracked portfolio (spending). Counts as a withdrawal in the S&P comparison.",
  transfer:   "Move value between accounts you already track (e.g. cash → crypto). Doesn't affect the S&P comparison — it's internal.",
} as const;

export const COST_COPY = {
  amountOptionalHint:  "Leave blank to use the market value on that date.",
  amountUserSetHint:   "This is the real amount you paid (incl. fees) — used for your gain/loss and the S&P comparison, not the chart's value line.",
  fxDivergenceTooltip: "EUR and USD cost can differ slightly: each buy was converted at the exchange rate on its own date.",
  markAsYieldConfirm:  "Mark these as Yield? They'll count as earned income (cost 0) and drop out of the S&P contributions.",
  transferLegLocked:   "This is part of a transfer — edit it from the Transfer screen so both sides stay in sync.",
  splitChildLocked:    "This entry was split into dated parts. Unsplit it first to edit the original.",
} as const;
```
- [ ] **Step 4: Run → PASS.** Run: `npm test -- cost-basis-copy`.
- [ ] **Step 5: Commit** — `git add src/lib/cost-basis-copy.ts __tests__/unit/cost-basis-copy.test.ts && git commit -m "feat(cost-basis): verbatim UI copy module + tests"`

### Task 1.3: `quantityDelta()` + `classifyTransaction()` (pure)

**Files:**
- Create: `src/lib/transaction-kind.ts`
- Test: `__tests__/unit/transaction-kind.test.ts`

> ⚠ **Review-3 + audit-2 corrections baked in:** (B2) cash positions store `balance`/`amount`, **NOT**
> `quantity`, and there are **four** cash entity types — so the helpers MUST be entity-aware (cash
> skipped/misclassified otherwise). (B3/C1) split children keep a **positive** `split_quantity` and store a
> separate **`details.split_direction`** (`±1`, Task 4.1); they inherit the parent's `action` (never `removed`),
> so the sign comes from `split_direction`, **not** from `action` — and crucially **not** from a signed
> `split_quantity` (that would double-sign PR #94's augmentation + show "−0.5" in the timeline).

- [ ] **Step 1: Write failing tests** (real fixtures — cash uses `balance`, all four cash types, signed split)
```ts
import { classifyTransaction, quantityDelta } from "@/lib/transaction-kind";
const cryptoBuy = { action:"updated", entity_type:"crypto_position", is_adjustment:false, is_yield:false,
  transfer_group_id:null, split_from_id:null, details:null,
  before_snapshot:{ quantity:1 }, after_snapshot:{ quantity:3 } } as any;
const bankDeposit = { ...cryptoBuy, entity_type:"bank_account",
  before_snapshot:{ balance:300 }, after_snapshot:{ balance:500 } };

describe("quantityDelta", () => {
  it("crypto: after − before from snapshots", () => expect(quantityDelta(cryptoBuy)).toBe(2));
  it("CASH reads `balance`, not quantity (B2)", () => expect(quantityDelta(bankDeposit)).toBe(200));
  it("removed: delta = −before", () =>
    expect(quantityDelta({ ...cryptoBuy, action:"removed", after_snapshot:null, before_snapshot:{ quantity:2 } })).toBe(-2));
  it("split child uses split_direction × split_quantity — a split SELL stays negative (B3/C1)", () =>
    expect(quantityDelta({ ...cryptoBuy, before_snapshot:null, after_snapshot:null, details:{ split_quantity:0.5, split_direction:-1 } })).toBe(-0.5));
  it("split child with no split_direction defaults to +1 (legacy #94 children stay byte-identical)", () =>
    expect(quantityDelta({ ...cryptoBuy, before_snapshot:null, after_snapshot:null, details:{ split_quantity:0.5 } })).toBe(0.5));
  it("never NaNs on fully-null rows", () =>
    expect(quantityDelta({ ...cryptoBuy, before_snapshot:null, after_snapshot:null, details:null })).toBe(0));
});
describe("classifyTransaction", () => {
  it("crypto buy/sell", () => {
    expect(classifyTransaction(cryptoBuy)).toBe("buy");
    expect(classifyTransaction({ ...cryptoBuy, after_snapshot:{ quantity:0.5 } })).toBe("sell"); });
  it("ALL four cash entity types → deposit / withdrawal (B2)", () => {
    for (const t of ["bank_account","exchange_deposit","broker_deposit","cash_account"]) {
      expect(classifyTransaction({ ...bankDeposit, entity_type:t })).toBe("deposit");
      expect(classifyTransaction({ ...bankDeposit, entity_type:t, after_snapshot:{ balance:100 } })).toBe("withdrawal"); }});
  it("yield wins · transfer · adjustment", () => {
    expect(classifyTransaction({ ...cryptoBuy, is_yield:true })).toBe("yield");
    expect(classifyTransaction({ ...cryptoBuy, is_adjustment:true, transfer_group_id:"g1" })).toBe("transfer");
    expect(classifyTransaction({ ...cryptoBuy, is_adjustment:true })).toBe("adjustment"); });
});
```
- [ ] **Step 2: Run → FAIL.** Run: `npm test -- transaction-kind`.
- [ ] **Step 3: Implement** — entity-aware (the cash field comes from `cashAmountField`, same source as `extractQuantity`); signed split; handles created/updated/removed via snapshots.
```ts
import { CASH_ENTITY_TYPES, cashAmountField, type CashEntityType } from "@/lib/deltas";
export type TransactionKind = "buy"|"sell"|"yield"|"deposit"|"withdrawal"|"transfer"|"adjustment";

const CASH = new Set<string>(CASH_ENTITY_TYPES);
function fieldFor(entityType: string): string {
  return CASH.has(entityType) ? cashAmountField(entityType as CashEntityType) : "quantity";
}
function val(snap: unknown, field: string): number {
  if (snap && typeof snap === "object") { const v = (snap as Record<string, unknown>)[field]; return typeof v === "number" ? v : Number(v) || 0; }
  return 0;
}
export function quantityDelta(row: any): number {
  // split child (null snapshots): positive split_quantity × stored split_direction (±1; default +1) (B3/C1)
  if (row.before_snapshot == null && row.after_snapshot == null) {
    const q = row.details?.split_quantity;
    if (q == null) return 0;
    const dir = row.details?.split_direction == null ? 1 : Math.sign(Number(row.details.split_direction)) || 1;
    return (Number(q) || 0) * dir;
  }
  const f = fieldFor(row.entity_type);                       // 'balance'/'amount' for cash, else 'quantity' (B2)
  return val(row.after_snapshot, f) - val(row.before_snapshot, f);  // created:+after · removed:−before · updated:delta
}
export function classifyTransaction(row: any): TransactionKind {
  if (row.is_yield) return "yield";
  if (row.transfer_group_id) return "transfer";
  if (row.is_adjustment) return "adjustment";
  const isCash = CASH.has(row.entity_type);                  // all four cash types, not just 'cash_account' (B2)
  const up = quantityDelta(row) >= 0;
  return isCash ? (up ? "deposit" : "withdrawal") : (up ? "buy" : "sell");
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): pure transaction classifier + quantityDelta (null-snapshot safe)"`

### Task 1.4: Thread `is_yield` + `cashflow_user_set` through `logActivity`

**Files:**
- Modify: `src/lib/actions/activity-log.ts` (`logActivity`'s inline params + the insert payload)
- Test: covered via integration (Task 1.6)

- [ ] **Step 1:** Read `logActivity`'s inline params type (~line 58-80) and the insert object (~line 111). Add two optional params `is_yield?: boolean`, `cashflow_user_set?: boolean`, defaulting `?? false` in the insert (mirror the existing `cashflow_amount_usd: params.cashflow_amount_usd ?? null` pattern). (There is **no** named `CreateActivityLogParams` type — the params are an inline object on `logActivity`.)
- [ ] **Step 2: typecheck** → Expected: passes.
- [ ] **Step 3: Commit** — `git commit -m "feat(cost-basis): logActivity accepts is_yield + cashflow_user_set"`

### Task 1.4b: ⚠ Cost-override params on the write primitives (B1 + B1-STOCKS — the feature's SPINE, was missing)

**Files:**
- Modify: `src/lib/activity-fx.ts` (`computeActivityFx` + `computeActivityFxWithConversion` + `FxResult` + `emptyFx`), `src/lib/actions/crypto.ts` (`upsertPosition`), `src/lib/actions/stocks.ts` (`upsertStockPosition`), `src/lib/actions/cash-accounts.ts` (`CashAccountOpts`; cash uses `computeFx`/`computeCashflow`, **not** `computeActivityFx`)
- Test: `__tests__/integration/transactions.test.ts`

**Why (review-3 B1 + audit-2 B1-STOCKS):** these primitives currently COMPUTE `cashflow = qtyDelta × currentPrice` and expose **no** user-amount param. Without this task a typed cost is silently overwritten by market value — the whole feature fails. **Stocks were omitted in review-3** — `upsertStockPosition` (via `computeActivityFxWithConversion`) needs the same override, and it doubles as the **manual-NAV subscription-cost path** (B6/H1). Must land before the actions (2.5) and the cost-capture integration test (1.6).

- [ ] **Step 1: Failing test** — call `upsertPosition`, `upsertStockPosition`, and a cash create, each with an override `{ usd, eur }` (+ `cashflowUserSet:true`); assert the logged `activity_log` row carries `cashflow_amount_usd/eur = override` + `cashflow_user_set=true` (NOT `qty × price`). With no override → unchanged (market value, `user_set=false`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** —
  - `activity-fx.ts`: add `amountOverride?: { usd:number; eur:number }` to `computeActivityFx` **and** `computeActivityFxWithConversion`; when present, set `cashflowUsd/cashflowEur = override` and **skip** the `qty × price` path. Add a `cashflowUserSet: boolean` field to `FxResult` (set `true` when the override is used; `emptyFx()` defaults it `false`).
  - `crypto.ts` (`upsertPosition`) + `stocks.ts` (`upsertStockPosition`): accept `opts.cashflowOverride` and pass it to the `computeActivityFx*` call + pass `cashflow_user_set` to `logActivity`.
  - `cash-accounts.ts`: add `cashflowOverride` to `CashAccountOpts`; since cash uses `computeFx`/`computeCashflow`, branch to the override there (skip the balance-delta computation) and pass `cashflow_user_set`.
  - Absent → today's behavior. (Never coerce a blank to 0 — that's the modal's job, §7.1.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): cost-override on upsertPosition/upsertStockPosition/cash + activity-fx (B1)"`

### Task 1.5: Backdate-recompute fix (the latent benchmark bug)

**Files:**
- Modify: `src/lib/actions/splits.ts` (`backdateActivityEntry`)
- Test: `__tests__/integration/transactions.test.ts` (the recompute case)

- [ ] **Step 1: Write the failing integration test:** create a real cash-flow entry with an auto amount + `cashflow_user_set=false`; backdate it; assert `cashflow_amount_*` is recomputed to `qty × historical-price(new date) × FX` (use the #94 historical-price path). Then a second entry with `cashflow_user_set=true`; backdate it; assert the amount is **unchanged**.
- [ ] **Step 2: Run → FAIL** (current `backdateActivityEntry` only sets `effective_date`).
- [ ] **Step 3: Implement:** after the `effective_date` update, if the entry is a real cash flow AND `cashflow_user_set=false`, recompute `cashflow_amount_usd/eur` from the #94 historical-price helper at the new date and update them. Skip when `cashflow_user_set=true` or `is_yield=true`. Keep the existing transfer-leg group handling.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(benchmark): recompute stale amount on backdate of auto-priced cash flows"`

### Task 1.6: Integration — cost capture + ownership

**Files:** Create `__tests__/integration/transactions.test.ts`

- [ ] **Step 1: Write failing tests:** (a) creating a position with a user amount stores `cashflow_amount_*` = that amount + `cashflow_user_set=true`; (b) blank amount → market fallback + `cashflow_user_set=false`; (c) **ownership:** `editTransaction(otherUsersEntryId)` returns not-found (no cross-user write) — mirrors the #97 RLS-isolation tests.
- [ ] **Step 2-4:** implement the minimal `addTransaction`/`editTransaction` (Task 2.5 expands them) to pass; run; iterate.
- [ ] **Step 5: Commit** — `git commit -m "test(cost-basis): integration — cost capture + cross-user ownership"`

---

# PHASE 2 — Yield + Transactions drawer + guided modal

*Outcome: the user can open any asset's transactions, add/edit them via a self-explanatory type selector, classify income as Yield, and bulk Mark-as-Yield. Benchmark excludes yield.*

### Task 2.1: `deriveCashFlows` excludes `is_yield`

**Files:** Modify `src/lib/actions/benchmark.ts`; Test `__tests__/integration/cost-basis-benchmark.test.ts`

- [ ] **Step 1: Failing test:** seed a complete cash flow + a yield entry on the same asset; assert `deriveCashFlows` returns the cash flow but **not** the yield row.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** add `is_yield` to the `.select(...)` and filter it out (or `.eq("is_yield", false)` in the query). Confirm no #94 benchmark test regresses (`npm test -- benchmark`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(benchmark): exclude is_yield rows from cash flows"`

### Task 2.2: Transaction modal — type selector + guidance + lockdowns

**Files:** Create `src/components/transactions/transaction-modal.tsx`; Test `__tests__/component/transaction-modal.test.tsx`

**UI-LOCKDOWN matrix (assert each):**
| State | Behavior |
|---|---|
| Save with NaN/empty quantity | Save disabled; `role="alert"` "Quantity must be a valid number". |
| Amount NaN (but non-empty) | blocked, `role="alert"`; blank amount is allowed (→ market fallback hint shown). |
| Future date | blocked via `validatePastOrTodayDate`, `role="alert"`. |
| Type = Yield | Amount field hidden (cost 0); only Quantity + Date shown. |
| Type = Transfer | fields replaced by a "Continue in Transfer →" button (routes out); modal not a dead end. |
| Editing a transfer leg | type/amount read-only with `COST_COPY.transferLegLocked`; a button routes to the Transfer screen. |
| Editing a split-child / undone entry | blocked with `COST_COPY.splitChildLocked`; "Unsplit" affordance offered. |
| Manual-NAV asset | Amount = subscription; per-unit fields absent (the engine skips them). |

- [ ] **Step 1: Failing tests** — render each asset class; assert (1) the type options match the class (crypto: Buy/Sell/Yield/Transfer; cash: Deposit/Withdrawal/Yield/Transfer); (2) selecting each type shows the right fields + the matching `TYPE_GUIDANCE[k]` text on screen; (3) Yield hides Amount; (4) every lockdown row above renders its reason (not a silent disabled control); (5) blank amount shows `COST_COPY.amountOptionalHint`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — mirror `src/components/cash/cash-account-modal.tsx` structure (Modal, `space-y-4`, `text-xs text-zinc-400 mb-1` labels, focus-trap, `role="alert"`); add the type `<select>` driven by asset class; render `TYPE_GUIDANCE[type]` under it; conditionally render fields per type; wire validators from `src/lib/validation.ts`; never coerce blank→0.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): guided Add/Edit transaction modal with per-type help + lockdowns"`

### Task 2.3: Transactions drawer — list, grouping, filter, empty state

**Files:** Create `src/components/transactions/transactions-drawer.tsx`; Test `__tests__/component/transactions-drawer.test.tsx`

**UI-LOCKDOWN matrix:** empty asset → "No transactions yet — Add the first one" (not a blank panel); long yield run → collapsed into one expandable row; filter with no matches → "No {type} transactions" + a Clear-filter button (no dead end).

- [ ] **Step 1: Failing tests** — given a fixture asset with 2 buys + 14 yields + 1 sell: (1) renders rows with type badge/qty/amount/date; (2) consecutive yields collapse to "+ 12 more weekly accruals" expandable; (3) the type filter (All/Buys/Sells/Yield) narrows the list; (4) empty + no-match states render their copy + escape control; (5) each row's pencil opens the edit modal.
- [ ] **Step 2-4:** implement (right-anchored panel; per-asset rows passed in as props — the data query is Task 2.4); run; iterate.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): per-asset Transactions drawer (grouping, filter, empty states)"`

### Task 2.4: Per-asset transactions query + row history icon

**Files:** Modify `crypto-table.tsx` / `stock-table.tsx` / `cash-table.tsx` (action cluster); new read in `src/lib/actions/transactions.ts` or `activity-log.ts`

> ⚠ **Engine-input contract (audit-2):** the read feeds the cost engine, so it must `.is("undone_at", null)`
> (a split flips the parent→`undone` atomically with the child insert, so this yields exactly **live parents OR
> children, never both** — no double-count), group by `entity_id`, and **select both `cashflow_amount_*` AND
> `delta_*`** (C3: transfer/adjustment legs carry their value in `delta_*`, not `cashflow_amount_*`).
> ⚠ **Cash placement (L3):** the cash *group* row renders `actions: () => null` (cash-columns.tsx:252-259) and
> Edit/Delete live on the **expanded sub-rows** — so the cash history icon needs a sub-row or group-level
> placement, not a drop-in to a (nonexistent) group cluster.

- [ ] **Step 1: Failing integration test** — `getAssetTransactions(assetRef)` returns all `activity_log` rows across the asset's positions/wallets, RLS-scoped, **`.is("undone_at", null)`**, **selecting `cashflow_amount_*` + `delta_*`**, **paginated via `fetchAllPaginated`** (GHO can exceed defaults), ordered by `COALESCE(effective_date, created_at)`. Assert a split parent (now `undone`) is excluded and its live children are included.
- [ ] **Step 2-4:** implement the read; add a hover-revealed history icon (Lucide `History`) to each table's action cluster beside Edit/Delete (`aria-label="Transactions"`), opening the drawer (cash: on the sub-row / group-level per L3); run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): asset-scoped transaction read + row history affordance"`

### Task 2.5: `addTransaction` / `editTransaction` / `markAsYield` server actions

**Files:** Create `src/lib/actions/transactions.ts`; Test extends `__tests__/integration/transactions.test.ts`

**Logic sanity (assert) — review-3 + audit-2 corrections:** `addTransaction(type)` maps to the
**override-extended** primitive (Buy/Sell→`upsertPosition` (crypto) / `upsertStockPosition` (stocks) with
`cashflowOverride`; Deposit/Withdrawal→cash action with override; **Yield→a normal qty-up acquisition with
`is_yield=true`, amount left intact, never zeroed**). **`editTransaction` is a direct `activity_log` UPDATE** —
`logActivity` is insert-only, so editing an existing row's amount/date/`is_yield`/`cashflow_user_set` is an
UPDATE (mirror `backdateActivityEntry`/`toggleActivityAdjustment`, activity-log.ts:380-407), scoped
`.eq("id").eq("user_id")` (404 if absent — #97) **and `.is("undone_at", null)`** (TOCTOU, M4). **Guards (H5):**
reject a **transfer leg** (`transfer_group_id != null`) and a **split child / undone row** (`split_from_id !=
null`), with the `COST_COPY.transferLegLocked` / `splitChildLocked` messages. **Write the right column (H5):**
on an `is_adjustment` row an amount edit updates **`delta_*`**, otherwise **`cashflow_amount_*`** — **never both
on one row** (both = phantom benchmark contribution). Validate at the boundary: `validateUUID(entryId)` +
amount/qty/date (M3). `markAsYield(ids)` validates each `validateUUID(id)`, flips only eligible rows (real cash
flow, not transfer/undone), sets **`is_yield=true` (amount NOT zeroed — H2 → un-yield is lossless)**, returns
`{updated, skipped}`.

- [ ] **Step 1: Failing tests** — per the sanity list above, incl. `editTransaction` rejecting a transfer leg + a split child, the `is_adjustment`→`delta_*` branch (asserting `cashflow_amount_*` stays null), and `markAsYield` skipping a transfer leg.
- [ ] **Step 2-4:** implement as thin, `captureAction`-wrapped, `revalidateDashboard()` orchestration over existing primitives; **ownership verified in the action**; run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): addTransaction/editTransaction/markAsYield (ownership-verified)"`

### Task 2.6: Multi-select "Mark as Yield" in the drawer

**Files:** Modify `transactions-drawer.tsx`; Test extends the drawer test

**UI-LOCKDOWN:** Mark-as-Yield disabled until ≥1 eligible row selected; ineligible rows (transfer/undone) not selectable + show a why-tooltip; confirm dialog uses `COST_COPY.markAsYieldConfirm`; result toast reports `{updated, skipped}`.

- [ ] **Step 1: Failing tests** — selecting interest rows + Mark-as-Yield calls `markAsYield(ids)`; ineligible rows can't be selected; the confirm copy renders.
- [ ] **Step 2-4:** implement multi-select + the action call; run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): bulk Mark-as-Yield cleanup for legacy interest"`

---

# PHASE 3 — Average-cost engine + A+B display + the #94 seed interaction

*Outcome: accurate avg cost / realized / unrealized / total P&L per asset and portfolio-wide; the benchmark uses real cost; the per-class `buildCostBasisSeries` + the seed re-anchor to cost make the #94 chart show the honest cost≠market delta. This is the correctness heart — most exhaustive tests live here.*

### Task 3.1: The average-cost engine (pure)

**Files:** Create `src/lib/portfolio/cost-basis.ts`; Test `__tests__/unit/cost-basis.test.ts`

- [ ] **Step 1: Write the failing tests — every engine-relevant spec §10 case + the identity invariant** (the cases that live in other files are listed in the comment after the block). Write the full set:
```ts
import { computeCostBasis } from "@/lib/portfolio/cost-basis";
// helper makes a txn with snapshots: mk(beforeQty, afterQty, value, flags?)
describe("computeCostBasis — engine cases from spec §10 + invariant", () => {
  it("1 · buy-and-hold: realized 0, unrealized = value - cost", () => {
    const r = computeCostBasis([mk(0,1,30000)], 80000);
    expect(r.realized).toBe(0); expect(r.costBasis).toBe(30000);
    expect(r.unrealized).toBe(50000); expect(r.avgCost).toBe(30000); expect(r.totalPnL).toBe(50000);
  });
  it("2 · two buys then a partial sell uses average cost", () => {
    // buy 1@30k, buy 1@50k (avg 40k), sell 0.5 for 35k, hold 1.5 worth 120k
    const r = computeCostBasis([mk(0,1,30000), mk(1,2,50000), mk(2,1.5,35000,{sell:true})], 120000);
    expect(r.realized).toBeCloseTo(15000); expect(r.costBasis).toBeCloseTo(60000);
    expect(r.unrealized).toBeCloseTo(60000); expect(r.totalPnL).toBeCloseTo(75000);
  });
  it("3 · sell at a loss → negative realized", () => { /* sell below avg */ });
  it("4 · full exit then re-buy restarts avg from 0/0", () => { /* case 4 */ });
  it("5 · yield adds units at cost 0 and lowers avg; excluded from benchmark", () => { /* GHO case */ });
  it("6 · yield then sold → realized = full proceeds (cost 0)", () => { /* case 6 */ });
  it("7 · airdrop / new asset as yield → first txn cost 0", () => { /* case 7 */ });
  it("8 · cash yield (bank interest) → Yield on cash, excluded", () => { /* case 8 */ });
  it("9 · salary deposit → deposit, counts; mirror of yield", () => { /* case 9 */ });
  it("11 · wallet→wallet move (same crypto) nets to zero → cost-neutral", () => { /* case 11 */ });
  it("12 · crypto→cash transfer → realizes gain at moved value |delta|, benchmark-neutral (C3 reads delta_*)", () => { /* case 12 */ });
  it("13 · lumped DCA → correct total P&L (date-independent)", () => { /* case 13 */ });
  it("17 · stablecoin (all gain = yield)", () => { /* case 17 */ });
  it("18 · manual-NAV uses the engine (has quantity); market/NAV fallback until cost entered", () => { /* case 18 */ });
  it("19 · editing/undoing a transaction → engine recomputes", () => { /* case 19 */ });
  it("21 · zero/blank/NaN amount blocked upstream; engine never NaNs", () => { /* case 21 */ });
  it("22 · float boundary at units→0: no divide-by-zero, no drift (tolerance)", () => { /* case 22 */ });
  it("23 · split child (null snapshots) via quantityDelta(split_direction × split_quantity)", () => { /* case 23 */ });
  it("24 · transfer fee (net remainder) = realized loss at 0 proceeds", () => { /* case 24 */ });
  it("27 · cash classified across all four cash entity types (balance delta)", () => { /* case 27 */ });
  it("30 · oversell (backdated-buy-after-sell) is clamped + fires onAnomaly (H4)", () => {
    const spy = vi.fn();
    const r = computeCostBasis([mk(0,1,100), mk(1,0,150,{sell:true}), mk(0,2,80,{sell:true})], 0, { onAnomaly: spy });
    expect(r.costBasis).toBeGreaterThanOrEqual(0);    // never negative
    expect(spy).toHaveBeenCalled();
  });
  it("31 · correction is off-book → identity does NOT hold across it (asserted, H3)", () => { /* case 31 */ });
  it("INVARIANT (buy/sell/yield only): totalPnL === currentValue + Σproceeds − Σcost for random sequences", () => { /* property test, excludes corrections */ });
});
// Cases living in OTHER files (not the pure engine): 10 (double-count) → benchmark/integration; 14 (split math) →
// split-helpers.test; 15 (backdate recompute) → cost-basis-backdate.test; 16/26 (per-currency) → Task 3.2; 20
// (drawer grouping) → component; 25 (seed) → Task 3.4; 28 (un-yield lossless) + 29 (override persist) → integration.
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the spec §6 algorithm.** The **pre-step resolves each stream entry's `value`** (per
  currency): `|cashflow_amount_{cur}|` for buys/sells, **`|delta_{cur}|` (moved value) for transfer/adjustment
  legs** (C3 — `cashflow_amount_*` is null on `is_adjustment` rows), and **`0` for a same-asset fee remainder**
  (B5 — a realized loss, never a gain). Use `quantityDelta()` (entity-aware + `split_direction` — Task 1.3) for
  qty; direction always from `quantityDelta`, never the delta sign. Then the four-branch loop with the **oversell
  clamp** `out = min(-qtyDelta, units)` and an injected optional `onAnomaly?: (m: string) => void` fired on a
  genuine `out > units` (H4 — the engine stays pure; the read-time caller passes a Sentry `captureMessage`).
  Return `{avgCost, costBasis, realized, unrealized, totalPnL}` — **NOT `totalYieldValue`** (H1: it needs a
  per-date price the pure engine has no input for; "total yield earned" is computed in the display layer with a
  price map). Signature: `computeCostBasis(txnsAsc, currentValue, opts?: { onAnomaly?: (m: string) => void })`.
  All §10 engine cases must have a named test (M5); the property-based identity invariant covers random
  sequences **over buy/sell/yield only** (H3 — corrections are off-book; a separate test asserts the identity
  does NOT hold across a correction).
- [ ] **Step 4: Run → PASS (every engine case above + the off-book-correction assertion + the property invariant).**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): average-cost engine (§10 cases + identity invariant)"`

### Task 3.2: Run the engine per currency (EUR authoritative)

**Files:** Modify `cost-basis.ts` (or a small wrapper); Test extends `cost-basis.test.ts`

- [ ] **Step 1: Failing test** — given transactions with divergent EUR/USD amounts, `computeAssetPnL(txns, {valueEur, valueUsd})` returns `{eur, usd}` results, each internally consistent; EUR flagged authoritative; the two are NOT forced equal.
- [ ] **Step 2-4:** implement by running the engine twice (EUR amounts → EUR result, USD amounts → USD result); run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): per-currency P&L (EUR authoritative, no reconcile)"`

### Task 3.3: Thread P&L into aggregate + display columns

**Files:** Modify `aggregate.ts`/`assemble.ts`/`shared-portfolio.ts`; the three tables; Test: component tests for the columns

**UI-LOCKDOWN:** Realized column shows "—" when 0 (pure-hold); **manual-NAV is NOT a special case** (review-3
B6 — it uses the engine: full avg/realized/unrealized once a cost is entered, market/NAV fallback until then;
there is no `manualNavDash` copy key — it was dropped in T1.2); P&L columns hide first under `HIDDEN_BELOW` on
narrow screens (full detail always in the drawer).

> ⚠ **Largest integration surface (review-3 H5) — split into sub-tasks, not one checkbox:** `aggregate.ts`
> (~334 lines), `assemble.ts`, `shared-portfolio.ts`, the three tables, the dashboard stat, AND share-page
> read-only parity. Suggested: **3.3a** aggregate per-asset P&L fields → **3.3b** table columns → **3.3c**
> dashboard Total P&L stat → **3.3d** share-page parity. The "total yield earned" figure (H1) is computed
> *here* with the historical-price map (not in the engine).

- [ ] **Step 1-5 (per sub-task):** TDD the per-asset display (avg cost, unrealized, realized, total P&L €+%,
  `changeColor`); EUR-authoritative headline + USD secondary with `COST_COPY.fxDivergenceTooltip`; dashboard
  Total P&L stat; share-page read-only parity; commit each sub-task.

### Task 3.4: ⚠ The #94 seed re-architecture (RISKIEST — do not rush; audit-2 C2)

**Files:** Create the pure `buildCostBasisSeries` in `src/lib/portfolio/historical-prices-augmentation.ts`; modify `src/lib/actions/benchmark.ts` (`deriveCashFlows` uses the user amount; `getHistoricalBenchmarkExtension` returns the series + loads the per-asset `delta` streams), `src/lib/portfolio/chart-enrichment.ts` (the `seedDisp` lookup), `src/app/dashboard/page.tsx` + `src/app/share/[token]/page.tsx` + `src/components/dashboard/portfolio-chart.tsx` (thread the new prop). Test: `__tests__/unit/cost-basis-series.test.ts` + `__tests__/integration/cost-basis-benchmark.test.ts` + the public-`enrichChartData` seed unit test.

**Design rule (spec §9, re-architected per audit-2 C2):** a scalar seed is **infeasible** — `enrichWithSp500Benchmark` runs **client-side** in a `useMemo`, `chartStart` is **period-dependent** (24H/3D/…/All) and **per-view-mode** (crypto/stocks/cash/total), the engine is per-asset. So build a **server-side, portfolio-wide, per-class running-cost series** and look it up per period/mode at the seed. Corrections/synthetic `is_adjustment` flows stay **market-valued** (the scope bound + the byte-identical guard).

- [ ] **Step 3.4a — `buildCostBasisSeries` (pure, server-side).** Create it in `historical-prices-augmentation.ts`, reusing the engine's cost accumulator + #94's cached price/lot inputs. It emits `{ date, cryptoCostUsd, stocksCostUsd, cashCostUsd, cryptoCostEur, stocksCostEur, cashCostEur }[]`, where each class's value at a date is **`realLotCost(date) + adjustmentMarketValueAtChartStart`** — real lots contribute their running **cost basis** (from the engine), `is_adjustment` lots contribute their **market value** (`Σ lotContributionAtDate`). Failing unit test first: a real backdated lot (cost €5,000) → series shows €5,000; an `is_adjustment` lot → series shows its market value, not 0.
- [ ] **Step 3.4b — expose via `getHistoricalBenchmarkExtension`** (`benchmark.ts:145-198`): add the series to its return, loading the per-asset cashflow **and `delta`** streams (a superset of `deriveCashFlows`). `deriveCashFlows` itself now excludes `is_yield` (Task 2.1) and uses the user-authored `cashflow_amount_*`.
- [ ] **Step 3.4c — thread the prop:** `page.tsx:157` + `share/[token]/page.tsx:75` → `PortfolioChart` → `enrichChartData` → `enrichWithSp500Benchmark`. Add `lookupCostAtOrBefore(series, chartStart, viewMode)` (per-class lookup; total/investments by summation).
- [ ] **Step 3.4d — READ `chart-enrichment.ts:204-304` end-to-end**, confirm `seedDisp = firstSliceVal` (line 242) and the `neededUnits`/`unitsAtChartStart`/`seedDelta` re-anchor (265-286).
- [ ] **Step 3.4e — Write failing seed tests — UNIT, via the public `enrichChartData`:**
  - A backdated lot, cost €5,000, **market €8,000** at chartStart → S&P line at chartStart = **€5,000** (cost), portfolio line = **€8,000** (market) — the €3,000 gap survives.
  - Control: no user cost + no backdated adjustment → `seedDisp == firstSliceVal` **byte-identical to today**.
  - An `is_adjustment` lot present at chartStart with cost==market → still byte-identical (adjustment term = its market value, the guard holds).
- [ ] **Step 3.4f — Implement** `seedDisp = lookupCostAtOrBefore(series, chartStart, viewMode) ?? firstSliceVal` (reuse the FX-ratio tiers :251-263 verbatim; keep the `unitsAtChartStart` machinery intact). **Re-run the ENTIRE existing benchmark + chart-enrichment suite** (`npm test -- benchmark chart-enrichment`) — must be unchanged.
- [ ] **Step 3.4g — Live-smoke note (manual, at integration time):** drive the running app with a backdated crypto lot at a known cost ≠ market; confirm the two lines start apart by exactly the delta and reconcile thereafter; toggle each period + view mode.
- [ ] **Step 3.4h — Commit** — `git commit -m "feat(benchmark): cost-basis series + seed re-anchor to cost (#94 C2)"`

---

# PHASE 4 — Split with per-leg cost (DCA reconstruction)

### Task 4.1: `SplitLeg.cost` + `splitActivityEntry`

**Files:** Modify `src/lib/types.ts` (SplitLeg), `src/lib/actions/splits.ts`; Test `__tests__/unit/split-helpers.test.ts` + integration

- [ ] **Step 1: Failing tests** — splitting `2 BTC €40k` into legs `0.5@2019 €4k · 0.5@2021 €8k · 1.0@2023 €28k`
  creates children whose `cashflow_amount` = the entered per-leg cost; **`details.split_quantity` stays POSITIVE
  and `details.split_direction = Math.sign(extractQuantity(parent))` is stored (B3/C1)** — splitting a SELL
  yields `split_direction = -1` so `quantityDelta` (Task 1.3) keeps it a disposal, not a buy, **without
  double-signing #94's augmentation or showing "−0.5" in the timeline**; quantities sum to parent; `unsplit`
  restores; a leg with no cost falls back to proportional.
- [ ] **Step 2-4:** add optional `cost` to `SplitLeg` **and to the `split-modal.tsx` `onSplit` callback's
  inline leg type** (L2 — it's typed `{effective_date, quantity}[]`, not `SplitLeg`); in `splitActivityEntry`
  use entered cost when present AND store `details.split_direction = Math.sign(extractQuantity(parent))` (keep
  `split_quantity` positive). **Then update #94's two augmentation sites** (historical-prices-augmentation.ts
  ~861-864/899-902) to read `split_direction × split_quantity` (replacing their `action`-derived sign; missing
  `split_direction` defaults to `+1` → byte-identical for existing children). Verify activity-timeline.tsx:888
  still renders the positive magnitude (unchanged); run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): split legs carry per-leg cost + split_direction (DCA)"`

### Task 4.2: Split modal — per-leg cost field

**Files:** Modify `src/components/history/split-modal.tsx`; Test extends its component test

**UI-LOCKDOWN:** Σ(leg qty) ≠ parent qty → Save disabled + `role="alert"` showing the running total vs target; Σ(cost) shown but not forced (hint: "costs should sum to what you actually paid"); ≥2 legs required.

- [ ] **Step 1-5:** add a cost input per leg + the running-total guards + the hint copy; TDD; commit.

---

# PHASE 5 — Cost-basis chart overlay

### Task 5.1: (already built in Phase 3) — verify `buildCostBasisSeries` covers the overlay

**Files:** none new — the per-class cost series was built in **Task 3.4a** (`buildCostBasisSeries` in `historical-prices-augmentation.ts`) for the seed. Test: extend `cost-basis-series.test.ts` only if the overlay needs a shape the seed didn't.

> ⚠ The Phase-5 overlay **reuses** the Phase-3 series (the C2 re-architecture moved the builder earlier to fix the dependency inversion — spec §12). This task is now just a verification that the existing series exposes what the overlay's `<Line>` needs (per-class cost at each chart date, price-free); add a field only if missing.

- [ ] **Step 1:** Confirm `buildCostBasisSeries` already returns per-class cost at each chart date (it does — it feeds the seed). If the overlay needs the running series at the chart's own date granularity (not just chartStart), assert it via a failing test; else skip to 5.2.
- [ ] **Step 2-4:** extend only if needed; run.
- [ ] **Step 5: Commit (if changed)** — `git commit -m "test(cost-basis): cost series covers the overlay shape"`

### Task 5.2: Faint cost overlay line on the chart

**Files:** Modify `src/components/dashboard/portfolio-chart.tsx`; Test: component test

**UI-LOCKDOWN/clarity:** the line has a legend entry + a one-line explainer ("what you've put in — the gap to the value line is your unrealized gain"); hidden in % return mode (consistent with the value line's modes); no overlay when no cost data (graceful).

- [ ] **Step 1-5:** add a third `<Line>` (faint, dashed) fed by `costBasisSeries`; legend + explainer; respect existing chart modes; TDD render; commit.

---

# Final verification (before the combined #94 + cost-basis ship)

- [ ] `npm run typecheck && npm run lint && npm run build` → all clean.
- [ ] `npm test && npm run test:component` → green; coverage ≥90% on `cost-basis.ts` + `transaction-kind.ts`.
- [ ] `supabase start && npm run test:integration` → green (incl. the benchmark + ownership cases).
- [ ] **`/review audit`** (16 agents) on the combined branch.
- [ ] **Live + visual smoke:** real data; the GHO Mark-as-Yield cleanup; a backdated cost≠market lot reconciling on the chart; the overlay line.
- [ ] **`pg_dump`** before any prod step.
- [ ] Verify **#94 + cost-basis together**; then merge #94 → main and cost-basis → main back-to-back.

---

## Self-Review (run against the spec)

> ⚠ **The original "No gaps found" below was WRONG** — a 3-agent code-verification review (2026-06-03) found
> blocking bugs (cash `balance` vs `quantity`, split-child sign, the missing cost-override task, the
> mis-diagnosed #94 seed, manual-NAV's false premise). **All are corrected in this revision** (see commit
> `cb2a978` spec + this plan's review-3 edits) and in `memory/cost-basis-review-findings.md`. A single-pass
> self-review is not a substitute for outside verification on a feature this size — a **comprehensive audit
> runs on this revised plan before any code is written.**

- **Spec coverage:** §5 data → T1.1; **cost-override primitives crypto+stocks+cash (B1/B1-STOCKS) → T1.4b**;
  classifier/quantityDelta (entity-aware + `split_direction`) → T1.3; cost override + user_set (§5.2/§7.1) →
  T1.4b/T2.5; backdate recompute (§7.2) → T1.5; yield exclusion (§9) → T2.1; drawer/modal/type-selector/guidance
  (§8) → T2.2-2.4; multi-select Mark-as-Yield (§7.6/§8.4) → T2.6; engine cases + oversell-clamp + off-book-
  correction-invariant (§6/§10, H3/H4) → T3.1; transfer value reads `delta_*` (C3) → T3.1; per-currency EUR-auth
  (§7.7) → T3.2; display + manual-NAV-via-engine (§8.6/§7.8) → T3.3 (sub-tasks); **#94 seed = server
  `buildCostBasisSeries` → prop → `lookupCostAtOrBefore` (§9, C2)** → T3.4; split-with-cost + `split_direction`
  (§5.3/§7.5, C1) → T4; overlay reuses the Phase-3 series (§12 P5) → T5. Transfer-fee €0 (§7.4) → T3.1.
  Security + UPDATE + TOCTOU + transfer/split-child guards + is_adjustment→delta_* (#97/H3/H5/M4) → T1.6/T2.5.
- **Placeholder scan:** the engine, classifier, copy, migration carry full code; UI/integration tasks carry named tests + exact lockdown matrices + verbatim copy + the template file to mirror + the function to read (T3.4) — concrete, not "TBD". The two genuinely read-then-edit tasks (T1.5 backdate, T3.4 seed) explicitly say *read first* because fabricating a subtle diff would be less accurate than the implementer reading the real function — this is the intended subagent-driven contract, not a placeholder.
- **Type consistency:** `TransactionKind`, `quantityDelta`, `classifyTransaction`, `computeCostBasis`, `costBasisSeries`, `TYPE_GUIDANCE`/`COST_COPY` names are used identically across tasks.

## Notes for the implementer
- Pure logic (`cost-basis.ts`, `transaction-kind.ts`, `cost-basis-copy.ts`) must stay out of `"use server"` files (Turbopack strips re-exports; and they must be unit-testable). `buildCostBasisSeries` lives in `historical-prices-augmentation.ts` (already a pure read-time module) so it can reuse #94's price/lot inputs.
- **C1 has three consumers — change them together:** `quantityDelta` (Task 1.3), #94's two augmentation sign-sites (Task 4.1, historical-prices-augmentation.ts ~861-864/899-902), and a no-op verification of activity-timeline.tsx:888. A missing `split_direction` must default to `+1` so existing #94 children stay byte-identical.
- Mirror `cash-account-modal.tsx` for modal conventions; mirror `crypto-table.tsx`'s existing expand/action-cluster for the row icon (cash: sub-row / group placement per L3).
- After T1.1, **always** regenerate `src/types/database.ts` — CI drift-check will fail otherwise.
- T3.4 is the one place to go slow: it's the C2 re-architecture (server series → prop → seed). Read `chart-enrichment.ts` fully, keep the no-user-cost + no-backdated-adjustment path byte-identical to today, and run the whole #94 benchmark + chart-enrichment suite after.
