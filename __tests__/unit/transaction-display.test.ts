import { describe, it, expect } from "vitest";
import { toTransactionDisplayRows } from "@/lib/portfolio/asset-transactions";
import type {
  AssetTransactionRow,
  TransferCounterpartMap,
} from "@/lib/portfolio/asset-transactions";

/**
 * Unit tests for the pure raw→display mapper `toTransactionDisplayRows`.
 *
 * The mapper turns raw activity_log rows (AssetTransactionRow) into the drawer's
 * display shape (TransactionDisplayRow). It is PURE — no DB, no async.
 *
 * Coverage:
 *   - buy   → cashflow_* used, positive signed qty, kind "buy"
 *   - sell  → cashflow_* used, negative signed qty, kind "sell"
 *   - yield → kind "yield", amount null (market-derived → "—")
 *   - is_adjustment → amount from delta_* (the C3 rule), NOT cashflow
 *   - transfer (transfer_group_id) → amount from delta_*
 *   - EUR vs USD currency selection
 *   - null amount → null (renders "—")
 */

// ── Fixture builder ───────────────────────────────────────────────────────────

/** A full AssetTransactionRow with sensible defaults; override per-test. */
function makeRow(overrides: Partial<AssetTransactionRow>): AssetTransactionRow {
  return {
    id: "row-default",
    entity_id: "entity-1",
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
    cashflow_user_set: false,
    before_snapshot: null,
    after_snapshot: null,
    details: null,
    effective_date: null,
    created_at: "2026-01-10T12:00:00Z",
    ...overrides,
  };
}

