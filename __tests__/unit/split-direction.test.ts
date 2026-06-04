import { describe, it, expect } from "vitest";
import { extractQuantity } from "@/lib/split-helpers";
import { splitDirectionForParent, splitSignWithLegacyFallback } from "@/lib/split-helpers";

/**
 * Task 4.1 — split_direction derivation + the augmentation legacy fallback.
 *
 * `split_direction` is PARENT-derived (legs are always positive — splits.ts
 * rejects leg.quantity <= 0). It is stored ONCE on every child as
 * Math.sign(extractQuantity(parent)) with a zero-quantity guard that resolves
 * to +1 (the safe buy default).
 *
 * The augmentation reads the literal split sign as
 *   split_direction ?? (action === "removed" ? -1 : 1)
 * which is byte-identical to the old `(removed ? -1 : 1)` formula for EVERY
 * legacy #94 child (which carries NO split_direction), including the
 * theoretical removed-child case.
 */

describe("splitDirectionForParent", () => {
  it("a SELL parent (negative qty delta) yields -1", () => {
    const sellParent = {
      action: "updated",
      entity_type: "crypto_position",
      before_snapshot: { quantity: 2 },
      after_snapshot: { quantity: 0.5 },
    };
    // delta = 0.5 - 2 = -1.5 → sign -1
    expect(extractQuantity(sellParent as never)).toBeLessThan(0);
    expect(splitDirectionForParent(sellParent as never)).toBe(-1);
  });

  it("a BUY parent (positive qty delta) yields +1", () => {
    const buyParent = {
      action: "created",
      entity_type: "crypto_position",
      after_snapshot: { quantity: 2 },
    };
    expect(extractQuantity(buyParent as never)).toBeGreaterThan(0);
    expect(splitDirectionForParent(buyParent as never)).toBe(1);
  });

  it("an updated-BUY parent (after > before) yields +1", () => {
    const buyParent = {
      action: "updated",
      entity_type: "stock_position",
      before_snapshot: { quantity: 10 },
      after_snapshot: { quantity: 15 },
    };
    expect(splitDirectionForParent(buyParent as never)).toBe(1);
  });

  it("a zero-qty-delta parent is guarded to +1 (Math.sign(0)=0 → +1 safe default)", () => {
    const zeroParent = {
      action: "updated",
      entity_type: "crypto_position",
      before_snapshot: { quantity: 5 },
      after_snapshot: { quantity: 5 },
    };
    // delta = 0 → Math.sign(0) = 0 → guard → +1
    expect(extractQuantity(zeroParent as never)).toBe(0);
    expect(splitDirectionForParent(zeroParent as never)).toBe(1);
  });

  it("a parent whose quantity cannot be determined is guarded to +1", () => {
    const removedParent = {
      action: "removed",
      entity_type: "crypto_position",
      before_snapshot: { quantity: 1 },
    };
    // extractQuantity returns null for "removed" → guard → +1
    expect(extractQuantity(removedParent as never)).toBeNull();
    expect(splitDirectionForParent(removedParent as never)).toBe(1);
  });

  it("a cash SELL/withdrawal parent (balance down) yields -1", () => {
    const withdrawalParent = {
      action: "updated",
      entity_type: "cash_account",
      before_snapshot: { balance: 5000 },
      after_snapshot: { balance: 2000 },
    };
    expect(splitDirectionForParent(withdrawalParent as never)).toBe(-1);
  });
});

describe("splitSignWithLegacyFallback (augmentation byte-identity)", () => {
  it("uses an explicit split_direction when present (sell child stays -1)", () => {
    expect(splitSignWithLegacyFallback(-1, "updated")).toBe(-1);
    expect(splitSignWithLegacyFallback(1, "updated")).toBe(1);
  });

  it("legacy child with NO split_direction + action='updated' → +1 (old formula)", () => {
    // (removed ? -1 : 1) with action !== "removed" → +1
    expect(splitSignWithLegacyFallback(undefined, "updated")).toBe(1);
    expect(splitSignWithLegacyFallback(null, "created")).toBe(1);
  });

  it("legacy child with NO split_direction + action='removed' → -1 (old formula, byte-identical)", () => {
    // This is the theoretical removed-child case the plan's "+1 default"
    // missed. splitActivityEntry cannot create such a child today (it bails
    // on a null parent quantity), but the augmentation reads ALL rows incl.
    // ad-hoc inserts, so the fallback MUST replicate (removed ? -1 : 1).
    expect(splitSignWithLegacyFallback(undefined, "removed")).toBe(-1);
    expect(splitSignWithLegacyFallback(null, "removed")).toBe(-1);
  });

  it("an explicit split_direction overrides the action (a removed-action child with +1 stays +1)", () => {
    expect(splitSignWithLegacyFallback(1, "removed")).toBe(1);
  });

  it("normalizes a non-unit split_direction via sign (defensive)", () => {
    expect(splitSignWithLegacyFallback(-3, "updated")).toBe(-1);
    expect(splitSignWithLegacyFallback(7, "updated")).toBe(1);
  });
});
