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
- `src/lib/actions/activity-log.ts` — `CreateActivityLogParams` already accepts `cashflow_amount_*`/`cashflow_status`; add `is_yield`, `cashflow_user_set` passthrough.
- `src/lib/actions/splits.ts` — `SplitLeg.cost?`; `splitActivityEntry` uses per-leg cost; `backdateActivityEntry` recompute hook.
- `src/lib/actions/benchmark.ts` — `deriveCashFlows` excludes `is_yield`, uses user-authored amount.
- `src/lib/portfolio/chart-enrichment.ts` — seed allows the cost≠market delta (#94 interaction; Task 3.4).
- `src/lib/portfolio/aggregate.ts` / `assemble.ts` / `shared-portfolio.ts` — thread cost-basis outputs for display.
- `src/components/crypto/crypto-table.tsx`, `stocks/stock-table.tsx`, `cash/cash-table.tsx` — row history icon + P&L columns.
- `src/components/history/split-modal.tsx` — per-leg cost field.
- `src/components/dashboard/portfolio-chart.tsx` (or equivalent) — cost overlay line.

---

# PHASE 1 — Data layer + cost capture + backdate-recompute fix

*Outcome: every transaction can carry a user-authored amount + the two new flags; backdating no longer leaves a stale benchmark amount. Verifiable by integration tests on the benchmark.*

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
  manualNavDash:       "Not tracked per-unit for fund holdings — your gain is the latest NAV minus what you put in.",
} as const;
```
- [ ] **Step 4: Run → PASS.** Run: `npm test -- cost-basis-copy`.
- [ ] **Step 5: Commit** — `git add src/lib/cost-basis-copy.ts __tests__/unit/cost-basis-copy.test.ts && git commit -m "feat(cost-basis): verbatim UI copy module + tests"`

### Task 1.3: `quantityDelta()` + `classifyTransaction()` (pure)

**Files:**
- Create: `src/lib/transaction-kind.ts`
- Test: `__tests__/unit/transaction-kind.test.ts`

- [ ] **Step 1: Write failing tests** (cover the null-snapshot/split-child case from objection #1, and every kind)
```ts
import { classifyTransaction, quantityDelta } from "@/lib/transaction-kind";
const base = { action:"updated", entity_type:"crypto_position", is_adjustment:false, is_yield:false,
  transfer_group_id:null, split_from_id:null, details:null,
  before_snapshot:{ quantity:"1" }, after_snapshot:{ quantity:"3" } } as any;

describe("quantityDelta", () => {
  it("reads before/after snapshots", () => expect(quantityDelta(base)).toBe(2));
  it("falls back to details.split_quantity when snapshots are null", () =>
    expect(quantityDelta({ ...base, before_snapshot:null, after_snapshot:null,
      action:"created", details:{ split_quantity:"0.5" } })).toBe(0.5));
  it("signs split_quantity negative for removed", () =>
    expect(quantityDelta({ ...base, before_snapshot:null, after_snapshot:null,
      action:"removed", details:{ split_quantity:"0.5" } })).toBe(-0.5));
  it("never NaNs on fully-null rows", () =>
    expect(quantityDelta({ ...base, before_snapshot:null, after_snapshot:null, details:null })).toBe(0));
});
describe("classifyTransaction", () => {
  it("buy = qty up, real cash flow", () => expect(classifyTransaction(base)).toBe("buy"));
  it("sell = qty down", () => expect(classifyTransaction({ ...base, after_snapshot:{quantity:"0.5"} })).toBe("sell"));
  it("yield wins over qty sign", () => expect(classifyTransaction({ ...base, is_yield:true })).toBe("yield"));
  it("transfer from transfer_group_id", () => expect(classifyTransaction({ ...base, is_adjustment:true, transfer_group_id:"g1" })).toBe("transfer"));
  it("adjustment = is_adjustment without transfer", () => expect(classifyTransaction({ ...base, is_adjustment:true })).toBe("adjustment"));
  it("cash qty-up is deposit, qty-down is withdrawal", () => {
    expect(classifyTransaction({ ...base, entity_type:"cash_account" })).toBe("deposit");
    expect(classifyTransaction({ ...base, entity_type:"cash_account", after_snapshot:{quantity:"0.5"} })).toBe("withdrawal");
  });
});
```
- [ ] **Step 2: Run → FAIL.** Run: `npm test -- transaction-kind`.
- [ ] **Step 3: Implement** (single source of truth — see spec §14 "derive, don't store")
```ts
export type TransactionKind = "buy"|"sell"|"yield"|"deposit"|"withdrawal"|"transfer"|"adjustment";

