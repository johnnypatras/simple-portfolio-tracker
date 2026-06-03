import { describe, it, expect, vi } from "vitest";
import {
  computeCostBasis,
  computeAssetPnL,
  type CostBasisTxn,
} from "@/lib/portfolio/cost-basis";

/**
 * Builder for a CostBasisTxn fixture.
 *
 * `mk(beforeQty, afterQty, value, flags?)` produces a crypto_position row with
 * snapshots `{quantity: beforeQty}` / `{quantity: afterQty}` and `value` placed in
 * BOTH cashflow_amount_usd AND cashflow_amount_eur (so the default-currency "eur"
 * pass — and an explicit "usd" pass — both read it).
 *
 * Flags layer extra behavior onto the row:
 *   - is_yield                → mark the row as earned units (cost 0)
 *   - sell                    → semantic alias only (direction comes from snapshots);
 *                               kept so call-sites document intent
 *   - is_adjustment           → set is_adjustment true
 *   - transfer_group_id       → join a transfer group
 *   - delta                   → route the value through delta_{usd,eur} and NULL the
 *                               cashflow_* columns (the is_adjustment / transfer value
 *                               source — C3)
 *   - cash                    → entity_type "cash_account" with balance snapshots
 *                               instead of quantity
 *   - cashType / cashField    → use a specific cash entity_type + snapshot field
 *                               (case 27 — bank_account/cash_account use "balance",
 *                               exchange_deposit/broker_deposit use "amount")
 *   - splitChild              → null snapshots + details {split_quantity, split_direction}
 */
interface MkFlags {
  is_yield?: boolean;
  sell?: boolean;
  is_adjustment?: boolean;
  transfer_group_id?: string | null;
  delta?: number; // value routed to delta_{usd,eur}; cashflow_* set null
  cash?: boolean;
  cashType?: string;
  cashField?: "balance" | "amount";
  splitChild?: { split_quantity: number; split_direction?: number };
}

function mk(
  beforeQty: number,
  afterQty: number,
  value: number,
  flags: MkFlags = {},
): CostBasisTxn {
  const useDelta = flags.delta !== undefined;
  const deltaVal = flags.delta;

  // Resolve entity_type + snapshot field.
  let entityType = "crypto_position";
  let field = "quantity";
  if (flags.splitChild) {
    // split children carry null snapshots; entity_type irrelevant to quantityDelta
    return {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: flags.is_yield ?? false,
      is_adjustment: flags.is_adjustment ?? false,
      transfer_group_id: flags.transfer_group_id ?? null,
      split_from_id: "parent-1",
      cashflow_amount_usd: useDelta ? null : value,
      cashflow_amount_eur: useDelta ? null : value,
      delta_usd: useDelta ? deltaVal! : null,
      delta_eur: useDelta ? deltaVal! : null,
      before_snapshot: null,
      after_snapshot: null,
      details: {
        split_quantity: flags.splitChild.split_quantity,
        ...(flags.splitChild.split_direction !== undefined
          ? { split_direction: flags.splitChild.split_direction }
          : {}),
      },
    };
  }
  if (flags.cash || flags.cashType) {
    entityType = flags.cashType ?? "cash_account";
    field = flags.cashField ?? "balance";
  }

  return {
    entity_type: entityType,
    action: "updated",
    is_yield: flags.is_yield ?? false,
    is_adjustment: flags.is_adjustment ?? false,
    transfer_group_id: flags.transfer_group_id ?? null,
    split_from_id: null,
    cashflow_amount_usd: useDelta ? null : value,
    cashflow_amount_eur: useDelta ? null : value,
    delta_usd: useDelta ? deltaVal! : null,
    delta_eur: useDelta ? deltaVal! : null,
    before_snapshot: { [field]: beforeQty },
    after_snapshot: { [field]: afterQty },
    details: null,
  };
}

