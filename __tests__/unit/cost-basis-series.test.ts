import { describe, it, expect, vi } from "vitest";
import {
  buildCostBasisSeries,
  type CostBasisSeriesAsset,
  type CostBasisSeriesTxn,
  type HistoricalPriceRow,
} from "@/lib/portfolio/historical-prices-augmentation";
import type { CostBasisTxn } from "@/lib/portfolio/cost-basis";

/**
 * Unit tests for buildCostBasisSeries (Task 3.4a) — hand-computed.
 *
 * Conventions that keep the arithmetic trivial:
 *   - All crypto lots are native-USD (the cache stores crypto as {SYM}-USD).
 *   - EUR FX is seeded at price 1.0 (USD per 1 EUR = 1) on every date used, so
 *     `eur === usd` for every market valuation (lotContributionAtDate divides
 *     usd by usdPerUnit("EUR") = 1). Cost columns read |cashflow_amount_{cur}|
 *     directly, so EUR/USD costs are whatever we seed per currency.
 *   - Dates are a tiny explicit daily spine.
 */

/** A crypto_position txn with quantity snapshots + per-currency cashflow value. */
function txn(
  beforeQty: number | null,
  afterQty: number,
  opts: {
    date: string;
    cashflowUsd?: number;
    cashflowEur?: number;
    deltaUsd?: number | null;
    deltaEur?: number | null;
    is_yield?: boolean;
    is_adjustment?: boolean;
    cashflow_user_set?: boolean;
    /** Transfer-group id; when set the leg folds through the engine (netting + C3). */
    transfer_group_id?: string | null;
  },
): CostBasisSeriesTxn & { date: string } {
  const useDelta = opts.deltaUsd !== undefined || opts.deltaEur !== undefined;
  const t: CostBasisTxn = {
    entity_type: "crypto_position",
    action: beforeQty === null ? "created" : "updated",
    is_yield: opts.is_yield ?? false,
    is_adjustment: opts.is_adjustment ?? false,
    transfer_group_id: opts.transfer_group_id ?? null,
    split_from_id: null,
    cashflow_amount_usd: useDelta ? null : opts.cashflowUsd ?? null,
    cashflow_amount_eur: useDelta ? null : opts.cashflowEur ?? null,
    delta_usd: opts.deltaUsd ?? null,
    delta_eur: opts.deltaEur ?? null,
    before_snapshot: beforeQty === null ? null : { quantity: beforeQty },
    after_snapshot: { quantity: afterQty },
    details: null,
  };
  return { txn: t, date: opts.date, cashflow_user_set: opts.cashflow_user_set ?? false };
}

/**
 * A cash_account txn with `balance` snapshots (quantityDelta reads `balance`, not
 * `quantity`, for cash entities). The transfer-IN leg of a crypto→cash transfer
 * lives here: `is_adjustment=true`, value carried in `delta_{cur}`.
 */
function cashTxn(
  beforeBal: number | null,
  afterBal: number,
  opts: {
    date: string;
    deltaUsd?: number | null;
    deltaEur?: number | null;
    is_adjustment?: boolean;
    transfer_group_id?: string | null;
  },
): CostBasisSeriesTxn & { date: string } {
  const t: CostBasisTxn = {
    entity_type: "cash_account",
    action: beforeBal === null ? "created" : "updated",
    is_yield: false,
    is_adjustment: opts.is_adjustment ?? false,
    transfer_group_id: opts.transfer_group_id ?? null,
    split_from_id: null,
    cashflow_amount_usd: null,
    cashflow_amount_eur: null,
    delta_usd: opts.deltaUsd ?? null,
    delta_eur: opts.deltaEur ?? null,
    before_snapshot: beforeBal === null ? null : { balance: beforeBal },
    after_snapshot: { balance: afterBal },
    details: null,
  };
  return { txn: t, date: opts.date, cashflow_user_set: false };
}

/** Price rows for a crypto asset over the given (date→price) pairs, plus EUR=1 FX. */
function prices(
  cgId: string,
  pricePoints: Array<[string, number]>,
  fxDates: string[],
): HistoricalPriceRow[] {
  const rows: HistoricalPriceRow[] = pricePoints.map(([price_date, price]) => ({
    asset_kind: "crypto",
    asset_key: cgId,
    price_date,
    price,
    currency: "USD",
  }));
  for (const d of fxDates) {
    rows.push({ asset_kind: "fx", asset_key: "EUR", price_date: d, price: 1.0, currency: "USD" });
  }
  return rows;
}

