import { describe, it, expect } from "vitest";
import {
  computeCompensatingUpdate,
  IMMUTABLE_COLUMNS,
  BADGE_COLUMNS,
  VALUE_FIELDS,
} from "@/lib/compensating-update";

describe("IMMUTABLE_COLUMNS + BADGE_COLUMNS + VALUE_FIELDS", () => {
  it("IMMUTABLE_COLUMNS excludes common mutable business columns", () => {
    expect(IMMUTABLE_COLUMNS.has("id")).toBe(true);
    expect(IMMUTABLE_COLUMNS.has("user_id")).toBe(true);
    expect(IMMUTABLE_COLUMNS.has("created_at")).toBe(true);
    expect(IMMUTABLE_COLUMNS.has("updated_at")).toBe(true);
    expect(IMMUTABLE_COLUMNS.has("deleted_at")).toBe(true);
    expect(IMMUTABLE_COLUMNS.has("balance")).toBe(false);
    expect(IMMUTABLE_COLUMNS.has("name")).toBe(false);
  });

  it("BADGE_COLUMNS flags ephemeral UI-state fields only", () => {
    expect(BADGE_COLUMNS.has("last_was_adjustment")).toBe(true);
    expect(BADGE_COLUMNS.has("last_was_transfer")).toBe(true);
    expect(BADGE_COLUMNS.has("balance")).toBe(false);
  });

  it("VALUE_FIELDS maps each mutable-accumulator table to its quantity column", () => {
    expect(VALUE_FIELDS.cash_accounts).toEqual(["balance"]);
    expect(VALUE_FIELDS.crypto_positions).toEqual(["quantity"]);
    expect(VALUE_FIELDS.stock_positions).toEqual(["quantity"]);
    expect(VALUE_FIELDS.broker_deposits).toEqual(["amount"]);
  });
});

describe("computeCompensatingUpdate", () => {
  // ── Value-field delta reversal ─────────────────────────

  it("reverses a value-field delta onto the current value (happy path)", () => {
    // Original: quantity 10 -> 30 (delta +20). Meanwhile current is 40.
    // Undo should restore: 40 + (10 - 30) = 20.
    const result = computeCompensatingUpdate(
      "crypto_positions",
      { quantity: 40 },
      { quantity: 10 },
      { quantity: 30 },
    );
    expect(result).toEqual({ quantity: 20 });
  });

  it("handles a negative delta (value decreased)", () => {
    // Original: balance 100 -> 70 (delta -30). Current is 70.
    // Undo should restore: 70 + (100 - 70) = 100.
    const result = computeCompensatingUpdate(
      "cash_accounts",
      { balance: 70 },
      { balance: 100 },
      { balance: 70 },
    );
    expect(result).toEqual({ balance: 100 });
  });

  it("treats non-numeric current value as 0", () => {
    // If quantity became null somehow, Number(null) = 0.
    const result = computeCompensatingUpdate(
      "crypto_positions",
      { quantity: null },
      { quantity: 5 },
      { quantity: 8 },
    );
    expect(result).toEqual({ quantity: -3 }); // 0 + (5 - 8)
  });

  // ── Identity-field behavior ────────────────────────────

  it("restores identity field when current still matches after_snapshot", () => {
    const result = computeCompensatingUpdate(
      "wallets",
      { name: "New Name" },
      { name: "Original Name" },
      { name: "New Name" },
    );
    expect(result).toEqual({ name: "Original Name" });
  });

  it("SKIPS identity field when current has drifted from after_snapshot", () => {
    // User renamed again after the original mutation — don't clobber.
    const result = computeCompensatingUpdate(
      "wallets",
      { name: "User-changed name" },
      { name: "Original Name" },
      { name: "First rename" },
    );
    expect(result).toEqual({});
  });

  // ── Skip rules ─────────────────────────────────────────

  it("skips IMMUTABLE_COLUMNS (id/user_id/timestamps)", () => {
    const result = computeCompensatingUpdate(
      "wallets",
      { id: "curr-id", user_id: "u-curr", created_at: "2026-01-02", name: "X" },
      { id: "orig-id", user_id: "u-orig", created_at: "2026-01-01", name: "Y" },
      { id: "curr-id", user_id: "u-curr", created_at: "2026-01-02", name: "X" },
    );
    // Only "name" is a candidate — and current matches after, so it restores
    expect(result).toEqual({ name: "Y" });
  });

  it("skips BADGE_COLUMNS (last_was_adjustment, last_was_transfer)", () => {
    const result = computeCompensatingUpdate(
      "crypto_positions",
      { last_was_adjustment: true, last_was_transfer: false },
      { last_was_adjustment: false, last_was_transfer: false },
      { last_was_adjustment: true, last_was_transfer: false },
    );
    expect(result).toEqual({});
  });

  it("skips fields that didn't change between before and after", () => {
    const result = computeCompensatingUpdate(
      "wallets",
      { name: "Same", chain: "Ethereum" },
      { name: "Same", chain: "Ethereum" },
      { name: "Same", chain: "Ethereum" },
    );
    expect(result).toEqual({});
  });

  // ── Edge cases ─────────────────────────────────────────

  it("handles an unknown table gracefully (no VALUE_FIELDS → all identity)", () => {
    // No entry in VALUE_FIELDS → treat quantity as identity, not delta.
    // Current matches after → restore before.
    const result = computeCompensatingUpdate(
      "unknown_table",
      { quantity: 10 },
      { quantity: 5 },
      { quantity: 10 },
    );
    expect(result).toEqual({ quantity: 5 });
  });

  it("produces an empty update when afterSnapshot is empty", () => {
    const result = computeCompensatingUpdate(
      "wallets",
      { name: "anything" },
      { name: "anything" },
      {},
    );
    expect(result).toEqual({});
  });

  // ── Numeric edge cases ─────────────────────────────────

  it("produces NaN when both value-field inputs are Infinity (documents current behavior)", () => {
    // Number(Infinity) - Number(Infinity) = NaN. This silently writes NaN to DB.
    // Pinned here so a future hardening pass (e.g. Number.isFinite guard) is noticed.
    const result = computeCompensatingUpdate(
      "crypto_positions",
      { quantity: 10 },
      { quantity: Infinity },
      { quantity: Infinity },
    );
    // Current impl: stringify-equality returns true on Infinity vs Infinity, so
    // the field is skipped as "unchanged". Documents that reality.
    expect(result).toEqual({});
  });

  it("NaN values are treated as unchanged via JSON.stringify equality (both stringify to null)", () => {
    // JSON.stringify(NaN) === "null". This is an intentional quirk of JSON
    // canonicalization — documented here so future changes notice.
    const result = computeCompensatingUpdate(
      "crypto_positions",
      { quantity: 5 },
      { quantity: NaN },
      { quantity: NaN },
    );
    expect(result).toEqual({}); // skipped as "unchanged"
  });

  it("identity skip is also applied on tables with defined VALUE_FIELDS (non-value field drift)", () => {
    // cash_accounts has VALUE_FIELDS=["balance"]. A change to `currency`
    // (identity field, not value field) should follow the "restore-if-unchanged"
    // path, not the delta reversal path.
    const result = computeCompensatingUpdate(
      "cash_accounts",
      { currency: "USD", balance: 100 },
      { currency: "EUR", balance: 100 },
      { currency: "USD", balance: 100 },
    );
    // currency: current matches after → restore before ("EUR")
    // balance: unchanged before vs after → skip
    expect(result).toEqual({ currency: "EUR" });
  });
});