function qty(snap: unknown): number {
  if (snap && typeof snap === "object" && "quantity" in snap) return Number((snap as { quantity: unknown }).quantity) || 0;
  return 0;
}
export function quantityDelta(row: any): number {
  if (row.before_snapshot != null || row.after_snapshot != null) return qty(row.after_snapshot) - qty(row.before_snapshot);
  const sq = row.details?.split_quantity;
  if (sq != null) return (row.action === "removed" ? -1 : 1) * (Number(sq) || 0);
  return 0;
}
export function classifyTransaction(row: any): TransactionKind {
  if (row.is_yield) return "yield";
  if (row.transfer_group_id) return "transfer";
  if (row.is_adjustment) return "adjustment";
  const isCash = row.entity_type === "cash_account";
  const up = quantityDelta(row) >= 0;
  return isCash ? (up ? "deposit" : "withdrawal") : (up ? "buy" : "sell");
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): pure transaction classifier + quantityDelta (null-snapshot safe)"`

### Task 1.4: Thread `is_yield` + `cashflow_user_set` through `logActivity`

**Files:**
- Modify: `src/lib/actions/activity-log.ts` (CreateActivityLogParams + the insert payload)
- Test: covered via integration (Task 1.6)

- [ ] **Step 1:** Read `CreateActivityLogParams` (~line 70-110) and the insert object. Add two optional params `is_yield?: boolean`, `cashflow_user_set?: boolean`, defaulting `?? false` in the insert (mirror the existing `cashflow_amount_usd: params.cashflow_amount_usd ?? null` pattern).
- [ ] **Step 2: typecheck** → Expected: passes.
- [ ] **Step 3: Commit** — `git commit -m "feat(cost-basis): logActivity accepts is_yield + cashflow_user_set"`

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

- [ ] **Step 1: Failing integration test** — `getAssetTransactions(assetRef)` returns all `activity_log` rows across the asset's positions/wallets, RLS-scoped, **paginated via `fetchAllPaginated`** (GHO can exceed defaults), ordered by `COALESCE(effective_date, created_at)`.
- [ ] **Step 2-4:** implement the read; add a hover-revealed history icon (Lucide `History`) to each table's action cluster beside Edit/Delete (`aria-label="Transactions"`), opening the drawer; run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): asset-scoped transaction read + row history affordance"`

### Task 2.5: `addTransaction` / `editTransaction` / `markAsYield` server actions

**Files:** Create `src/lib/actions/transactions.ts`; Test extends `__tests__/integration/transactions.test.ts`

