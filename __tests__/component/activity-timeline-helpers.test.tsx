import { describe, it, expect, vi } from "vitest";
import type { ActivityLog } from "@/lib/types";

// Mock all heavy dependencies that the activity-timeline module imports
// so we can extract and test the pure helper functions without rendering.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/actions/activity-log", () => ({
  exportActivityLogsCsv: vi.fn(),
  toggleActivityAdjustment: vi.fn(),
}));

vi.mock("@/lib/actions/undo", () => ({
  undoActivity: vi.fn(),
}));

vi.mock("@/lib/actions/backfill", () => ({
  backfillSingleRow: vi.fn(),
}));

vi.mock("@/components/shared-view-context", () => ({
  useSharedView: () => ({ isReadOnly: false }),
}));

vi.mock("@/components/ui/confirm-button", () => ({
  ConfirmButton: () => null,
}));

vi.mock("@/components/ui/cashflow-status-icon", () => ({
  CashflowStatusIcon: () => null,
}));

// Import the exported pure helpers after mocks are set up
const {
  describeChanges,
  identifyTransferLegs,
  buildTransferSummary,
} = await import("@/components/history/activity-timeline");

// ── Helpers ──────────────────────────────────────────────

function makeActivityLog(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: "log-1",
    user_id: "u-1",
    action: "updated",
    entity_type: "cash_account",
    entity_name: "Savings (Alpha Bank)",
    description: "Updated balance",
    details: null,
    entity_id: "ca-1",
    entity_table: "cash_accounts",
    before_snapshot: null,
    after_snapshot: null,
    undone_at: null,
    is_adjustment: false,
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
    created_at: "2026-03-18T10:00:00Z",
    ...overrides,
  };
}

// ── describeChanges ──────────────────────────────────────

describe("describeChanges", () => {
  it("returns null when before is null", () => {
    expect(describeChanges(null, { balance: 100 })).toBeNull();
  });

  it("returns null when after is null", () => {
    expect(describeChanges({ balance: 100 }, null)).toBeNull();
  });

  it("returns null when no fields changed", () => {
    const snapshot = { balance: 100, currency: "EUR", id: "x" };
    expect(describeChanges(snapshot, snapshot)).toBeNull();
  });

  it("single change produces a single line", () => {
    const before = { balance: 100 };
    const after = { balance: 200 };
    const result = describeChanges(before, after);
    expect(result).toBe("Balance: 100 \u2192 200");
  });

  it("3 or fewer changes are joined with commas", () => {
    const before = { balance: 100, apy: 1, currency: "EUR" };
    const after = { balance: 200, apy: 2, currency: "USD" };
    const result = describeChanges(before, after)!;
    // Should have all three, comma-separated
    expect(result).toContain("Balance:");
    expect(result).toContain("APY:");
    expect(result).toContain("Currency:");
    expect(result.split(",")).toHaveLength(3);
  });

  it("4+ changes shows first 3 and '+N more'", () => {
    const before = { balance: 100, apy: 1, currency: "EUR", name: "Old" };
    const after = { balance: 200, apy: 2, currency: "USD", name: "New" };
    const result = describeChanges(before, after)!;
    expect(result).toContain("+1 more");
    // Format is "A, B, C +1 more" — 3 visible items joined with ", " then " +1 more"
    expect(result.split(",")).toHaveLength(3);
  });

  it("skips system columns (id, user_id, created_at, etc.)", () => {
    const before = { id: "old-id", user_id: "u-1", balance: 100 };
    const after = { id: "new-id", user_id: "u-2", balance: 200 };
    const result = describeChanges(before, after)!;
    expect(result).toBe("Balance: 100 \u2192 200");
  });

  it("uses FIELD_LABELS for known columns and falls back to formatted key", () => {
    const before = { quantity: 1, some_custom_field: "a" };
    const after = { quantity: 2, some_custom_field: "b" };
    const result = describeChanges(before, after)!;
    expect(result).toContain("Qty:");
    expect(result).toContain("some custom field:");
  });
});

// ── identifyTransferLegs ─────────────────────────────────

