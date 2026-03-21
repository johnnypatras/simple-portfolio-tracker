import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SplitModal } from "@/components/history/split-modal";
import type { ActivityLog } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Helpers ──────────────────────────────────────────────

function makeEntry(overrides: Partial<ActivityLog> = {}): ActivityLog {
  return {
    id: "log-1",
    user_id: "u-1",
    action: "created",
    entity_type: "crypto_asset",
    entity_name: "Bitcoin",
    description: "Added 0.5 BTC",
    details: null,
    entity_id: "asset-1",
    entity_table: "crypto_assets",
    before_snapshot: null,
    after_snapshot: { quantity: 0.5, price_usd: 60000 },
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
    created_at: "2026-01-10T12:00:00Z",
    effective_date: null,
    split_from_id: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("SplitModal", () => {
  it("renders nothing when entry is null", () => {
    const { container } = render(
      <SplitModal entry={null} onClose={vi.fn()} onSplit={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders modal when entry provided", () => {
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );
    expect(screen.getByText("Split Entry")).toBeInTheDocument();
    // Entity name + quantity shown
    expect(screen.getByText("Bitcoin")).toBeInTheDocument();
    expect(screen.getAllByText(/0\.5/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/units/)).toBeInTheDocument();
  });

  it("shows initial allocation leg", () => {
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );
    // One date input and one quantity input
    expect(screen.getByLabelText("Allocation 1 date")).toBeInTheDocument();
    expect(screen.getByLabelText("Allocation 1 quantity")).toBeInTheDocument();
  });

  it("add leg button creates new row", async () => {
    const user = userEvent.setup();
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    await user.click(screen.getByText("Add date"));

    expect(screen.getByLabelText("Allocation 1 date")).toBeInTheDocument();
    expect(screen.getByLabelText("Allocation 2 date")).toBeInTheDocument();
    expect(screen.getByLabelText("Allocation 2 quantity")).toBeInTheDocument();
  });

  it("remove leg button removes row", async () => {
    const user = userEvent.setup();
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    // Add a second leg so remove buttons appear
    await user.click(screen.getByText("Add date"));
    expect(screen.getByLabelText("Allocation 2 date")).toBeInTheDocument();

    // Remove the first leg
    await user.click(screen.getByLabelText("Remove allocation 1"));

    // Only one leg remains
    expect(screen.getByLabelText("Allocation 1 date")).toBeInTheDocument();
    expect(screen.queryByLabelText("Allocation 2 date")).not.toBeInTheDocument();
  });

  it("date input accepts valid format", async () => {
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    const dateInput = screen.getByLabelText("Allocation 1 date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-01-15" } });

    expect(dateInput.value).toBe("2026-01-15");
    // No error role should be present for valid date
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows over-allocated warning when total exceeds original", async () => {
    const user = userEvent.setup();
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    const qtyInput = screen.getByLabelText("Allocation 1 quantity");
    await user.clear(qtyInput);
    await user.type(qtyInput, "0.6");

    // Over-allocated message (original is 0.5)
    expect(screen.getByText(/Over-allocated by/)).toBeInTheDocument();
  });

  it("submit button disabled when validation fails", async () => {
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    // No date or quantity filled — should be disabled
    const submitButton = screen.getByRole("button", { name: "Split" });
    expect(submitButton).toBeDisabled();
  });

  it("calls onSplit with correct payload", async () => {
    const user = userEvent.setup();
    const onSplit = vi.fn().mockResolvedValue({ success: true, message: "" });
    const onClose = vi.fn();

    render(
      <SplitModal entry={makeEntry()} onClose={onClose} onSplit={onSplit} />,
    );

    // Add a second leg
    await user.click(screen.getByText("Add date"));

    // Fill first leg
    const date1 = screen.getByLabelText("Allocation 1 date");
    const qty1 = screen.getByLabelText("Allocation 1 quantity");
    fireEvent.change(date1, { target: { value: "2026-01-05" } });
    await user.clear(qty1);
    await user.type(qty1, "0.2");

    // Fill second leg
    const date2 = screen.getByLabelText("Allocation 2 date");
    const qty2 = screen.getByLabelText("Allocation 2 quantity");
    fireEvent.change(date2, { target: { value: "2026-01-08" } });
    await user.clear(qty2);
    await user.type(qty2, "0.3");

    // Submit
    const submitButton = screen.getByRole("button", { name: "Split" });
    expect(submitButton).not.toBeDisabled();
    await user.click(submitButton);

    expect(onSplit).toHaveBeenCalledOnce();
    expect(onSplit).toHaveBeenCalledWith("log-1", [
      { effective_date: "2026-01-05", quantity: 0.2 },
      { effective_date: "2026-01-08", quantity: 0.3 },
    ]);
    // Closes on success
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows loading state during submission", async () => {
    const user = userEvent.setup();
    // Return a promise that never resolves during the test
    let resolvePromise: (v: { success: boolean; message: string }) => void;
    const onSplit = vi.fn().mockImplementation(
      () => new Promise<{ success: boolean; message: string }>((resolve) => {
        resolvePromise = resolve;
      }),
    );

    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={onSplit} />,
    );

    // Add a second leg and fill valid data
    await user.click(screen.getByText("Add date"));
    fireEvent.change(screen.getByLabelText("Allocation 1 date"), { target: { value: "2026-01-05" } });
    await user.clear(screen.getByLabelText("Allocation 1 quantity"));
    await user.type(screen.getByLabelText("Allocation 1 quantity"), "0.2");
    fireEvent.change(screen.getByLabelText("Allocation 2 date"), { target: { value: "2026-01-08" } });
    await user.clear(screen.getByLabelText("Allocation 2 quantity"));
    await user.type(screen.getByLabelText("Allocation 2 quantity"), "0.3");

    await user.click(screen.getByRole("button", { name: "Split" }));

    // Loading state
    expect(screen.getByRole("button", { name: "Splitting..." })).toBeDisabled();

    // Resolve the promise to clean up
    resolvePromise!({ success: true, message: "" });
    await waitFor(() => {
      expect(screen.queryByText("Splitting...")).not.toBeInTheDocument();
    });
  });

  it("shows error message when onSplit fails", async () => {
    const user = userEvent.setup();
    const onSplit = vi.fn().mockResolvedValue({ success: false, message: "Server error" });

    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={onSplit} />,
    );

    // Fill valid data with two legs
    await user.click(screen.getByText("Add date"));
    fireEvent.change(screen.getByLabelText("Allocation 1 date"), { target: { value: "2026-01-05" } });
    await user.clear(screen.getByLabelText("Allocation 1 quantity"));
    await user.type(screen.getByLabelText("Allocation 1 quantity"), "0.2");
    fireEvent.change(screen.getByLabelText("Allocation 2 date"), { target: { value: "2026-01-08" } });
    await user.clear(screen.getByLabelText("Allocation 2 quantity"));
    await user.type(screen.getByLabelText("Allocation 2 quantity"), "0.3");

    await user.click(screen.getByRole("button", { name: "Split" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Server error");
    });
  });

  it("uses 'shares' unit for stock entries", () => {
    render(
      <SplitModal
        entry={makeEntry({
          entity_type: "stock_asset",
          entity_name: "AAPL",
          after_snapshot: { quantity: 10 },
        })}
        onClose={vi.fn()}
        onSplit={vi.fn()}
      />,
    );
    expect(screen.getByText(/shares/)).toBeInTheDocument();
  });

  it("shows fully allocated indicator when all quantity is distributed", async () => {
    const user = userEvent.setup();
    render(
      <SplitModal entry={makeEntry()} onClose={vi.fn()} onSplit={vi.fn()} />,
    );

    const qtyInput = screen.getByLabelText("Allocation 1 quantity");
    await user.clear(qtyInput);
    await user.type(qtyInput, "0.5");

    expect(screen.getByText("Fully allocated")).toBeInTheDocument();
  });
});