**Logic sanity (assert):** addTransaction(type) maps to the right primitive (Buy/Sell→`upsertPosition`; Deposit/Withdrawal→cash action; Yield→qty-up with `is_yield=true`, `cashflow_amount=0`); editTransaction re-fetches with `.eq("id").eq("user_id")` (404 if absent — #97); markAsYield only flips eligible rows (real cash flow, not transfer/undone), sets `is_yield=true`+`cashflow_amount=0`, returns `{updated, skipped}`.

- [ ] **Step 1: Failing tests** — per the sanity list above, incl. markAsYield skipping a transfer leg.
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

*Outcome: accurate avg cost / realized / unrealized / total P&L per asset and portfolio-wide; the benchmark uses real cost; the #94 seed allows the honest cost≠market delta. This is the correctness heart — most exhaustive tests live here.*

### Task 3.1: The average-cost engine (pure)

**Files:** Create `src/lib/portfolio/cost-basis.ts`; Test `__tests__/unit/cost-basis.test.ts`

- [ ] **Step 1: Write the failing tests — all 27 spec §10 cases + the identity invariant.** Examples (write the full set):
```ts
import { computeCostBasis } from "@/lib/portfolio/cost-basis";
// helper makes a txn with snapshots: mk(beforeQty, afterQty, value, flags?)
describe("computeCostBasis", () => {
  it("buy-and-hold: realized 0, unrealized = value - cost", () => {
    const r = computeCostBasis([mk(0,1,30000)], 80000);
    expect(r.realized).toBe(0); expect(r.costBasis).toBe(30000);
    expect(r.unrealized).toBe(50000); expect(r.avgCost).toBe(30000); expect(r.totalPnL).toBe(50000);
  });
  it("two buys then a partial sell uses average cost", () => {
    // buy 1@30k, buy 1@50k (avg 40k), sell 0.5 for 35k, hold 1.5 worth 120k
    const r = computeCostBasis([mk(0,1,30000), mk(1,2,50000), mk(2,1.5,35000,{sell:true})], 120000);
    expect(r.realized).toBeCloseTo(15000); expect(r.costBasis).toBeCloseTo(60000);
    expect(r.unrealized).toBeCloseTo(60000); expect(r.totalPnL).toBeCloseTo(75000);
  });
  it("yield adds units at cost 0 and lowers avg", () => { /* GHO case */ });
  it("full exit then re-buy restarts avg from 0/0", () => { /* case 4 */ });
  it("transfer fee (net remainder) = realized loss at 0 proceeds", () => { /* case 24 */ });
  it("split child (null snapshots) via quantityDelta", () => { /* case 23 */ });
  it("INVARIANT: totalPnL === currentValue + Σproceeds − Σcost for random sequences", () => { /* property test */ });
  // ...all 27 cases from spec §10
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement exactly the spec §6 algorithm** (pre-net transfer groups within the asset; `quantityDelta()` for qty; `value = transfer ? |delta| : |cashflow_amount|`; the four-branch loop; guards). Return `{avgCost, costBasis, realized, unrealized, totalPnL, totalYieldValue}`.
- [ ] **Step 4: Run → PASS (all 27 + invariant).**
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): average-cost engine (27 cases + identity invariant)"`

### Task 3.2: Run the engine per currency (EUR authoritative)

**Files:** Modify `cost-basis.ts` (or a small wrapper); Test extends `cost-basis.test.ts`

- [ ] **Step 1: Failing test** — given transactions with divergent EUR/USD amounts, `computeAssetPnL(txns, {valueEur, valueUsd})` returns `{eur, usd}` results, each internally consistent; EUR flagged authoritative; the two are NOT forced equal.
- [ ] **Step 2-4:** implement by running the engine twice (EUR amounts → EUR result, USD amounts → USD result); run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): per-currency P&L (EUR authoritative, no reconcile)"`

### Task 3.3: Thread P&L into aggregate + display columns

**Files:** Modify `aggregate.ts`/`assemble.ts`/`shared-portfolio.ts`; the three tables; Test: component tests for the columns

**UI-LOCKDOWN:** Realized column shows "—" when 0 (pure-hold); manual-NAV rows show "—" for avg/realized/unrealized (`COST_COPY.manualNavDash` tooltip) and a real Total P&L; P&L columns hide first under `HIDDEN_BELOW` on narrow screens (full detail always in the drawer).

- [ ] **Step 1-5:** TDD the per-asset display (avg cost, unrealized, realized, total P&L €+%, `changeColor`); EUR authoritative headline + USD secondary with `COST_COPY.fxDivergenceTooltip`; manual-NAV simple path (§7.8); dashboard Total P&L stat; commit.

### Task 3.4: ⚠ The #94 seed interaction (RISKIEST — do not rush)

**Files:** Modify `src/lib/actions/benchmark.ts` (use user amount) + `src/lib/portfolio/chart-enrichment.ts` (seed); Test `__tests__/integration/cost-basis-benchmark.test.ts` + a unit test on the seed function.

**Design rule (spec §9):** the benchmark invests the **actual user cost** at `effective_date`; #94's seed must **allow** the correct non-zero delta `= market − cost` on backdated cost≠market lots (the benchmark line starts at cost, the portfolio at market), **without** re-triggering the double-count guards. Scoped to backdated-with-user-cost lots.

