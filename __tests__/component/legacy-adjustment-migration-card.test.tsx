import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for the legacy adjustment migration card + button.
 *
 * The card is an async React Server Component. We test it by invoking
 * the component function with a mocked `previewLegacyAdjustmentMigration`,
 * awaiting the resolved JSX, then handing the element to RTL's `render`.
 *
 * The button is a regular client component — straight `render` works.
 */

const hoisted = vi.hoisted(() => ({
  previewLegacyAdjustmentMigration: vi.fn(),
  migrateLegacyAdjustmentFlags: vi.fn(),
  routerRefresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/migrate-legacy-adjustments", () => ({
  previewLegacyAdjustmentMigration: hoisted.previewLegacyAdjustmentMigration,
  migrateLegacyAdjustmentFlags: hoisted.migrateLegacyAdjustmentFlags,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: hoisted.routerRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    error: hoisted.toastError,
  },
}));

import { LegacyAdjustmentMigrationCard } from "@/components/settings/legacy-adjustment-migration-card";
import { LegacyAdjustmentMigrationButton } from "@/components/settings/legacy-adjustment-migration-button";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Card (server component) ───────────────────────────────────────────

describe("LegacyAdjustmentMigrationCard", () => {
  it("shows success state when count is 0", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 0,
      by_entity_type: {},
    });

    // Server components return Promises — await before passing to render.
    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    expect(
      screen.getByText(/No legacy entries to migrate\. Your data is already correct\./i),
    ).toBeInTheDocument();
    // Migrate button must NOT be rendered when count is 0.
    expect(screen.queryByRole("button", { name: /Migrate/i })).not.toBeInTheDocument();
  });

  it("displays the count + by-entity-type breakdown when count > 0", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 47,
      by_entity_type: {
        crypto_position: 12,
        stock_position: 30,
        cash_account: 5,
      },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    // Total count headline.
    expect(screen.getByText(/47 entries to migrate/i)).toBeInTheDocument();

    // Per-entity-type breakdown rows.
    expect(screen.getByText("Crypto positions")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Stock positions")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("Cash accounts")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();

    // The client button must be rendered (count > 0).
    expect(screen.getByRole("button", { name: /Migrate 47 entries/i })).toBeInTheDocument();
  });

  it("renders the static explanation paragraph in both states", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 3,
      by_entity_type: { cash_account: 3 },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    // Explanation should always appear regardless of count.
    expect(screen.getByText(/one-time migration/i)).toBeInTheDocument();
    expect(screen.getByText(/Migrate legacy adjustment flags/i)).toBeInTheDocument();
  });

  it("renders an error state (not a throw) when previewLegacyAdjustmentMigration throws", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockRejectedValue(new Error("DB connection failed"));

    // Must NOT throw — settings page must always render.
    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    expect(screen.getByText(/Could not check migration status/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Refresh page/i })).toBeInTheDocument();
    // No migrate button in the error state.
    expect(screen.queryByRole("button", { name: /Migrate/i })).not.toBeInTheDocument();
    // Explanation heading still shows.
    expect(screen.getByText(/Migrate legacy adjustment flags/i)).toBeInTheDocument();
  });

  it("sorts breakdown entries by count descending with alphabetical fallback", async () => {
    hoisted.previewLegacyAdjustmentMigration.mockResolvedValue({
      count: 20,
      by_entity_type: {
        cash_account: 5,
        crypto_position: 12,
        stock_position: 3,
      },
    });

    const element = await LegacyAdjustmentMigrationCard();
    render(element);

    const rows = screen.getAllByRole("generic").filter((el) => el.className.includes("justify-between"));
    // First row should be the highest count (Crypto positions: 12).
    expect(rows[0]).toHaveTextContent("Crypto positions");
    expect(rows[0]).toHaveTextContent("12");
    // Second row: Cash accounts (5).
    expect(rows[1]).toHaveTextContent("Cash accounts");
    expect(rows[1]).toHaveTextContent("5");
  });
});

// ─── Button (client component) ─────────────────────────────────────────

