import { describe, it, expect } from "vitest";
import {
  dedupeAndSortAssetRows,
  type AssetTransactionRow,
} from "@/lib/portfolio/asset-transactions";
import { buildStream, foldCostStep, type CostBasisTxn, type CostFoldState } from "@/lib/portfolio/cost-basis";

/**
 * Unit coverage for `dedupeAndSortAssetRows` — the ordering invariant the cost
 * engine AND the #94 cost-basis series both fold over. Previously this comparator
 * had only Docker-gated integration coverage (closes coverage Gap A).
 *
 * The key refinement under test: on a same-day tie, ACQUISITIONS sort before
 * DISPOSALS (you cannot dispose before acquiring on the same day). Two real
 * failure modes this prevents: a bulk import with identical created_at falling to
 * the random id (~50% wrong), and a backdated SELL recorded before its same-day
 * backdated BUY ordering sell-first by created_at. Either spuriously oversells +
 * misattributes the realized/unrealized decomposition (totalPnL stays invariant).
 */

/** Build a minimal crypto-position AssetTransactionRow. A buy sets after>before;
 *  a sell sets after<before; a "removed" row sets after_snapshot null. */
function cryptoRow(
  o: Partial<AssetTransactionRow> & {
    id: string;
    created_at: string;
    beforeQty?: number;
    afterQty?: number | null;
    cashUsd?: number;
  },
): AssetTransactionRow {
  const before = o.beforeQty != null ? { quantity: o.beforeQty } : null;
  const after = o.afterQty === null ? null : o.afterQty != null ? { quantity: o.afterQty } : null;
  return {
    id: o.id,
    entity_id: o.entity_id ?? "pos-1",
    entity_type: "crypto_position",
    action: o.action ?? (after === null ? "removed" : before ? "updated" : "created"),
    is_yield: o.is_yield ?? false,
    is_adjustment: o.is_adjustment ?? false,
    transfer_group_id: o.transfer_group_id ?? null,
    split_from_id: o.split_from_id ?? null,
    cashflow_amount_usd: o.cashUsd ?? null,
    cashflow_amount_eur: o.cashUsd ?? null,
    delta_usd: null,
    delta_eur: null,
    cashflow_user_set: o.cashflow_user_set ?? false,
    before_snapshot: before,
    after_snapshot: after,
    details: o.details ?? null,
    effective_date: o.effective_date ?? null,
    created_at: o.created_at,
  };
}