- [ ] **Step 1: READ `chart-enrichment.ts` `enrichWithSp500Benchmark` (the `seedDisp`/`seedDelta`/`unitsAtChartStart` block) end-to-end before changing anything.** The seed currently assumes flow = market value.
- [ ] **Step 2: Write failing tests:**
  - Unit (seed): a backdated lot with cost €5,000 but market €8,000 at chartStart → benchmark seeds at **cost (5,000)**, portfolio at **market (8,000)**, delta **3,000** preserved (not cancelled).
  - Control: cost == market → delta ≈ 0, identical to today (#94 unchanged).
  - Integration: full pipeline reconciles; no double-count (benchmark units don't get the lot twice).
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement the minimal seed adjustment** so the seed uses the actual contributed cost for backdated user-cost lots and allows the delta; re-run the **entire** existing benchmark suite (`npm test -- benchmark chart-enrichment`) to prove no #94 regression.
- [ ] **Step 5: Live-smoke note (manual, at integration time):** drive the running app with a backdated crypto lot at a known cost ≠ market; confirm the two lines start apart by exactly the delta and reconcile thereafter.
- [ ] **Step 6: Commit** — `git commit -m "feat(benchmark): use actual cost; seed allows honest cost≠market delta (#94 interaction)"`

---

# PHASE 4 — Split with per-leg cost (DCA reconstruction)

### Task 4.1: `SplitLeg.cost` + `splitActivityEntry`

**Files:** Modify `src/lib/types.ts` (SplitLeg), `src/lib/actions/splits.ts`; Test `__tests__/unit/split-helpers.test.ts` + integration

- [ ] **Step 1: Failing tests** — splitting `2 BTC €40k` into legs `0.5@2019 €4k · 0.5@2021 €8k · 1.0@2023 €28k` creates children whose `cashflow_amount` = the entered per-leg cost; quantities sum to parent; `unsplit` restores; a leg with no cost falls back to proportional.
- [ ] **Step 2-4:** add optional `cost` to `SplitLeg`; in `splitActivityEntry` use entered cost when present; run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): split legs carry per-leg cost for DCA"`

### Task 4.2: Split modal — per-leg cost field

**Files:** Modify `src/components/history/split-modal.tsx`; Test extends its component test

**UI-LOCKDOWN:** Σ(leg qty) ≠ parent qty → Save disabled + `role="alert"` showing the running total vs target; Σ(cost) shown but not forced (hint: "costs should sum to what you actually paid"); ≥2 legs required.

- [ ] **Step 1-5:** add a cost input per leg + the running-total guards + the hint copy; TDD; commit.

---

# PHASE 5 — Cost-basis chart overlay

### Task 5.1: `costBasisSeries()` (cost-at-each-date, price-free)

**Files:** Modify `cost-basis.ts`; Test extends `cost-basis.test.ts`

- [ ] **Step 1: Failing test** — `costBasisSeries(txnsAsc, dates)` returns the running cost basis at each chart date (Σ amounts paid − cost of units sold; yield adds 0; **no historical-price lookups**). Asserts monotone where only buys, drops on sells by avg×sold.
- [ ] **Step 2-4:** implement by replaying the engine and emitting `costBasis` at each date boundary; run.
- [ ] **Step 5: Commit** — `git commit -m "feat(cost-basis): cost-basis time series (price-free)"`

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

- **Spec coverage:** §5 data → T1.1; classifier/quantityDelta (§6, obj #1) → T1.3; cost override + user_set (§5.2/§7.1) → T1.4/T2.5; backdate recompute (§7.2) → T1.5; yield exclusion (§9) → T2.1; drawer/modal/type-selector/guidance (§8) → T2.2-2.4; multi-select Mark-as-Yield (§7.6/§8.4) → T2.6; engine 27 cases (§6/§10) → T3.1; per-currency EUR-auth (§7.7) → T3.2; display + manual-NAV (§8.6/§7.8) → T3.3; **#94 seed (§9)** → T3.4; split-with-cost (§5.3/§7.5) → T4; overlay (§12 P5) → T5. Transfer fee (§7.4/#3) → T3.1 case 24. Security (#9) → T1.6/T2.5. **No gaps found.**
- **Placeholder scan:** the engine, classifier, copy, migration carry full code; UI/integration tasks carry named tests + exact lockdown matrices + verbatim copy + the template file to mirror + the function to read (T3.4) — concrete, not "TBD". The two genuinely read-then-edit tasks (T1.5 backdate, T3.4 seed) explicitly say *read first* because fabricating a subtle diff would be less accurate than the implementer reading the real function — this is the intended subagent-driven contract, not a placeholder.
- **Type consistency:** `TransactionKind`, `quantityDelta`, `classifyTransaction`, `computeCostBasis`, `costBasisSeries`, `TYPE_GUIDANCE`/`COST_COPY` names are used identically across tasks.

## Notes for the implementer
- Pure logic (`cost-basis.ts`, `transaction-kind.ts`, `cost-basis-copy.ts`) must stay out of `"use server"` files (Turbopack strips re-exports; and they must be unit-testable).
- Mirror `cash-account-modal.tsx` for modal conventions; mirror `crypto-table.tsx`'s existing expand/action-cluster for the row icon.
- After T1.1, **always** regenerate `src/types/database.ts` — CI drift-check will fail otherwise.
- T3.4 is the one place to go slow: read `chart-enrichment.ts` fully, keep the cost==market path byte-identical to today, and run the whole #94 benchmark suite after.
