import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractQuantity, isValidPastOrTodayDate } from "@/lib/split-helpers";
import { round2 } from "@/lib/format";

describe("isValidPastOrTodayDate", () => {
  // Pin time so "today" is deterministic across runs (previous version used
  // `new Date()` which fails around UTC midnight when local date differs).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a past date", () => {
    expect(isValidPastOrTodayDate("2020-01-01")).toBe(true);
  });

  it("accepts today", () => {
    expect(isValidPastOrTodayDate("2026-04-15")).toBe(true);
  });

  it("rejects a future date", () => {
    expect(isValidPastOrTodayDate("2099-01-01")).toBe(false);
  });

  it("rejects invalid string", () => {
    expect(isValidPastOrTodayDate("not-a-date")).toBe(false);
  });
});

describe("extractQuantity", () => {
  it("extracts quantity from created crypto action", () => {
    const log = {
      action: "created",
      entity_type: "crypto_position",
      after_snapshot: { quantity: 0.5 },
    };
    expect(extractQuantity(log as never)).toBe(0.5);
  });

  it("extracts balance from created cash action", () => {
    const log = {
      action: "created",
      entity_type: "cash_account",
      after_snapshot: { balance: 5000 },
    };
    expect(extractQuantity(log as never)).toBe(5000);
  });

  it("extracts quantity delta from updated action", () => {
    const log = {
      action: "updated",
      entity_type: "stock_position",
      before_snapshot: { quantity: 10 },
      after_snapshot: { quantity: 15 },
    };
    expect(extractQuantity(log as never)).toBe(5);
  });

  it("returns null when snapshots missing", () => {
    const log = {
      action: "created",
      entity_type: "crypto_position",
      after_snapshot: null,
    };
    expect(extractQuantity(log as never)).toBeNull();
  });

  it("returns null for removed action", () => {
    const log = {
      action: "removed",
      entity_type: "crypto_position",
      before_snapshot: { quantity: 1 },
    };
    expect(extractQuantity(log as never)).toBeNull();
  });

  it("extracts balance from bank_account entity type", () => {
    const log = {
      action: "created",
      entity_type: "bank_account",
      after_snapshot: { balance: 3000 },
    };
    expect(extractQuantity(log as never)).toBe(3000);
  });

  it("extracts amount from exchange_deposit entity type", () => {
    const log = {
      action: "created",
      entity_type: "exchange_deposit",
      after_snapshot: { amount: 1500 },
    };
    expect(extractQuantity(log as never)).toBe(1500);
  });

  it("extracts amount from broker_deposit entity type", () => {
    const log = {
      action: "created",
      entity_type: "broker_deposit",
      after_snapshot: { amount: 2000 },
    };
    expect(extractQuantity(log as never)).toBe(2000);
  });

  it("returns null when after_snapshot lacks quantity field", () => {
    const log = {
      action: "created",
      entity_type: "crypto_position",
      after_snapshot: { name: "Bitcoin" },
    };
    expect(extractQuantity(log as never)).toBeNull();
  });

  it("handles updated action with missing before_snapshot", () => {
    const log = {
      action: "updated",
      entity_type: "stock_position",
      before_snapshot: null,
      after_snapshot: { quantity: 10 },
    };
    expect(extractQuantity(log as never)).toBeNull();
  });

  it("handles updated action with missing after_snapshot", () => {
    const log = {
      action: "updated",
      entity_type: "stock_position",
      before_snapshot: { quantity: 10 },
      after_snapshot: null,
    };
    expect(extractQuantity(log as never)).toBeNull();
  });
});

describe("fraction rounding (split delta distribution)", () => {
  it("child deltas sum exactly to parent delta for 3-leg split", () => {
    // Simulate the splitting logic for quantities [0.25, 0.20, 0.05] with total 0.5
    const parentDeltaUsd = 1000;
    const parentDeltaEur = 920;
    const totalQty = 0.5;
    const legs = [
      { quantity: 0.25, effective_date: "2025-01-01" },
      { quantity: 0.20, effective_date: "2025-02-01" },
      { quantity: 0.05, effective_date: "2025-03-01" },
    ];

    let runningDeltaUsd = 0;
    let runningDeltaEur = 0;
    const childDeltas: { usd: number; eur: number }[] = [];

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isLast = i === legs.length - 1;
      const fraction = leg.quantity / Math.abs(totalQty);

      let childDeltaUsd: number;
      let childDeltaEur: number;

      if (isLast) {
        childDeltaUsd = parentDeltaUsd - runningDeltaUsd;
        childDeltaEur = parentDeltaEur - runningDeltaEur;
      } else {
        childDeltaUsd = round2(parentDeltaUsd * fraction);
        childDeltaEur = round2(parentDeltaEur * fraction);
        runningDeltaUsd += childDeltaUsd;
        runningDeltaEur += childDeltaEur;
      }

      childDeltas.push({ usd: childDeltaUsd, eur: childDeltaEur });
    }

    // Verify exact sum
    const sumUsd = childDeltas.reduce((s, d) => s + d.usd, 0);
    const sumEur = childDeltas.reduce((s, d) => s + d.eur, 0);
    expect(sumUsd).toBe(parentDeltaUsd);
    expect(sumEur).toBe(parentDeltaEur);

    // Verify individual fractions are proportional
    expect(childDeltas[0].usd).toBe(500);  // 0.25/0.5 = 50%
    expect(childDeltas[1].usd).toBe(400);  // 0.20/0.5 = 40%
    expect(childDeltas[2].usd).toBe(100);  // remainder = 10%
  });

  it("handles uneven fractions without losing cents", () => {
    // 3 equal legs of 1/3 each — 333.33 + 333.33 + remainder
    const parentDeltaUsd = 1000;
    const totalQty = 3;
    const legs = [
      { quantity: 1, effective_date: "2025-01-01" },
      { quantity: 1, effective_date: "2025-02-01" },
      { quantity: 1, effective_date: "2025-03-01" },
    ];

    let runningDelta = 0;
    const childDeltas: number[] = [];

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isLast = i === legs.length - 1;
      const fraction = leg.quantity / Math.abs(totalQty);

      if (isLast) {
        childDeltas.push(parentDeltaUsd - runningDelta);
      } else {
        const d = round2(parentDeltaUsd * fraction);
        childDeltas.push(d);
        runningDelta += d;
      }
    }

    // Remainder = 1000 - 333.33 - 333.33 — exact sum guaranteed by design
    const sum = childDeltas.reduce((s, d) => s + d, 0);
    expect(sum).toBe(parentDeltaUsd);
    expect(childDeltas[0]).toBe(333.33);
    expect(childDeltas[1]).toBe(333.33);
    expect(childDeltas[2]).toBeCloseTo(333.34, 2); // remainder absorbs the penny (fp noise)
  });
});