const SPINE = ["2023-01-01", "2023-01-02", "2023-01-03"];

describe("buildCostBasisSeries (Task 3.4a)", () => {
  // 1. A real backdated lot (cost €5,000) → cryptoCostEur 5000 from its date on; 0 before.
  it("1. real backdated lot books its cost from its effective date forward", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      // Buy 1 unit on 2023-01-02, cost 5000 USD + 5000 EUR.
      txns: [txn(null, 1, { date: "2023-01-02", cashflowUsd: 5000, cashflowEur: 5000 })],
    };
    const { series, uncoveredGapLots } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [["2023-01-02", 6000]], SPINE),
      dates: SPINE,
    });

    expect(series[0].date).toBe("2023-01-01");
    expect(series[0].cryptoCostEur).toBe(0); // before the lot
    expect(series[0].cryptoCostUsd).toBe(0);
    expect(series[1].cryptoCostEur).toBe(5000); // from effective date on
    expect(series[1].cryptoCostUsd).toBe(5000);
    expect(series[2].cryptoCostEur).toBe(5000); // forward-filled
    // No user-costed rows → no gap, no uncovered.
    expect(series[1].cryptoGapEur).toBe(0);
    expect(uncoveredGapLots).toBe(0);
  });

  // 2. A BARE correction (is_adjustment, NO transfer_group_id) → its MARKET value at
  //    each date (changes with price), NOT its cost/0. Transfer legs fold through the
  //    engine instead (test 10+); only bare corrections keep market valuation
  //    (product decision 2026-06-04).
  it("2. bare correction (no transfer group) is market-valued at each date (not folded to cost)", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "eth",
      native_currency: "USD",
      asset_class: "crypto",
      // Bare correction: +2 units on 2023-01-01, value carried in delta (cashflow null),
      // transfer_group_id null → market-valued (the txn() helper defaults the group to null).
      txns: [
        txn(null, 2, { date: "2023-01-01", deltaUsd: 1234, deltaEur: 1234, is_adjustment: true }),
      ],
    };
    // Price moves 100 → 110 → 120; qty 2 → market 200 / 220 / 240.
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("eth", [
        ["2023-01-01", 100],
        ["2023-01-02", 110],
        ["2023-01-03", 120],
      ], SPINE),
      dates: SPINE,
    });

    // Market value (qty 2 × price), NOT the delta(1234) and NOT 0.
    expect(series[0].cryptoCostUsd).toBeCloseTo(200, 6);
    expect(series[1].cryptoCostUsd).toBeCloseTo(220, 6);
    expect(series[2].cryptoCostUsd).toBeCloseTo(240, 6);
    // EUR mirror (fx=1) equals USD.
    expect(series[2].cryptoCostEur).toBeCloseTo(240, 6);
  });

  // 3. A stablecoin lot → cash columns (caller passes asset_class "cash").
  it("3. stablecoin lot (asset_class cash) books into cash columns", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto", // stays crypto kind (priced by coingecko_id)
      asset_key: "usdc",
      native_currency: "USD",
      asset_class: "cash", // reclassified by caller (mirrors value line)
      txns: [txn(null, 1000, { date: "2023-01-01", cashflowUsd: 1000, cashflowEur: 1000 })],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("usdc", [["2023-01-01", 1]], SPINE),
      dates: SPINE,
    });

    expect(series[0].cashCostUsd).toBe(1000);
    expect(series[0].cashCostEur).toBe(1000);
    expect(series[0].cryptoCostUsd).toBe(0); // NOT crypto
  });

  // 4. A user-costed lot (cost 5k, market 8k at D) → cryptoGapUsd/Eur = 3000 at D.
  it("4. user-costed lot gap = market − cost", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      // Buy 1 unit, user-typed cost 5000 (both currencies), on 2023-01-01.
      txns: [
        txn(null, 1, {
          date: "2023-01-01",
          cashflowUsd: 5000,
          cashflowEur: 5000,
          cashflow_user_set: true,
        }),
      ],
    };
    // Price 8000 → market value (qty 1) = 8000; gap = 8000 − 5000 = 3000.
    const { series, uncoveredGapLots } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [["2023-01-01", 8000]], SPINE),
      dates: SPINE,
    });

    expect(series[0].cryptoCostUsd).toBe(5000); // cost still booked
    expect(series[0].cryptoGapUsd).toBeCloseTo(3000, 6);
    expect(series[0].cryptoGapEur).toBeCloseTo(3000, 6);
    expect(uncoveredGapLots).toBe(0);
  });

  // 5. A NON-user-costed lot → gap 0 (the gate).
  it("5. non-user-costed lot contributes NO gap", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      // Same buy but cashflow_user_set defaults false.
      txns: [txn(null, 1, { date: "2023-01-01", cashflowUsd: 5000, cashflowEur: 5000 })],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [["2023-01-01", 8000]], SPINE),
      dates: SPINE,
    });

    expect(series[0].cryptoCostUsd).toBe(5000); // cost still booked
    expect(series[0].cryptoGapUsd).toBe(0); // but NO gap (gate closed)
    expect(series[0].cryptoGapEur).toBe(0);
  });

  // 6. A user-costed YIELD row → gap EXCLUDES it (NOT is_yield).
  it("6. user-costed yield row is excluded from the gap", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Real user-costed buy: 1 unit @ 5000.
        txn(null, 1, {
          date: "2023-01-01",
          cashflowUsd: 5000,
          cashflowEur: 5000,
          cashflow_user_set: true,
        }),
        // Yield: +1 unit, ALSO flagged user-costed (must still be excluded from gap).
        txn(1, 2, {
          date: "2023-01-02",
          cashflowUsd: 4000,
          cashflowEur: 4000,
          is_yield: true,
          cashflow_user_set: true,
        }),
      ],
    };
    // Price 8000 throughout. Gap is over the user-costed NON-yield quantity ONLY (1 unit):
    // market(1 × 8000)=8000 − userCost(5000) = 3000 — the yield's +1 unit and its 4000 are excluded.
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [
        ["2023-01-01", 8000],
        ["2023-01-02", 8000],
      ], SPINE),
      dates: SPINE,
    });

    // After the yield (2023-01-02 on), the gap stays 3000 (yield unit excluded).
    expect(series[1].cryptoGapUsd).toBeCloseTo(3000, 6);
    expect(series[2].cryptoGapUsd).toBeCloseTo(3000, 6);
    // Cost column DOES include the yield (yield adds 0 cost): total cost stays 5000.
    expect(series[2].cryptoCostUsd).toBe(5000);
  });

  // 7. A disposal reduces the running cost (sell half → cost halves under avg-cost).
  it("7. disposal reduces running cost (avg-cost: sell half → cost halves)", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Buy 2 units @ total 10000 on day 1 (avg 5000/unit).
        txn(null, 2, { date: "2023-01-01", cashflowUsd: 10000, cashflowEur: 10000 }),
        // Sell 1 unit on day 2 (proceeds irrelevant to cost): cost releases avg×1 = 5000.
        txn(2, 1, { date: "2023-01-02", cashflowUsd: 7000, cashflowEur: 7000 }),
      ],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [
        ["2023-01-01", 6000],
        ["2023-01-02", 6000],
      ], SPINE),
      dates: SPINE,
    });

    expect(series[0].cryptoCostUsd).toBe(10000); // after the buy
    expect(series[1].cryptoCostUsd).toBeCloseTo(5000, 6); // after selling half
    expect(series[2].cryptoCostUsd).toBeCloseTo(5000, 6); // forward-filled
  });

  // 8. Missing price coverage on a user-costed lot at D → gap 0 + uncovered counter increments.
  it("8. user-costed lot with no price at D → gap 0 + uncoveredGapLots increments", () => {
    const onAnomaly = vi.fn();
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        txn(null, 1, {
          date: "2023-01-01",
          cashflowUsd: 5000,
          cashflowEur: 5000,
          cashflow_user_set: true,
        }),
      ],
    };
    // NO price rows for btc at all (only FX) → lotContributionAtDate returns null
    // for every date the lot is live (qty 1 from 2023-01-01 on).
    const { series, uncoveredGapLots } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [], SPINE), // empty price points, FX present
      dates: SPINE,
      onAnomaly,
    });

    // Cost is still booked (cost doesn't need a price).
    expect(series[0].cryptoCostUsd).toBe(5000);
    // Gap could not be priced → 0 contribution.
    expect(series[0].cryptoGapUsd).toBe(0);
    // The lot is live on all 3 spine days → 3 uncovered (lot × date) pairs.
    expect(uncoveredGapLots).toBe(3);
    expect(onAnomaly).toHaveBeenCalled();
  });

  // 9. Empty input → empty/zero series (no NaN anywhere).
  it("9. empty assets → all-zero series, no NaN", () => {
    const { series, uncoveredGapLots } = buildCostBasisSeries({
      assets: [],
      prices: [],
      dates: SPINE,
    });

    expect(series).toHaveLength(3);
    for (const p of series) {
      for (const [k, v] of Object.entries(p)) {
        if (k === "date") continue;
        expect(Number.isNaN(v as number)).toBe(false);
        expect(v).toBe(0);
      }
    }
    expect(uncoveredGapLots).toBe(0);
  });

  // Bonus: fully empty dates → empty series (degenerate spine).
  it("handles an empty date spine without throwing", () => {
    const { series } = buildCostBasisSeries({ assets: [], prices: [], dates: [] });
    expect(series).toEqual([]);
  });

  // ── Transfer-leg folding (product decision 2026-06-04: overlay uniform with sells) ──
  // Transfer legs (is_adjustment AND transfer_group_id != null) fold through the
  // engine (buildStream netting + foldCostStep), NOT the market-valued adj bucket.
  // Bare corrections (is_adjustment, NO transfer_group_id) keep market valuation (test 2).

  // 10. THE UNIFORMITY CASE (the user's example): a crypto→cash transfer.
  //     Two assets, each sees exactly ONE leg of group "g1" (the cross-asset path).
  //     Crypto OUT: avg-cost released from the crypto cost line (uniform with a sell).
  //     Cash IN: the transfer value booked onto the cash cost line.
  it("10. cross-asset transfer leg folds through the engine (crypto cost released, cash cost added)", () => {
    const crypto: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Buy 1 @ cost 30000 (both currencies) on day 1.
        txn(null, 1, { date: "2023-01-01", cashflowUsd: 30000, cashflowEur: 30000 }),
        // Transfer OUT 0.5 on day 2: is_adjustment + group g1, value in delta (25000).
        txn(1, 0.5, {
          date: "2023-01-02",
          deltaUsd: 25000,
          deltaEur: 25000,
          is_adjustment: true,
          transfer_group_id: "g1",
        }),
      ],
    };
    const cash: CostBasisSeriesAsset = {
      asset_kind: "cash",
      asset_key: "wallet-eur",
      native_currency: "USD", // keep arithmetic trivial (FX=1); face value used for any market lookup
      asset_class: "cash",
      txns: [
        // Transfer IN: balance +25000 on day 2, is_adjustment + matching group g1.
        cashTxn(0, 25000, {
          date: "2023-01-02",
          deltaUsd: 25000,
          deltaEur: 25000,
          is_adjustment: true,
          transfer_group_id: "g1",
        }),
      ],
    };
    const { series } = buildCostBasisSeries({
      assets: [crypto, cash],
      prices: prices("btc", [
        ["2023-01-01", 60000],
        ["2023-01-02", 60000],
      ], SPINE),
      dates: SPINE,
    });

    // Crypto cost: 30000 before the transfer; avg released on the OUT leg → 15000.
    //   avg = 30000/1; out = 0.5; cost -= 30000×0.5 = 15000.
    expect(series[0].cryptoCostUsd).toBe(30000); // before the transfer
    expect(series[0].cryptoCostEur).toBe(30000);
    expect(series[1].cryptoCostUsd).toBeCloseTo(15000, 6); // OUT leg folded (uniform with a sell)
    expect(series[1].cryptoCostEur).toBeCloseTo(15000, 6);
    expect(series[2].cryptoCostUsd).toBeCloseTo(15000, 6); // forward-filled

    // Cash cost: the IN leg books the transfer value (25000) onto the cash cost line.
    expect(series[0].cashCostUsd).toBe(0); // before the transfer
    expect(series[1].cashCostUsd).toBeCloseTo(25000, 6); // IN leg folded
    expect(series[1].cashCostEur).toBeCloseTo(25000, 6);
    expect(series[2].cashCostUsd).toBeCloseTo(25000, 6); // forward-filled
  });

  // 11. WALLET↔WALLET: BOTH legs of the same group live in ONE crypto asset's stream
  //     (−1 / +1, net 0). buildStream nets them to zero → SKIP → cost unchanged.
  //     Previously this came from the adj bucket contributing 0; it must now come from
  //     the engine's netting skip.
  it("11. wallet↔wallet transfer (both legs same asset, net 0) leaves cost unchanged", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Buy 2 @ 20000 on day 1.
        txn(null, 2, { date: "2023-01-01", cashflowUsd: 20000, cashflowEur: 20000 }),
        // Move out of wallet A (−1) and into wallet B (+1), same group g2, day 2.
        txn(2, 1, {
          date: "2023-01-02",
          deltaUsd: 12000,
          deltaEur: 12000,
          is_adjustment: true,
          transfer_group_id: "g2",
        }),
        txn(1, 2, {
          date: "2023-01-02",
          deltaUsd: 12000,
          deltaEur: 12000,
          is_adjustment: true,
          transfer_group_id: "g2",
        }),
      ],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [
        ["2023-01-01", 30000],
        ["2023-01-02", 30000],
      ], SPINE),
      dates: SPINE,
    });

    expect(series[0].cryptoCostUsd).toBe(20000); // after the buy
    expect(series[1].cryptoCostUsd).toBeCloseTo(20000, 6); // net-0 move → unchanged
    expect(series[1].cryptoCostEur).toBeCloseTo(20000, 6);
    expect(series[2].cryptoCostUsd).toBeCloseTo(20000, 6); // forward-filled
  });

  // 12. FEE REMAINDER: legs −1.000 / +0.999 (same asset, same group, net −0.001).
  //     buildStream emits ONE synthetic value-0 disposal of the net magnitude → cost
  //     drops by avg×0.001 (a fee books a realized loss, never a spurious gain).
  it("12. same-asset transfer fee remainder drops cost by avg × net (value-0 disposal)", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Buy 2 @ 20000 on day 1 → avg 10000/unit.
        txn(null, 2, { date: "2023-01-01", cashflowUsd: 20000, cashflowEur: 20000 }),
        // OUT 1.000, IN 0.999 (net −0.001 lost to fee), same group g3, day 2.
        txn(2, 1, {
          date: "2023-01-02",
          deltaUsd: 10000,
          deltaEur: 10000,
          is_adjustment: true,
          transfer_group_id: "g3",
        }),
        txn(1, 1.999, {
          date: "2023-01-02",
          deltaUsd: 10000,
          deltaEur: 10000,
          is_adjustment: true,
          transfer_group_id: "g3",
        }),
      ],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [
        ["2023-01-01", 30000],
        ["2023-01-02", 30000],
      ], SPINE),
      dates: SPINE,
    });

    // avg = 20000/2 = 10000; cost drops by avg × 0.001 = 10 → 19990.
    expect(series[0].cryptoCostUsd).toBe(20000);
    expect(series[1].cryptoCostUsd).toBeCloseTo(19990, 6);
    expect(series[1].cryptoCostEur).toBeCloseTo(19990, 6);
  });

  // 13. NULL-delta transfer leg (pending FX): a transfer OUT whose delta_{cur} is null
  //     still RELEASES avg×out from the cost line (value only affects realized, which the
  //     series does not track). No NaN.
  it("13. transfer leg with NULL delta still releases avg cost (no NaN)", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "btc",
      native_currency: "USD",
      asset_class: "crypto",
      txns: [
        // Buy 1 @ 30000 on day 1.
        txn(null, 1, { date: "2023-01-01", cashflowUsd: 30000, cashflowEur: 30000 }),
        // Transfer OUT 0.5 on day 2, group g4, delta NULL (pending FX) → value 0.
        txn(1, 0.5, {
          date: "2023-01-02",
          deltaUsd: null,
          deltaEur: null,
          is_adjustment: true,
          transfer_group_id: "g4",
        }),
      ],
    };
    const { series } = buildCostBasisSeries({
      assets: [asset],
      prices: prices("btc", [
        ["2023-01-01", 60000],
        ["2023-01-02", 60000],
      ], SPINE),
      dates: SPINE,
    });

    // avg = 30000/1; out = 0.5; cost -= 30000×0.5 = 15000 (value 0 only zeroes realized).
    expect(series[0].cryptoCostUsd).toBe(30000);
    expect(series[1].cryptoCostUsd).toBeCloseTo(15000, 6);
    expect(series[1].cryptoCostEur).toBeCloseTo(15000, 6);
    // No NaN anywhere.
    for (const p of series) {
      for (const [k, v] of Object.entries(p)) {
        if (k === "date") continue;
        expect(Number.isNaN(v as number)).toBe(false);
      }
    }
  });
});