describe("computeCostBasis — engine cases from spec §10 + invariant", () => {
  // ── Case 1 · pure buy-and-hold ────────────────────────────────────────────
  it("1 · buy-and-hold: realized 0, unrealized = value − cost", () => {
    // buy 1@30000 → units 1, cost 30000.
    // currentValue 80000 → unrealized = 80000 − 30000 = 50000.
    // avgCost = 30000/1 = 30000. totalPnL = 0 + 50000 = 50000.
    const r = computeCostBasis([mk(0, 1, 30000)], 80000);
    expect(r.realized).toBe(0);
    expect(r.costBasis).toBe(30000);
    expect(r.unrealized).toBe(50000);
    expect(r.avgCost).toBe(30000);
    expect(r.totalPnL).toBe(50000);
  });

  // ── Case 2 · two buys then a partial sell uses average cost ────────────────
  it("2 · two buys then partial sell at average cost", () => {
    // buy 1@30000 → units 1, cost 30000.
    // buy 1@50000 → units 2, cost 80000. avg = 80000/2 = 40000.
    // sell 0.5 for 35000: avg 40000, out 0.5.
    //   realized = 35000 − 40000×0.5 = 35000 − 20000 = 15000.
    //   cost = 80000 − 40000×0.5 = 80000 − 20000 = 60000. units = 1.5.
    // currentValue 120000 → unrealized = 120000 − 60000 = 60000.
    // avgCost = 60000/1.5 = 40000. totalPnL = 15000 + 60000 = 75000.
    const r = computeCostBasis(
      [mk(0, 1, 30000), mk(1, 2, 50000), mk(2, 1.5, 35000, { sell: true })],
      120000,
    );
    expect(r.realized).toBeCloseTo(15000, 6);
    expect(r.costBasis).toBeCloseTo(60000, 6);
    expect(r.unrealized).toBeCloseTo(60000, 6);
    expect(r.avgCost).toBeCloseTo(40000, 6);
    expect(r.totalPnL).toBeCloseTo(75000, 6);
  });

  // ── Case 3 · sell at a loss → negative realized ───────────────────────────
  it("3 · sell at a loss → negative realized", () => {
    // buy 1@50000 → units 1, cost 50000. avg = 50000.
    // sell 0.5 for 15000: out 0.5.
    //   realized = 15000 − 50000×0.5 = 15000 − 25000 = −10000.
    //   cost = 50000 − 25000 = 25000. units = 0.5.
    const r = computeCostBasis(
      [mk(0, 1, 50000), mk(1, 0.5, 15000, { sell: true })],
      40000,
    );
    expect(r.realized).toBeCloseTo(-10000, 6);
    expect(r.costBasis).toBeCloseTo(25000, 6);
    // currentValue 40000 → unrealized = 40000 − 25000 = 15000; totalPnL = −10000 + 15000 = 5000.
    expect(r.unrealized).toBeCloseTo(15000, 6);
    expect(r.totalPnL).toBeCloseTo(5000, 6);
  });

  // ── Case 4 · full exit then re-buy restarts avg from 0/0 ──────────────────
  it("4 · full exit then re-buy restarts avg from 0/0; first-cycle realized preserved", () => {
    // buy 1@50000 → units 1, cost 50000.
    // sell ALL (1) for 60000: out 1.
    //   realized = 60000 − 50000×1 = 10000. cost = 0. units = 0 → EPS snap to exactly 0/0.
    // buy 1@20000 → units 1, cost 20000. avg = 20000.
    // costBasis = 20000, avgCost = 20000. realized stays 10000 (first cycle preserved).
    const r = computeCostBasis(
      [
        mk(0, 1, 50000),
        mk(1, 0, 60000, { sell: true }),
        mk(0, 1, 20000),
      ],
      25000,
    );
    expect(r.realized).toBeCloseTo(10000, 6);
    expect(r.costBasis).toBeCloseTo(20000, 6);
    expect(r.avgCost).toBeCloseTo(20000, 6);
    // currentValue 25000 → unrealized = 25000 − 20000 = 5000; totalPnL = 10000 + 5000 = 15000.
    expect(r.unrealized).toBeCloseTo(5000, 6);
    expect(r.totalPnL).toBeCloseTo(15000, 6);
  });

  // ── Case 5 · yield adds units at cost 0 and LOWERS avg ────────────────────
  it("5 · yield adds units at cost 0 and lowers avg", () => {
    // buy 1@40000 → units 1, cost 40000.
    // yield +0.1 (cost 0) → units 1.1, cost 40000.
    // avgCost = 40000/1.1 = 36363.6363… (< 40000, lowered).
    const r = computeCostBasis(
      [mk(0, 1, 40000), mk(1, 1.1, 0, { is_yield: true })],
      44000,
    );
    expect(r.costBasis).toBeCloseTo(40000, 6);
    expect(r.avgCost).toBeCloseTo(40000 / 1.1, 6); // 36363.636363…
    expect(r.realized).toBe(0);
  });

  // ── Case 6 · yield then sold → realized = FULL proceeds ───────────────────
  it("6 · yield then sold → realized = full proceeds (cost 0)", () => {
    // yield +1 (cost 0) → units 1, cost 0. avg = 0.
    // sell 1 for 500: out 1. realized = 500 − 0×1 = 500. cost = 0. units = 0 → snap.
    const r = computeCostBasis(
      [mk(0, 1, 0, { is_yield: true }), mk(1, 0, 500, { sell: true })],
      0,
    );
    expect(r.realized).toBeCloseTo(500, 6);
    expect(r.costBasis).toBe(0);
    expect(r.avgCost).toBe(0);
  });

  // ── Case 7 · airdrop / new asset as yield (first txn) ─────────────────────
  it("7 · airdrop as first txn (yield on a new asset) → cost 0", () => {
    // yield +10 (cost 0) → units 10, cost 0.
    // value 800 carried but yield ignores it for cost.
    // currentValue 800 → unrealized = 800 − 0 = 800.
    const r = computeCostBasis([mk(0, 10, 800, { is_yield: true })], 800);
    expect(r.costBasis).toBe(0);
    expect(r.unrealized).toBeCloseTo(800, 6);
    expect(r.avgCost).toBe(0);
    expect(r.realized).toBe(0);
  });

  // ── Case 8 · cash yield (bank interest) ───────────────────────────────────
  it("8 · cash yield (bank interest) → units + at cost 0", () => {
    // cash deposit 1000 (balance 0→1000) → units 1000, cost 1000.
    // cash yield +50 (balance 1000→1050, is_yield) → units 1050, cost 1000.
    const r = computeCostBasis(
      [
        mk(0, 1000, 1000, { cash: true }),
        mk(1000, 1050, 50, { cash: true, is_yield: true }),
      ],
      1050,
    );
    expect(r.costBasis).toBeCloseTo(1000, 6);
    // units 1050, cost 1000 → avg = 1000/1050.
    expect(r.avgCost).toBeCloseTo(1000 / 1050, 6);
    expect(r.realized).toBe(0);
  });

  // ── Case 9 · salary deposit (cash qty-up real flow) ───────────────────────
  it("9 · salary deposit (cash, qty-up real flow) → cost += value, mirror of buy", () => {
    // cash deposit 2000 (balance 0→2000) → units 2000, cost 2000 (real flow, NOT yield).
    const r = computeCostBasis([mk(0, 2000, 2000, { cash: true })], 2000);
    expect(r.costBasis).toBeCloseTo(2000, 6);
    expect(r.avgCost).toBeCloseTo(1, 6); // 2000/2000
    expect(r.realized).toBe(0);
    expect(r.unrealized).toBeCloseTo(0, 6);
  });

  // ── Case 11 · wallet→wallet move (same crypto) nets to ZERO ───────────────
  it("11 · wallet→wallet move nets to zero → cost-neutral (group skipped)", () => {
    // buy 1@30000 → units 1, cost 30000.
    // transfer group g1: leg A −1 (wallet A, delta 60000), leg B +1 (wallet B, delta 60000).
    //   net qty = −1 + 1 = 0 → SKIP the group entirely (no cost event).
    // Result: units 1, cost 30000, realized 0.
    const r = computeCostBasis(
      [
        mk(0, 1, 30000),
        mk(1, 0, 0, { is_adjustment: true, transfer_group_id: "g1", delta: 60000 }),
        mk(0, 1, 0, { is_adjustment: true, transfer_group_id: "g1", delta: 60000 }),
      ],
      80000,
    );
    expect(r.costBasis).toBeCloseTo(30000, 6);
    expect(r.realized).toBe(0);
    // currentValue 80000 → unrealized = 80000 − 30000 = 50000.
    expect(r.unrealized).toBeCloseTo(50000, 6);
  });

  // ── Case 12 · crypto→cash transfer (ONE leg in stream, disposal) ──────────
  it("12 · crypto→cash transfer → realizes gain at moved value |delta| (C3)", () => {
    // buy 1@30000 → units 1, cost 30000. avg = 30000.
    // transfer-out 1 (qty 1→0), is_adjustment, transfer_group g1, delta 60000.
    //   Only ONE leg in THIS asset's stream → normal disposal.
    //   value = |delta| = 60000 (C3 — NOT |cashflow|=0).
    //   out 1. realized = 60000 − 30000×1 = 30000. cost = 0. units = 0 → snap.
    const r = computeCostBasis(
      [
        mk(0, 1, 30000),
        mk(1, 0, 0, { is_adjustment: true, transfer_group_id: "g1", delta: 60000 }),
      ],
      0,
    );
    expect(r.realized).toBeCloseTo(30000, 6);
    expect(r.costBasis).toBe(0);
    expect(r.avgCost).toBe(0);
  });

  // ── Case 13 · lumped DCA vs many small buys → identical (date-independent) ─
  it("13 · lumped DCA equals ten small buys in {costBasis, avgCost}", () => {
    // Lump: buy 10@25000 → units 10, cost 25000.
    const lump = computeCostBasis([mk(0, 10, 25000)], 30000);
    // Ten 1-unit buys at 2500 each: cumulative qty 1..10, each cost 2500.
    //   total cost = 10×2500 = 25000, units 10. Identical totals.
    const drip: CostBasisTxn[] = [];
    for (let i = 0; i < 10; i++) drip.push(mk(i, i + 1, 2500));
    const dripR = computeCostBasis(drip, 30000);
    expect(lump.costBasis).toBeCloseTo(25000, 6);
    expect(lump.avgCost).toBeCloseTo(2500, 6); // 25000/10
    expect(dripR.costBasis).toBeCloseTo(lump.costBasis, 6);
    expect(dripR.avgCost).toBeCloseTo(lump.avgCost, 6);
  });

  // ── Case 17 · stablecoin (buys + yields on a cash-class entity) ───────────
  it("17 · stablecoin (USDC-like): deposit + yield behave class-agnostically", () => {
    // cash deposit 1000 → units 1000, cost 1000.
    // cash yield +20 (is_yield) → units 1020, cost 1000.
    const r = computeCostBasis(
      [
        mk(0, 1000, 1000, { cash: true }),
        mk(1000, 1020, 20, { cash: true, is_yield: true }),
      ],
      1020,
    );
    expect(r.costBasis).toBeCloseTo(1000, 6);
    expect(r.avgCost).toBeCloseTo(1000 / 1020, 6);
    // currentValue 1020 → unrealized = 1020 − 1000 = 20 (the yield = pure gain).
    expect(r.unrealized).toBeCloseTo(20, 6);
    expect(r.totalPnL).toBeCloseTo(20, 6);
  });

  // ── Case 18 · manual-NAV asset (has quantity; engine treats like any stock) ─
  it("18 · manual-NAV asset uses the engine like any stock", () => {
    // buy 100@10000 (subscription) → units 100, cost 10000.
    // currentValue 12000 → unrealized = 12000 − 10000 = 2000.
    const r = computeCostBasis([mk(0, 100, 10000)], 12000);
    expect(r.costBasis).toBeCloseTo(10000, 6);
    expect(r.unrealized).toBeCloseTo(2000, 6);
    expect(r.avgCost).toBeCloseTo(100, 6); // 10000/100
    expect(r.realized).toBe(0);
  });

  // ── Case 19 · editing/undoing recompute (pure fold) ───────────────────────
  it("19 · pure fold: same input → same output; an edited value recomputes", () => {
    const base: CostBasisTxn[] = [mk(0, 1, 30000), mk(1, 2, 50000)];
    const r1 = computeCostBasis(base, 120000);
    const r1again = computeCostBasis(base, 120000);
    // Determinism: identical inputs → identical outputs.
    expect(r1again).toEqual(r1);
    // Edit the 2nd buy's value 50000 → 60000: cost 30000+60000 = 90000, units 2, avg 45000.
    const edited: CostBasisTxn[] = [mk(0, 1, 30000), mk(1, 2, 60000)];
    const r2 = computeCostBasis(edited, 120000);
    expect(r1.costBasis).toBeCloseTo(80000, 6);
    expect(r2.costBasis).toBeCloseTo(90000, 6);
    expect(r2.avgCost).toBeCloseTo(45000, 6);
    // Only the changed leg differs the result.
    expect(r2.costBasis).not.toBeCloseTo(r1.costBasis, 6);
  });

  // ── Case 21 · NaN / garbage guards ────────────────────────────────────────
  it("21 · null/undefined value → 0; null-snapshot no-details row skipped; never NaN", () => {
    // buy 1 with NULL cashflow on a REAL (non-adjustment) flow → value resolves to 0.
    //   units 1, cost 0.
    const nullVal: CostBasisTxn = {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: false,
      transfer_group_id: null,
      split_from_id: null,
      cashflow_amount_usd: null,
      cashflow_amount_eur: null,
      delta_usd: null,
      delta_eur: null,
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      details: null,
    };
    // A fully-null row (no snapshots, no split details) → quantityDelta 0 → skipped.
    const garbage: CostBasisTxn = {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: false,
      transfer_group_id: null,
      split_from_id: null,
      cashflow_amount_usd: undefined,
      cashflow_amount_eur: undefined,
      delta_usd: undefined,
      delta_eur: undefined,
      before_snapshot: null,
      after_snapshot: null,
      details: null,
    };
    const r = computeCostBasis([nullVal, garbage], 5000);
    expect(r.costBasis).toBe(0); // null value → cost += 0
    expect(r.avgCost).toBe(0); // 0/1
    // Every field finite even with pathological TRANSACTION inputs (null/undefined values).
    expect(Number.isFinite(r.avgCost)).toBe(true);
    expect(Number.isFinite(r.costBasis)).toBe(true);
    expect(Number.isFinite(r.realized)).toBe(true);
    expect(Number.isFinite(r.unrealized)).toBe(true);
    expect(Number.isFinite(r.totalPnL)).toBe(true);
  });

  // ── Case 22 · float boundary at units→0 ───────────────────────────────────
  it("22 · float boundary: buy 0.3 in three 0.1 steps, sell 0.3 → units exactly 0", () => {
    // 0.1 + 0.1 + 0.1 = 0.30000000000000004 in IEEE-754; selling 0.3 leaves ~4e-17.
    // The EPS snap forces units = exactly 0 and cost = exactly 0 after the disposal.
    // buys: 0.1@10, 0.1@10, 0.1@10 → cost 30, units ~0.3.
    // sell 0.3 for 12: out = min(0.3, units) ≈ 0.3 (clamped to held). realized ≈ 12 − 30 = −18.
    // After disposal |units| < EPS → snap to 0/0.
    const txns: CostBasisTxn[] = [
      mk(0, 0.1, 10),
      mk(0.1, 0.2, 10),
      mk(0.2, 0.30000000000000004, 10),
      mk(0.30000000000000004, 0, 12, { sell: true }),
    ];
    const r = computeCostBasis(txns, 0);
    expect(r.costBasis).toBe(0); // EXACTLY 0, not 4e-17 worth of drift
    expect(r.avgCost).toBe(0);
    expect(r.realized).toBeCloseTo(-18, 6);
    // Re-buy restarts cleanly from 0/0.
    const reBuy = computeCostBasis([...txns, mk(0, 1, 100)], 100);
    expect(reBuy.costBasis).toBeCloseTo(100, 6);
    expect(reBuy.avgCost).toBeCloseTo(100, 6);
  });

  // ── Case 23 · split child (NULL snapshots) ────────────────────────────────
  it("23 · split child uses split_direction × split_quantity (disposal & acquisition)", () => {
    // First a buy 1@30000 → units 1, cost 30000 (avg 30000).
    // Split-child SELL: details {split_quantity 0.5, split_direction −1} → qtyDelta −0.5.
    //   value 40000 (cashflow). out 0.5. realized = 40000 − 30000×0.5 = 40000 − 15000 = 25000.
    //   cost = 30000 − 15000 = 15000. units 0.5.
    const sellChild = computeCostBasis(
      [mk(0, 1, 30000), mk(0, 0, 40000, { splitChild: { split_quantity: 0.5, split_direction: -1 } })],
      30000,
    );
    expect(sellChild.realized).toBeCloseTo(25000, 6);
    expect(sellChild.costBasis).toBeCloseTo(15000, 6);

    // Split-child BUY with explicit +1: qtyDelta +0.5, value 20000 → cost += 20000.
    const buyChild = computeCostBasis(
      [mk(0, 1, 30000), mk(0, 0, 20000, { splitChild: { split_quantity: 0.5, split_direction: 1 } })],
      60000,
    );
    // units 1.5, cost 50000.
    expect(buyChild.costBasis).toBeCloseTo(50000, 6);

    // Split-child BUY with ABSENT split_direction (defaults to +1): same as above.
    const defaultChild = computeCostBasis(
      [mk(0, 1, 30000), mk(0, 0, 20000, { splitChild: { split_quantity: 0.5 } })],
      60000,
    );
    expect(defaultChild.costBasis).toBeCloseTo(50000, 6);
  });

  // ── Case 24 · transfer FEE remainder → realized loss at value 0 (B5) ──────
  it("24 · transfer fee remainder → ONE synthetic disposal at value 0 → realized loss", () => {
    // buy 1@30000 → units 1, cost 30000. avg = 30000.
    // transfer group g1, TWO legs: −1.000 (delta) and +0.999 (delta).
    //   net qty = −1.000 + 0.999 = −0.001 (small non-zero, same-asset FEE).
    //   → ONE synthetic disposal of 0.001 at value = 0 (B5).
    //   out = min(0.001, 1) = 0.001. realized = 0 − 30000×0.001 = −30 (LOSS).
    //   cost = 30000 − 30000×0.001 = 30000 − 30 = 29970. units = 0.999.
    const r = computeCostBasis(
      [
        mk(0, 1, 30000),
        mk(1, 0, 0, { is_adjustment: true, transfer_group_id: "g1", delta: 30000 }), // −1.000
        mk(0, 0.999, 0, { is_adjustment: true, transfer_group_id: "g1", delta: 29970 }), // +0.999
      ],
      0,
    );
    expect(r.realized).toBeCloseTo(-30, 6);
    expect(r.costBasis).toBeCloseTo(29970, 6);
    // units 0.999, cost 29970 → avg = 29970/0.999 = 30000 (avg unchanged by a fee at value 0).
    expect(r.avgCost).toBeCloseTo(30000, 6);
  });

  // ── Case 27 · cash across ALL FOUR cash entity types ──────────────────────
  it("27 · deposit moves units for each of the four cash entity types", () => {
    // bank_account / cash_account → "balance"; exchange_deposit / broker_deposit → "amount".
    const cases: Array<{ type: string; field: "balance" | "amount" }> = [
      { type: "bank_account", field: "balance" },
      { type: "cash_account", field: "balance" },
      { type: "exchange_deposit", field: "amount" },
      { type: "broker_deposit", field: "amount" },
    ];
    for (const { type, field } of cases) {
      // deposit 500 (field 0→500) → units 500, cost 500.
      const r = computeCostBasis([mk(0, 500, 500, { cashType: type, cashField: field })], 500);
      expect(r.costBasis).toBeCloseTo(500, 6);
      expect(r.avgCost).toBeCloseTo(1, 6); // 500/500
      expect(r.realized).toBe(0);
    }
  });

  // ── Case 30 · oversell clamp + onAnomaly (H4) ─────────────────────────────
  it("30 · oversell (disposal exceeds running units) is clamped + fires onAnomaly", () => {
    const spy = vi.fn();
    // A lone sell row (before 1 → after 0 → qtyDelta −1) processed while running units = 0
    // (the supplying buy is missing / backdated later). Genuine oversell:
    //   avg = 0 (no units). out = min(1, 0) = 0 (clamped). realized += 150 − 0×0 = 150.
    //   units stays 0; cost stays 0. costBasis 0, avgCost 0. onAnomaly called.
    const r = computeCostBasis([mk(1, 0, 150, { sell: true })], 0, { onAnomaly: spy });
    expect(r.costBasis).toBeGreaterThanOrEqual(0);
    expect(r.avgCost).toBeGreaterThanOrEqual(0);
    expect(r.costBasis).toBe(0);
    expect(r.avgCost).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("oversell"));
  });

  it("30b · legitimate full exit (sell exactly units) does NOT fire onAnomaly", () => {
    const spy = vi.fn();
    // buy 1@100 → units 1. sell exactly 1 → out = min(1,1) = 1, NOT > units → no anomaly.
    computeCostBasis([mk(0, 1, 100), mk(1, 0, 120, { sell: true })], 0, { onAnomaly: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Case 31a · correction balance-DOWN is off-book (H3) ───────────────────
  it("31a · correction balance-DOWN removes cost basis, no realized; identity does NOT hold", () => {
    // buy 1@30000 → units 1, cost 30000. avg = 30000.
    // correction −0.2 (is_adjustment, NO transfer_group, NOT yield): isCorrection true.
    //   avg = 30000. out = min(0.2, 1) = 0.2.
    //   cost = 30000 − 30000×0.2 = 30000 − 6000 = 24000. units = 0.8. realized UNCHANGED (0).
    const r = computeCostBasis(
      [mk(0, 1, 30000), mk(1, 0.8, 12345, { is_adjustment: true, delta: 12345 })],
      40000,
    );
    expect(r.realized).toBe(0); // correction books NO realized
    expect(r.costBasis).toBeCloseTo(24000, 6);
    // currentValue 40000 → unrealized = 40000 − 24000 = 16000; totalPnL = 0 + 16000 = 16000.
    expect(r.totalPnL).toBeCloseTo(16000, 6);

    // Identity (buy/sell/yield-only) deliberately does NOT hold across a correction:
    //   Σproceeds = 0 (no sell), Σcost = 30000 (the buy).
    //   currentValue + Σproceeds − Σcost = 40000 + 0 − 30000 = 10000.
    //   totalPnL = 16000 ≠ 10000. Assert the inequality (corrections are off-book).
    const identityRHS = 40000 + 0 - 30000; // = 10000
    expect(r.totalPnL).not.toBeCloseTo(identityRHS, 6);
  });

  // ── Case 31b · correction balance-UP at zero cost; costBasis unchanged ────
  it("31b · correction balance-UP raises units at zero cost; costBasis unchanged", () => {
    // buy 1@30000 → units 1, cost 30000. avg = 30000.
    // correction +0.5 (is_adjustment, NO transfer_group, NOT yield): isCorrection true, qty-up.
    //   units += 0.5 → 1.5. cost += 0 → 30000 (NO phantom cost).
    //   avg = 30000/1.5 = 20000 (dropped).
    const r = computeCostBasis(
      [mk(0, 1, 30000), mk(1, 1.5, 9999, { is_adjustment: true, delta: 9999 })],
      45000,
    );
    expect(r.costBasis).toBeCloseTo(30000, 6); // unchanged — no phantom cost
    expect(r.avgCost).toBeCloseTo(20000, 6); // 30000/1.5
    expect(r.realized).toBe(0);
  });

  // ── INVARIANT property test (buy/sell/yield ONLY) ─────────────────────────
  it("INVARIANT: totalPnL === currentValue + Σproceeds − Σcost over buy/sell/yield only", () => {
    // Numerical Recipes LCG: multiplier 1664525, increment 1013904223, modulus 2^32 — deterministic; never replace with Math.random().
    let seed = 0x2545f491; // arbitrary fixed seed
    const rand = (): number => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x100000000; // [0,1)
    };

    for (let iter = 0; iter < 100; iter++) {
      const txns: CostBasisTxn[] = [];
      let units = 0; // model the running units so generated sells never exceed holdings (no clamp)
      let sumProceeds = 0;
      let sumCost = 0;
      const steps = 3 + Math.floor(rand() * 8); // 3..10 events

      for (let s = 0; s < steps; s++) {
        const roll = rand();
        if (units < 1e-6 || roll < 0.5) {
          // BUY: qty in [0.1, 2.1), value in [10, 1010). Cent-round both (NUMERIC(18,2)).
          const qty = Math.round((0.1 + rand() * 2) * 100) / 100;
          const value = Math.round((10 + rand() * 1000) * 100) / 100;
          if (qty <= 0) continue;
          txns.push(mk(units, units + qty, value));
          units += qty;
          sumCost += value;
        } else if (roll < 0.8) {
          // SELL: qty in (0, units] (never exceeds → no clamp). value cent-rounded.
          const qty = Math.round(Math.min(units, 0.05 + rand() * units) * 100) / 100;
          if (qty <= 0) continue;
          const value = Math.round((10 + rand() * 1000) * 100) / 100;
          txns.push(mk(units, units - qty, value, { sell: true }));
          units -= qty;
          sumProceeds += value;
          // The engine's own EPS snap zeroes units after a disposal that lands within EPS.
          if (units < 1e-9) units = 0;
        } else {
          // YIELD: qty in [0.01, 0.51), cost 0 → does NOT touch Σcost/Σproceeds.
          const qty = Math.round((0.01 + rand() * 0.5) * 100) / 100;
          if (qty <= 0) continue;
          txns.push(mk(units, units + qty, qty * 5, { is_yield: true }));
          units += qty;
        }
      }

      const currentValue = Math.round((rand() * 100000) * 100) / 100;
      const r = computeCostBasis(txns, currentValue);
      const rhs = currentValue + sumProceeds - sumCost;
      // Tolerance loose enough for cent-rounded inputs accumulated over up to 10 steps.
      expect(Math.abs(r.totalPnL - rhs)).toBeLessThan(1e-6);
    }
  });

  // ── Currency selection: the opts.currency pass reads the right column ─────
  it("currency: default EUR pass and explicit USD pass read their own columns", () => {
    // A row with DIVERGENT eur/usd amounts (mk puts the SAME value in both, so build by hand).
    const txn: CostBasisTxn = {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: false,
      transfer_group_id: null,
      split_from_id: null,
      cashflow_amount_usd: 33000, // USD cost
      cashflow_amount_eur: 30000, // EUR cost
      delta_usd: null,
      delta_eur: null,
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      details: null,
    };
    const eur = computeCostBasis([txn], 40000); // default currency "eur"
    const usd = computeCostBasis([txn], 44000, { currency: "usd" });
    expect(eur.costBasis).toBeCloseTo(30000, 6); // read cashflow_amount_eur
    expect(usd.costBasis).toBeCloseTo(33000, 6); // read cashflow_amount_usd
  });

  it("currency: adjustment leg reads delta in the selected currency (C3)", () => {
    // crypto→cash transfer disposal valued from delta, divergent per currency.
    const txns: CostBasisTxn[] = [
      mk(0, 1, 30000), // buy (both columns 30000)
      {
        entity_type: "crypto_position",
        action: "updated",
        is_yield: false,
        is_adjustment: true,
        transfer_group_id: "g1",
        split_from_id: null,
        cashflow_amount_usd: null,
        cashflow_amount_eur: null,
        delta_usd: 66000, // USD moved value
        delta_eur: 60000, // EUR moved value
        before_snapshot: { quantity: 1 },
        after_snapshot: { quantity: 0 },
        details: null,
      },
    ];
    const eur = computeCostBasis(txns, 0);
    const usd = computeCostBasis(txns, 0, { currency: "usd" });
    // EUR: realized = 60000 − 30000 = 30000.
    expect(eur.realized).toBeCloseTo(30000, 6);
    // USD: realized = 66000 − 30000 = 36000.
    expect(usd.realized).toBeCloseTo(36000, 6);
  });
});

describe("computeAssetPnL — per-currency (§7.7, case 26)", () => {
  // ── Case 26a · divergent EUR vs USD amounts are each internally consistent ──
  it("26a · buy with divergent currency amounts: each pass internally consistent; results differ", () => {
    // buy 1 unit: cashflow_amount_eur = 30000, cashflow_amount_usd = 33000
    const txn: CostBasisTxn = {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: false,
      transfer_group_id: null,
      split_from_id: null,
      cashflow_amount_eur: 30000,
      cashflow_amount_usd: 33000,
      delta_eur: null,
      delta_usd: null,
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      details: null,
    };
    const result = computeAssetPnL(
      [txn],
      { valueEur: 40000, valueUsd: 44000 },
    );

    // EUR pass: costBasis = 30000, unrealized = 40000 − 30000 = 10000
    expect(result.eur.costBasis).toBe(30000);
    expect(result.eur.unrealized).toBe(10000);

    // USD pass: costBasis = 33000, unrealized = 44000 − 33000 = 11000
    expect(result.usd.costBasis).toBe(33000);
    expect(result.usd.unrealized).toBe(11000);

    // Divergence is LEGITIMATE — never reconciled. Assert they differ.
    expect(result.eur.costBasis).not.toBe(result.usd.costBasis);
    expect(result.eur.unrealized).not.toBe(result.usd.unrealized);
  });

  // ── Case 26b · C3 disposal (adjustment leg) diverges per currency too ──────
  it("26b · C3 disposal leg: realized diverges per currency; each pass consistent", () => {
    // buy 1 unit at 30000 EUR / 33000 USD (both columns equal from mk)
    const buy = mk(0, 1, 30000);
    // Override buy's per-currency amounts to be divergent.
    const divergentBuy: CostBasisTxn = {
      ...buy,
      cashflow_amount_eur: 30000,
      cashflow_amount_usd: 33000,
    };

    // adjustment-leg disposal: delta_eur = 60000, delta_usd = 66000
    const disposal: CostBasisTxn = {
      entity_type: "crypto_position",
      action: "updated",
      is_yield: false,
      is_adjustment: true,
      transfer_group_id: "g-26b",
      split_from_id: null,
      cashflow_amount_eur: null,
      cashflow_amount_usd: null,
      delta_eur: 60000,
      delta_usd: 66000,
      before_snapshot: { quantity: 1 },
      after_snapshot: { quantity: 0 },
      details: null,
    };

    const result = computeAssetPnL(
      [divergentBuy, disposal],
      { valueEur: 0, valueUsd: 0 },
    );

    // EUR pass: realized = 60000 − 30000 = 30000
    expect(result.eur.realized).toBeCloseTo(30000, 6);

    // USD pass: realized = 66000 − 33000 = 33000
    expect(result.usd.realized).toBeCloseTo(33000, 6);

    // They differ — the divergence is legitimate.
    expect(result.eur.realized).not.toBeCloseTo(result.usd.realized, 6);
  });

  // ── Case 26c · onAnomaly is forwarded to BOTH passes ─────────────────────
  it("26c · onAnomaly forwarded to both passes: spy called twice on oversell fixture", () => {
    const spy = vi.fn();

    // A lone sell (no prior buy) triggers an oversell in EACH pass independently.
    const oversell = mk(1, 0, 150, { sell: true });

    computeAssetPnL(
      [oversell],
      { valueEur: 0, valueUsd: 0 },
      { onAnomaly: spy },
    );

    // One call per pass (EUR + USD).
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("oversell"));
  });
});

/*
 * §10 cases that live in OTHER files (not the pure engine) — listed so the audit
 * can account for all 27+:
 *   10 (buy-with-tracked-cash must be a Transfer / no double-count) → benchmark + integration
 *   14 (split with explicit per-leg costs; quantities sum; reversible)  → split-helpers.test
 *   15 (backdate an existing real cash-flow lot; amount recomputed)     → cost-basis-backdate (Task 1.5)
 *   16 (multi-currency cost stored both via FX-at-date)                 → Task 1.4b (addTransaction)
 *   20 (long yield history → drawer groups/collapses)                   → component test
 *   25 (backdated lot, user cost ≠ market → benchmark seeds at cost)    → Task 3.4 (seed)
 *   26 (EUR vs USD avg-cost divergence; EUR authoritative)              → Task 3.2 (per-currency wrapper)
 *   28 (un-yield lossless: is_yield toggles, amount never zeroed)       → integration
 *   29 (cost override persists: cashflow_amount + cashflow_user_set)    → integration
 */