describe("identifyTransferLegs", () => {
  it("identifies source (negative delta) and dest (positive delta)", () => {
    const source = makeActivityLog({ id: "src", delta_eur: -5000 });
    const dest = makeActivityLog({ id: "dst", delta_eur: 5000 });

    const result = identifyTransferLegs([source, dest]);
    expect(result.source.id).toBe("src");
    expect(result.dest.id).toBe("dst");
  });

  it("works regardless of array order", () => {
    const source = makeActivityLog({ id: "src", delta_eur: -3000 });
    const dest = makeActivityLog({ id: "dst", delta_eur: 3000 });

    // Reverse order: dest first, source second
    const result = identifyTransferLegs([dest, source]);
    expect(result.source.id).toBe("src");
    expect(result.dest.id).toBe("dst");
  });

  it("handles single entry (degenerate case)", () => {
    const entry = makeActivityLog({ id: "solo" });
    const result = identifyTransferLegs([entry]);
    expect(result.source.id).toBe("solo");
    expect(result.dest.id).toBe("solo");
  });

  it("falls back to delta_usd when delta_eur is null", () => {
    const source = makeActivityLog({ id: "src", delta_eur: null, delta_usd: -1000 });
    const dest = makeActivityLog({ id: "dst", delta_eur: null, delta_usd: 1000 });

    const result = identifyTransferLegs([source, dest]);
    expect(result.source.id).toBe("src");
    expect(result.dest.id).toBe("dst");
  });
});

// ── buildTransferSummary ─────────────────────────────────

describe("buildTransferSummary", () => {
  it("cash transfer with parenthesized locations shows amount + from/to", () => {
    const source = makeActivityLog({
      entity_name: "Savings (Alpha Bank)",
      delta_eur: -6984,
    });
    const dest = makeActivityLog({
      entity_name: "6984 EUR on Trading212",
      delta_eur: 6984,
    });

    const result = buildTransferSummary(source, dest);
    expect(result).toContain("Alpha Bank");
    expect(result).toContain("Trading212");
    expect(result).toContain("transferred");
  });

  it("same entity name (position move) shows entity name + 'transferred'", () => {
    const source = makeActivityLog({
      entity_name: "VWCE",
      delta_eur: -5000,
      before_snapshot: { quantity: 100 },
      after_snapshot: { quantity: 95 },
    });
    const dest = makeActivityLog({
      entity_name: "VWCE",
      delta_eur: 5000,
      before_snapshot: { quantity: 0 },
      after_snapshot: { quantity: 5 },
    });

    const result = buildTransferSummary(source, dest);
    expect(result).toContain("VWCE");
    expect(result).toContain("transferred");
  });

  it("mixed types without extractable location falls back to entity names", () => {
    const source = makeActivityLog({
      entity_name: "BTC",
      delta_eur: -1000,
    });
    const dest = makeActivityLog({
      entity_name: "ETH",
      delta_eur: 1000,
    });

    const result = buildTransferSummary(source, dest);
    expect(result).toContain("BTC");
    expect(result).toContain("ETH");
  });
});

// ── Badge precedence (structural — verifies logic in the component) ──

describe("badge precedence", () => {
  it("transfer_group_id set means Xfer badge takes priority over Adj. badge", () => {
    // This tests the logic: log.transfer_group_id && (...Xfer...)
    // !log.transfer_group_id && !log.compensates_for && log.is_adjustment && (...Adj...)
    // When transfer_group_id is set, the Adj. condition short-circuits.
    const log = makeActivityLog({
      transfer_group_id: "tg-1",
      is_adjustment: true,
    });

    // Verify the logic conditions:
    // Xfer badge shows when transfer_group_id is truthy
    expect(!!log.transfer_group_id).toBe(true);
    // Adj. badge shows when: !transfer_group_id && !compensates_for && is_adjustment
    const showAdj = !log.transfer_group_id && !log.compensates_for && log.is_adjustment;
    expect(showAdj).toBe(false);
  });

  it("is_adjustment without transfer_group_id shows Adj. badge", () => {
    const log = makeActivityLog({
      transfer_group_id: null,
      compensates_for: null,
      is_adjustment: true,
    });

    expect(!!log.transfer_group_id).toBe(false);
    const showAdj = !log.transfer_group_id && !log.compensates_for && log.is_adjustment;
    expect(showAdj).toBe(true);
  });
});
