import { describe, expect, it } from "vitest";
import { normalizeActivityLogRow } from "@/lib/activity-log-normalize";
import type { Database } from "@/types/database";

type ActivityLogRow = Database["public"]["Tables"]["activity_log"]["Row"];

function makeRow(overrides: Partial<ActivityLogRow> = {}): ActivityLogRow {
  return {
    id: "log-1",
    user_id: "u-1",
    action: "created",
    entity_type: "crypto_position",
    entity_name: "Bitcoin",
    description: "Added 0.5 BTC",
    details: null,
    entity_id: "pos-1",
    entity_table: "crypto_positions",
    before_snapshot: null,
    after_snapshot: null,
    undone_at: null,
    is_adjustment: false,
    is_yield: false,
    cashflow_user_set: false,
    delta_usd: null,
    delta_eur: null,
    transfer_group_id: null,
    compensates_for: null,
    cashflow_amount_usd: null,
    cashflow_amount_eur: null,
    cashflow_asset_class: null,
    cashflow_status: null,
    delta_status: null,
    cashflow_attempted_at: null,
    delta_attempted_at: null,
    created_at: "2026-06-11T10:00:00Z",
    effective_date: null,
    split_from_id: null,
    original_amount: null,
    original_currency: null,
    ...overrides,
  };
}

describe("normalizeActivityLogRow — original-currency metadata", () => {
  it("passes original_amount and original_currency through to the domain shape", () => {
    const result = normalizeActivityLogRow(
      makeRow({ original_amount: 500, original_currency: "GBP" }),
    );

    expect(result.original_amount).toBe(500);
    expect(result.original_currency).toBe("GBP");
  });

  it("preserves nulls for market-derived / pre-feature rows", () => {
    const result = normalizeActivityLogRow(
      makeRow({ original_amount: null, original_currency: null }),
    );

    expect(result.original_amount).toBeNull();
    expect(result.original_currency).toBeNull();
  });
});
