/**
 * Type-only tests for CashAccountCreateInput / CashAccountUpdateInput.
 *
 * Vitest collects `*.test-d.ts` files via `vitest typecheck` (when configured)
 * but the assertions below are also valid as a plain TypeScript file — `npm
 * run build` and `npx tsc --noEmit` will fail if any `@ts-expect-error` line
 * doesn't actually error. That's the canonical way to assert type behaviour
 * without a runtime test runner.
 *
 * These assertions encode the type-system contract introduced when
 * `CashAccountInput` was split into Create-strict + Update-partial pairs.
 */
import type { CashAccountCreateInput, CashAccountUpdateInput } from "@/lib/types";

// ─── CashAccountCreateInput: required fields are required ────────────────────

// Valid: all required fields present.
const validCreate: CashAccountCreateInput = {
  currency: "USD",
  balance: 100,
};
void validCreate;

// Valid: required + optional.
const validCreateFull: CashAccountCreateInput = {
  currency: "USD",
  balance: 100,
  apy: 3.3,
  name: "Savings",
  institution_id: "inst-id",
  wallet_id: null,
  broker_id: "broker-id",
  region: "GR",
};
void validCreateFull;

// Missing `currency` — must fail.
// @ts-expect-error currency is required
const missingCurrency: CashAccountCreateInput = { balance: 100 };
void missingCurrency;

// Missing `balance` — must fail.
// @ts-expect-error balance is required
const missingBalance: CashAccountCreateInput = { currency: "USD" };
void missingBalance;

// Empty object — must fail (both required fields missing).
// @ts-expect-error currency and balance both required
const emptyCreate: CashAccountCreateInput = {};
void emptyCreate;

// ─── CashAccountUpdateInput: every field is optional ─────────────────────────

// Valid: empty object.
const emptyUpdate: CashAccountUpdateInput = {};
void emptyUpdate;

// Valid: just apy (transfer fee correction case).
const apyOnly: CashAccountUpdateInput = { apy: 5.0 };
void apyOnly;

// Valid: just balance + currency (transfer destination case).
const transferStyle: CashAccountUpdateInput = { currency: "USD", balance: 1000 };
void transferStyle;

// Valid: full payload — same shape as create.
const fullUpdate: CashAccountUpdateInput = {
  currency: "USD",
  balance: 100,
  apy: 3.3,
  name: "Savings",
  institution_id: "inst-id",
  wallet_id: null,
  broker_id: "broker-id",
  region: "GR",
};
void fullUpdate;

// Cannot pass an unknown field — must fail.
// @ts-expect-error unknown field
const unknownField: CashAccountUpdateInput = { not_a_field: 5 };
void unknownField;

// ─── Cross-shape: Create satisfies Update (any create payload is a valid update) ─

const createIsUpdate: CashAccountUpdateInput = validCreate;
void createIsUpdate;