describe("LegacyAdjustmentMigrationButton", () => {
  it("clicking the trigger opens the confirm panel", () => {
    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    // Trigger button visible by default.
    const trigger = screen.getByRole("button", { name: /Migrate 5 entries/i });
    fireEvent.click(trigger);

    // Confirm panel replaces the trigger.
    expect(screen.getByText(/Confirm migration/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes, migrate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel returns to the trigger state without calling the action", () => {
    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: /Migrate 5 entries/i })).toBeInTheDocument();
    expect(hoisted.migrateLegacyAdjustmentFlags).not.toHaveBeenCalled();
  });

  it("confirming calls the server action and shows the success result", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 3,
      migrated: 3,
      errors: 0,
      details: [
        { id: "id-1", entity_type: "crypto_position", entity_name: "BTC", status: "migrated" },
        { id: "id-2", entity_type: "stock_position", entity_name: "VWCE", status: "migrated" },
        { id: "id-3", entity_type: "cash_account", entity_name: "Revolut EUR", status: "migrated" },
      ],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={3} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 3 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(hoisted.migrateLegacyAdjustmentFlags).toHaveBeenCalledOnce();
    });

    await waitFor(() => {
      expect(screen.getByText(/Migrated 3 entries/i)).toBeInTheDocument();
    });
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Migrated 3 entries");
    expect(hoisted.routerRefresh).toHaveBeenCalled();
  });

  it("displays per-row errors when the action reports errors > 0", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 4,
      migrated: 2,
      errors: 2,
      details: [
        { id: "id-1", entity_type: "crypto_position", entity_name: "BTC", status: "migrated" },
        { id: "id-2", entity_type: "stock_position", entity_name: "VWCE", status: "migrated" },
        {
          id: "id-3",
          entity_type: "cash_account",
          entity_name: "Broken Account",
          status: "error",
          error_message: "Snapshot lookup failed",
        },
        {
          id: "id-4",
          entity_type: "stock_position",
          entity_name: "MYSTERY",
          status: "error",
          error_message: "Unknown ticker",
        },
      ],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={4} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 4 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(screen.getByText(/Migrated 2 of 4/i)).toBeInTheDocument();
    });

    // Both error entries' names + messages surface.
    expect(screen.getByText("Broken Account")).toBeInTheDocument();
    expect(screen.getByText("Snapshot lookup failed")).toBeInTheDocument();
    expect(screen.getByText("MYSTERY")).toBeInTheDocument();
    expect(screen.getByText("Unknown ticker")).toBeInTheDocument();

    expect(hoisted.toastError).toHaveBeenCalledWith("Migrated 2 entries with 2 errors");
  });

  it("handles thrown server action errors with a toast and returns to idle", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockRejectedValue(new Error("Network down"));

    render(<LegacyAdjustmentMigrationButton candidateCount={5} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 5 entries/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(hoisted.toastError).toHaveBeenCalledWith("Network down");
    });
    // Returns to idle (trigger button visible again).
    expect(screen.getByRole("button", { name: /Migrate 5 entries/i })).toBeInTheDocument();
  });

  it("rapid double-click on Yes migrate only calls the action once", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 2,
      migrated: 2,
      errors: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 2 entries/i }));
    const confirmBtn = screen.getByRole("button", { name: "Yes, migrate" });
    // Simulate two rapid clicks in succession.
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(hoisted.migrateLegacyAdjustmentFlags).toHaveBeenCalledOnce();
    });
  });

  it("shows 'Nothing to migrate — already up to date' when migrated=0 and errors=0", async () => {
    hoisted.migrateLegacyAdjustmentFlags.mockResolvedValue({
      total_candidates: 0,
      migrated: 0,
      errors: 0,
      details: [],
    });

    render(<LegacyAdjustmentMigrationButton candidateCount={1} />);

    fireEvent.click(screen.getByRole("button", { name: /Migrate 1 entry/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, migrate" }));

    await waitFor(() => {
      expect(hoisted.toastSuccess).toHaveBeenCalledWith("Nothing to migrate — already up to date");
    });
  });
});
