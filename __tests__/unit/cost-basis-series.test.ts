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
    deltaUsd?: number;
    deltaEur?: number;
    is_yield?: boolean;
    is_adjustment?: boolean;
    cashflow_user_set?: boolean;
  },
): CostBasisSeriesTxn & { date: string } {
  const useDelta = opts.deltaUsd !== undefined || opts.deltaEur !== undefined;
  const t: CostBasisTxn = {
    entity_type: "crypto_position",
    action: beforeQty === null ? "created" : "updated",
    is_yield: opts.is_yield ?? false,
    is_adjustment: opts.is_adjustment ?? false,
    transfer_group_id: null,
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

  // 2. An is_adjustment lot → its MARKET value at each date (changes with price), NOT its cost/0.
  it("2. is_adjustment lot is market-valued at each date (not folded to cost)", () => {
    const asset: CostBasisSeriesAsset = {
      asset_kind: "crypto",
      asset_key: "eth",
      native_currency: "USD",
      asset_class: "crypto",
      // Adjustment: +2 units on 2023-01-01, value carried in delta (cashflow null).
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
});