describe("toTransactionDisplayRows", () => {
  it("maps a buy: cashflow used, positive signed qty, kind 'buy'", () => {
    const row = makeRow({
      id: "buy-1",
      action: "updated",
      before_snapshot: { quantity: 1 },
      after_snapshot: { quantity: 3 }, // +2
      cashflow_amount_usd: 6000,
      cashflow_amount_eur: 5454,
    });

    const [out] = toTransactionDisplayRows([row], "USD");

    expect(out.id).toBe("buy-1");
    expect(out.kind).toBe("buy");
    expect(out.quantity).toBe(2); // signed, positive
    expect(out.amount).toBe(6000); // cashflow (not delta) — not an adjustment/transfer
    expect(out.currency).toBe("USD");
  });

  it("maps a sell: cashflow used, negative signed qty, kind 'sell'", () => {
    const row = makeRow({
      id: "sell-1",
      action: "updated",
      before_snapshot: { quantity: 5 },
      after_snapshot: { quantity: 2 }, // -3
      cashflow_amount_usd: 9000,
      cashflow_amount_eur: 8181,
    });

    const [out] = toTransactionDisplayRows([row], "USD");

    expect(out.kind).toBe("sell");
    expect(out.quantity).toBe(-3); // signed, negative
    // amount is ABSOLUTE — direction conveyed by the sign of quantity + the badge
    expect(out.amount).toBe(9000);
  });

  it("maps a yield: kind 'yield', null cashflow → amount null (renders '—')", () => {
    const row = makeRow({
      id: "yield-1",
      is_yield: true,
      action: "updated",
      before_snapshot: { quantity: 3 },
      after_snapshot: { quantity: 3.1 }, // +0.1 (staking reward)
      cashflow_amount_usd: null, // market-derived, no cost
      cashflow_amount_eur: null,
    });

    const [out] = toTransactionDisplayRows([row], "USD");

    expect(out.kind).toBe("yield");
    expect(out.quantity).toBeCloseTo(0.1, 10);
    expect(out.amount).toBeNull(); // → "—" in the drawer
  });

  it("maps a yield with a populated cashflow to amount 0 when cashflow is 0", () => {
    const row = makeRow({
      id: "yield-2",
      is_yield: true,
      before_snapshot: { quantity: 3 },
      after_snapshot: { quantity: 3.1 },
      cashflow_amount_usd: 0,
      cashflow_amount_eur: 0,
    });

    const [out] = toTransactionDisplayRows([row], "USD");
    expect(out.kind).toBe("yield");
    expect(out.amount).toBe(0); // 0 stays 0 (only null → null)
  });

  it("maps an is_adjustment row: amount from delta_*, NOT cashflow (C3 rule)", () => {
    const row = makeRow({
      id: "adj-1",
      is_adjustment: true,
      action: "updated",
      before_snapshot: { quantity: 1 },
      after_snapshot: { quantity: 1.5 }, // +0.5
      // cashflow is set but MUST be ignored for adjustments
      cashflow_amount_usd: 99999,
      cashflow_amount_eur: 88888,
      delta_usd: 500,
      delta_eur: 450,
    });

    const [out] = toTransactionDisplayRows([row], "USD");

    expect(out.kind).toBe("adjustment");
    expect(out.amount).toBe(500); // delta_usd, not cashflow_amount_usd
  });

  it("maps a transfer row (transfer_group_id present): amount from delta_*", () => {
    const row = makeRow({
      id: "xfer-1",
      transfer_group_id: "group-abc",
      is_adjustment: true, // transfer legs are adjustments; transfer kind wins
      action: "updated",
      before_snapshot: { quantity: 2 },
      after_snapshot: { quantity: 1 }, // -1 (sell leg)
      cashflow_amount_usd: 12345, // must be ignored
      cashflow_amount_eur: 11111,
      delta_usd: -500,
      delta_eur: -450,
    });

    const [out] = toTransactionDisplayRows([row], "USD");

    expect(out.kind).toBe("transfer");
    expect(out.quantity).toBe(-1);
    // delta_usd is -500; amount is absolute → 500
    expect(out.amount).toBe(500);
  });

  it("selects EUR columns when currency is 'EUR'", () => {
    const row = makeRow({
      id: "eur-1",
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 6000,
      cashflow_amount_eur: 5454,
    });

    const [out] = toTransactionDisplayRows([row], "EUR");

    expect(out.currency).toBe("EUR");
    expect(out.amount).toBe(5454); // EUR column, not USD
  });

  it("selects the EUR delta column for an adjustment when currency is 'EUR'", () => {
    const row = makeRow({
      id: "eur-adj-1",
      is_adjustment: true,
      delta_usd: 500,
      delta_eur: 450,
    });

    const [out] = toTransactionDisplayRows([row], "EUR");
    expect(out.amount).toBe(450); // delta_eur
  });

  it("null amount stays null (renders '—') for a buy with no cashflow", () => {
    const row = makeRow({
      id: "null-amt",
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: null,
      cashflow_amount_eur: null,
    });

    const [out] = toTransactionDisplayRows([row], "USD");
    expect(out.kind).toBe("buy");
    expect(out.amount).toBeNull();
  });

  it("uses effective_date when present, falling back to created_at", () => {
    const withEffective = makeRow({
      id: "d1",
      effective_date: "2025-03-14",
      created_at: "2026-01-10T12:00:00Z",
    });
    const withoutEffective = makeRow({
      id: "d2",
      effective_date: null,
      created_at: "2026-01-10T12:00:00Z",
    });

    const out = toTransactionDisplayRows([withEffective, withoutEffective], "USD");
    expect(out[0].date).toBe("2025-03-14"); // effective_date wins
    expect(out[1].date).toBe("2026-01-10T12:00:00Z"); // created_at fallback
  });

  it("maps a cash deposit: cash entity, positive balance delta → kind 'deposit'", () => {
    const row = makeRow({
      id: "dep-1",
      entity_type: "cash_account",
      action: "updated",
      before_snapshot: { balance: 1000 },
      after_snapshot: { balance: 1500 }, // +500
      cashflow_amount_usd: 550,
      cashflow_amount_eur: 500,
    });

    const [out] = toTransactionDisplayRows([row], "EUR");
    expect(out.kind).toBe("deposit");
    expect(out.quantity).toBe(500);
    expect(out.amount).toBe(500);
  });

  it("maps an empty input to an empty output", () => {
    expect(toTransactionDisplayRows([], "USD")).toEqual([]);
  });

  it("preserves input order (the caller already sorted)", () => {
    const a = makeRow({ id: "a", created_at: "2026-01-01T00:00:00Z" });
    const b = makeRow({ id: "b", created_at: "2026-02-01T00:00:00Z" });
    const out = toTransactionDisplayRows([a, b], "USD");
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

// ── C2b: transferRole / counterpartName threading ─────────────────────────────

describe("toTransactionDisplayRows — transfer role enrichment (C2b)", () => {
  /** A sell-type position leg: crypto qty DOWN, in a transfer group. */
  function sellLeg(overrides: Partial<AssetTransactionRow> = {}): AssetTransactionRow {
    return makeRow({
      id: "sell-leg",
      entity_type: "crypto_position",
      is_adjustment: true,
      transfer_group_id: "grp-1",
      before_snapshot: { quantity: 2 },
      after_snapshot: { quantity: 1 }, // -1
      delta_usd: -500,
      delta_eur: -450,
      ...overrides,
    });
  }

  /** A buy-type position leg: stock qty UP, in a transfer group. */
  function buyLeg(overrides: Partial<AssetTransactionRow> = {}): AssetTransactionRow {
    return makeRow({
      id: "buy-leg",
      entity_type: "stock_position",
      is_adjustment: true,
      transfer_group_id: "grp-2",
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 3 }, // +3
      delta_usd: 900,
      delta_eur: 810,
      ...overrides,
    });
  }

  it("WITHOUT a counterpart map → transferRole + counterpartName absent (kind stays transfer)", () => {
    const [out] = toTransactionDisplayRows([sellLeg()], "USD");
    expect(out.kind).toBe("transfer");
    expect(out.transferRole).toBeUndefined();
    expect(out.counterpartName).toBeUndefined();
  });

  it("sell leg WITH a cash counterpart → transferRole 'sell' + counterpart name; kind stays transfer", () => {
    const map: TransferCounterpartMap = new Map([
      ["grp-1", { entityType: "cash_account", entityName: "Alpha Bank" }],
    ]);
    const [out] = toTransactionDisplayRows([sellLeg()], "USD", map);
    expect(out.kind).toBe("transfer"); // unchanged
    expect(out.transferRole).toBe("sell");
    expect(out.counterpartName).toBe("Alpha Bank");
  });

  it("buy leg WITH a cash counterpart → transferRole 'buy' + counterpart name", () => {
    const map: TransferCounterpartMap = new Map([
      ["grp-2", { entityType: "bank_account", entityName: "Revolut" }],
    ]);
    const [out] = toTransactionDisplayRows([buyLeg()], "EUR", map);
    expect(out.transferRole).toBe("buy");
    expect(out.counterpartName).toBe("Revolut");
  });

  it("MOVE leg (position counterpart) → role/name absent even with a map", () => {
    // Same-asset relocate: counterpart is another crypto_position.
    const map: TransferCounterpartMap = new Map([
      ["grp-1", { entityType: "crypto_position", entityName: "BTC (Ledger)" }],
    ]);
    const [out] = toTransactionDisplayRows([sellLeg()], "USD", map);
    expect(out.kind).toBe("transfer");
    expect(out.transferRole).toBeUndefined();
    expect(out.counterpartName).toBeUndefined();
  });

  it("transfer leg with NO matching group in the map → role/name absent", () => {
    const map: TransferCounterpartMap = new Map([
      ["some-other-group", { entityType: "cash_account", entityName: "N26" }],
    ]);
    const [out] = toTransactionDisplayRows([sellLeg()], "USD", map);
    expect(out.transferRole).toBeUndefined();
    expect(out.counterpartName).toBeUndefined();
  });

  it("a non-transfer row is never enriched even when a map is supplied", () => {
    const plainBuy = makeRow({
      id: "plain-buy",
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 1 },
      cashflow_amount_usd: 100,
      cashflow_amount_eur: 90,
    });
    const map: TransferCounterpartMap = new Map([
      ["grp-1", { entityType: "cash_account", entityName: "Alpha Bank" }],
    ]);
    const [out] = toTransactionDisplayRows([plainBuy], "USD", map);
    expect(out.kind).toBe("buy");
    expect(out.transferRole).toBeUndefined();
  });
});
