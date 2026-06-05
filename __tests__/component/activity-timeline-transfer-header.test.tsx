import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ActivityLog } from "@/lib/types";

/**
 * Full-render coverage for the C2b transfer-group HEADER: a sell-type grouped
 * item (position + cash pair) must read "Sell (to {cash account})" in the
 * timeline; a genuine move group keeps the generic "Transfer" header.
 *
 * The pure derivation is exhaustively unit-tested in activity-timeline-helpers;
 * this asserts the rendered JSX path wires it up (the header label + annotation
 * actually appear, and a move group is unchanged). Heavy deps are mocked exactly
 * as the helpers test mocks them.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/activity-log", () => ({
  exportActivityLogsCsv: vi.fn(),
  toggleActivityAdjustment: vi.fn(),
}));
vi.mock("@/lib/actions/splits", () => ({
  backdateActivityEntry: vi.fn(),
  unsplitActivityEntry: vi.fn(),
}));
vi.mock("@/lib/actions/undo", () => ({ undoActivity: vi.fn() }));
vi.mock("@/lib/actions/backfill", () => ({ backfillSingleRow: vi.fn() }));
vi.mock("@/components/shared-view-context", () => ({
  useSharedView: () => ({ isReadOnly: false, shareToken: null }),
}));
vi.mock("@/components/ui/confirm-button", () => ({ ConfirmButton: () => null }));
vi.mock("@/components/ui/cashflow-status-icon", () => ({ CashflowStatusIcon: () => null }));
vi.mock("@/components/history/split-modal", () => ({ SplitModal: () => null }));

const { ActivityTimeline } = await import("@/components/history/activity-timeline");

function makeLog(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: "log-1",
    user_id: "u-1",
    action: "updated",
    entity_type: "crypto_position",
    entity_name: "BTC",
    description: "Transfer leg",
    details: null,
    entity_id: "e-1",
    entity_table: "crypto_positions",
    before_snapshot: null,
    after_snapshot: null,
    undone_at: null,
    is_adjustment: true,
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
    // All in the same calendar day so they group together under one date header.
    created_at: "2026-05-15T10:00:00Z",
    ...overrides,
  };
}

function renderTimeline(logs: ActivityLog[]) {
  return render(
    <ActivityTimeline logs={logs} total={logs.length} page={1} limit={50} />,
  );
}

describe("ActivityTimeline — C2b transfer-group header (render)", () => {
  it("a sell-type group (crypto position + cash) shows 'Sell (to Alpha Bank)'", () => {
    const position = makeLog({
      id: "pos",
      entity_type: "crypto_position",
      entity_name: "BTC",
      transfer_group_id: "grp-sell",
      delta_eur: -5000,
    });
    const cash = makeLog({
      id: "cash",
      entity_type: "cash_account",
      entity_name: "Alpha Bank",
      transfer_group_id: "grp-sell",
      delta_eur: 5000,
    });
    renderTimeline([position, cash]);

    expect(screen.getByText("Sell")).toBeInTheDocument();
    expect(screen.getByText(/\(to Alpha Bank\)/)).toBeInTheDocument();
    // The header is NOT the generic "Transfer" word for this group.
    expect(screen.queryByText("Transfer")).not.toBeInTheDocument();
  });

  it("a buy-type group (cash + stock position) shows 'Buy (from Revolut)'", () => {
    const cash = makeLog({
      id: "cash",
      entity_type: "bank_account",
      entity_name: "Revolut",
      transfer_group_id: "grp-buy",
      delta_eur: -3000,
    });
    const position = makeLog({
      id: "pos",
      entity_type: "stock_position",
      entity_name: "VWCE",
      transfer_group_id: "grp-buy",
      delta_eur: 3000,
    });
    renderTimeline([cash, position]);

    expect(screen.getByText("Buy")).toBeInTheDocument();
    expect(screen.getByText(/\(from Revolut\)/)).toBeInTheDocument();
  });

  it("a genuine move group (cash↔cash) keeps the generic 'Transfer' header", () => {
    const a = makeLog({
      id: "a",
      entity_type: "cash_account",
      entity_name: "Alpha Bank",
      transfer_group_id: "grp-move",
      delta_eur: -1000,
    });
    const b = makeLog({
      id: "b",
      entity_type: "bank_account",
      entity_name: "Revolut",
      transfer_group_id: "grp-move",
      delta_eur: 1000,
    });
    renderTimeline([a, b]);

    expect(screen.getByText("Transfer")).toBeInTheDocument();
    expect(screen.queryByText("Sell")).not.toBeInTheDocument();
    expect(screen.queryByText("Buy")).not.toBeInTheDocument();
  });
});
