/**
 * Type-only tests for the CashFlowEvent discriminated union (audit M19-full).
 *
 * Like cash-account-input-types.test-d.ts, these assertions are validated by
 * `npx tsc --noEmit` (CI typecheck step) and `npm run build` — the build fails
 * if any `@ts-expect-error` line does NOT actually error. They are NOT run by
 * vitest (which only collects `.test.ts`/`.test.tsx`).
 *
 * Contract under test: the `synthetic` discriminant type-enforces the invariant
 * that synthetic S&P-benchmark-only flows NEVER carry an `entity_name`. Real
 * flows (synthetic absent/false) MAY carry attribution; synthetic flows
 * (synthetic: true) have no entity_name property at all.
 */
import type {
  CashFlowEvent,
  RealCashFlowEvent,
  SyntheticCashFlowEvent,
} from "@/lib/types";

// ─── RealCashFlowEvent: carries attribution, synthetic absent/false ──────────

// Valid: real flow with entity_name, no synthetic discriminant.
const realFlow: RealCashFlowEvent = {
  date: "2024-01-01",
  amount_usd: 1000,
  amount_eur: 920,
  asset_class: "crypto",
  entity_name: "Revolut EUR",
};
void realFlow;

// Valid: real flow with explicit synthetic: false.
const realFlowExplicit: RealCashFlowEvent = {
  date: "2024-01-01",
  amount_usd: 1000,
  synthetic: false,
  entity_name: "DEGIRO",
};
void realFlowExplicit;

// Real flow cannot set synthetic: true — must fail.
const realCannotBeSynthetic: RealCashFlowEvent = {
  date: "2024-01-01",
  amount_usd: 1000,
  // @ts-expect-error real flows are synthetic:false|absent, not true
  synthetic: true,
};
void realCannotBeSynthetic;

// ─── SyntheticCashFlowEvent: synthetic:true, NO entity_name ──────────────────

// Valid: synthetic flow, no entity_name.
const syntheticFlow: SyntheticCashFlowEvent = {
  date: "2021-01-01",
  amount_usd: 60000,
  amount_eur: 50000,
  asset_class: "stocks",
  synthetic: true,
};
void syntheticFlow;

// THE load-bearing assertion: synthetic flow with entity_name — must fail.
// This is the invariant the union exists to enforce.
const syntheticWithEntity: SyntheticCashFlowEvent = {
  date: "2021-01-01",
  amount_usd: 60000,
  synthetic: true,
  // @ts-expect-error synthetic flows MUST NOT carry entity_name
  entity_name: "Should Not Compile",
};
void syntheticWithEntity;

// Synthetic flow must set synthetic: true (it's the required discriminant) — fail.
// @ts-expect-error synthetic discriminant is required on the synthetic variant
const syntheticMissingDiscriminant: SyntheticCashFlowEvent = {
  date: "2021-01-01",
  amount_usd: 60000,
};
void syntheticMissingDiscriminant;

// ─── CashFlowEvent union: both variants assignable ───────────────────────────

const unionFromReal: CashFlowEvent = realFlow;
void unionFromReal;

const unionFromSynthetic: CashFlowEvent = syntheticFlow;
void unionFromSynthetic;

// Excess-property check still bites on a union object literal: a synthetic-typed
// literal (synthetic: true) with entity_name is rejected even when the target
// is the bare union — synthetic:true selects SyntheticCashFlowEvent, which has
// no entity_name.
const unionRejectsSyntheticWithEntity: CashFlowEvent = {
  date: "2021-01-01",
  amount_usd: 60000,
  synthetic: true,
  // @ts-expect-error synthetic literal in the union cannot carry entity_name
  entity_name: "Should Not Compile",
};
void unionRejectsSyntheticWithEntity;

// ─── Narrowing: !synthetic narrows the union to RealCashFlowEvent ────────────

declare const someFlow: CashFlowEvent;
if (!someFlow.synthetic) {
  // entity_name is only reachable after narrowing off the discriminant.
  const name: string | undefined = someFlow.entity_name;
  void name;
} else {
  // In the synthetic branch entity_name does not exist on the type.
  // @ts-expect-error entity_name absent on SyntheticCashFlowEvent
  const leaked = someFlow.entity_name;
  void leaked;
}