describe("dedupeAndSortAssetRows — same-day acquisition-before-disposal ordering", () => {
  it("(i) same-day date-only SELL + later-created live BUY → BUY first (the H1 case)", () => {
    // A backdated SELL (effective 2026-01-01) recorded AFTER a live BUY whose
    // created_at falls on the same day. Without the acquisition key the SELL,
    // sharing the day, could precede the BUY. The BUY must come first.
    const sell = cryptoRow({
      id: "sell",
      effective_date: "2026-01-01",
      created_at: "2026-01-05T10:00:00Z", // recorded later
      beforeQty: 10,
      afterQty: 4,
    });
    const buy = cryptoRow({
      id: "buy",
      created_at: "2026-01-01T09:00:00Z", // live, same economic day
      beforeQty: 0,
      afterQty: 10,
    });
    const sorted = dedupeAndSortAssetRows([sell, buy]);
    expect(sorted.map((r) => r.id)).toEqual(["buy", "sell"]);
  });

  it("(ii) date-only effective vs same-day created_at-fallback (same direction) → falls to created_at", () => {
    // Both acquisitions on the same day: one dated by effective_date, one by
    // created_at-day fallback. Same direction → the acquisition key ties, so the
    // created_at recording instant decides.
    const early = cryptoRow({
      id: "early",
      effective_date: "2026-02-01",
      created_at: "2026-02-09T00:00:00Z", // later recording instant
      beforeQty: 0,
      afterQty: 5,
    });
    const late = cryptoRow({
      id: "late",
      created_at: "2026-02-01T08:00:00Z", // earlier recording instant, same day
      beforeQty: 5,
      afterQty: 9,
    });
    const sorted = dedupeAndSortAssetRows([early, late]);
    // Same day, both acquisitions → created_at ascending: "late" (08:00 Feb-1)
    // before "early" (Feb-9).
    expect(sorted.map((r) => r.id)).toEqual(["late", "early"]);
  });

  it("(iii) split-orphan de-dup: a live parent referenced by a child is dropped", () => {
    const parent = cryptoRow({
      id: "parent",
      created_at: "2026-03-01T00:00:00Z",
      beforeQty: 0,
      afterQty: 10,
    });
    const childA = cryptoRow({
      id: "child-a",
      effective_date: "2026-03-01",
      created_at: "2026-03-02T00:00:00Z",
      split_from_id: "parent",
      details: { split_quantity: 4, split_direction: 1 },
      beforeQty: undefined,
      afterQty: undefined, // split child carries null snapshots + details
    });
    const childB = cryptoRow({
      id: "child-b",
      effective_date: "2026-03-02",
      created_at: "2026-03-02T00:00:01Z",
      split_from_id: "parent",
      details: { split_quantity: 6, split_direction: 1 },
      beforeQty: undefined,
      afterQty: undefined,
    });
    const sorted = dedupeAndSortAssetRows([parent, childA, childB]);
    // Parent dropped (its id is a split_from_id) → only the two children survive.
    expect(sorted.map((r) => r.id)).toEqual(["child-a", "child-b"]);
  });

  it("(iv) TRUE TIE (identical effective_date AND created_at, one acq one disp sized to oversell if reversed) → acquisition first, no oversell anomaly", () => {
    // Identical effective_date AND created_at — the old code fell to random id.
    // The disposal (sell 10) would oversell if it folded before the acquisition
    // (buy 10 from 0). Acquisition-first keeps the fold clean.
    const buy = cryptoRow({
      id: "zzz-buy", // id sorts AFTER the sell, so only the acquisition key saves us
      effective_date: "2026-04-01",
      created_at: "2026-04-01T12:00:00Z",
      beforeQty: 0,
      afterQty: 10,
      cashUsd: 1000,
    });
    const sell = cryptoRow({
      id: "aaa-sell", // id sorts BEFORE the buy
      effective_date: "2026-04-01",
      created_at: "2026-04-01T12:00:00Z",
      beforeQty: 10,
      afterQty: 0,
      cashUsd: 1500,
    });
    const sorted = dedupeAndSortAssetRows([sell, buy]);
    expect(sorted.map((r) => r.id)).toEqual(["zzz-buy", "aaa-sell"]);

    // Fold the sorted stream through the VERIFIED engine — no oversell anomaly.
    const anomalies: string[] = [];
    const stream = buildStream(sorted as unknown as CostBasisTxn[], "usd");
    const state: CostFoldState = { units: 0, cost: 0, realized: 0 };
    for (const e of stream) foldCostStep(state, e, (m) => anomalies.push(m));
    expect(anomalies).toEqual([]);
    expect(state.units).toBe(0); // bought 10, sold 10
  });

  it("(v) buildStream parity: the sorted stream folds acquisition-then-disposal", () => {
    // The series folds the SAME ordered stream; assert buildStream sees the
    // acquisition's qtyDelta first so the cost line can't drift from the headline.
    const buy = cryptoRow({
      id: "b",
      effective_date: "2026-05-01",
      created_at: "2026-05-01T00:00:00Z",
      beforeQty: 0,
      afterQty: 8,
      cashUsd: 800,
    });
    const sell = cryptoRow({
      id: "a", // id-before, but a disposal → must still sort second
      effective_date: "2026-05-01",
      created_at: "2026-05-01T00:00:00Z",
      beforeQty: 8,
      afterQty: 3,
      cashUsd: 600,
    });
    const sorted = dedupeAndSortAssetRows([sell, buy]);
    const stream = buildStream(sorted as unknown as CostBasisTxn[], "usd");
    // First entry is the acquisition (+8), second the disposal (−5).
    expect(stream[0].qtyDelta).toBeGreaterThan(0);
    expect(stream[1].qtyDelta).toBeLessThan(0);
  });

  it("multi-day rows still sort by economic day first (the acquisition key is intra-day only)", () => {
    const dayTwoBuy = cryptoRow({
      id: "d2",
      effective_date: "2026-06-02",
      created_at: "2026-06-02T00:00:00Z",
      beforeQty: 4,
      afterQty: 9,
    });
    const dayOneSell = cryptoRow({
      id: "d1",
      effective_date: "2026-06-01",
      created_at: "2026-06-01T00:00:00Z",
      beforeQty: 10,
      afterQty: 4,
    });
    const sorted = dedupeAndSortAssetRows([dayTwoBuy, dayOneSell]);
    // Day 1 (even though a disposal) precedes day 2 — the day key dominates.
    expect(sorted.map((r) => r.id)).toEqual(["d1", "d2"]);
  });
});
