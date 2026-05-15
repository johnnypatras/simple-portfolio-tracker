import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for UpdateNavModal.
 *
 * The modal:
 *   - Fetches NAV history on open via the BROWSER supabase client (RLS-scoped)
 *   - Renders an add/edit form + history list with per-row pen/trash buttons
 *   - Replaces native confirm() with an in-modal Yes/No widget for delete
 *
 * Mocking strategy:
 *   - Mock createClient (browser supabase) with a controllable chain whose
 *     terminal .order() resolves to the configured payload
 *   - Mock the two server actions (upsertManualNav, deleteManualNav)
 *   - Mock sonner toast + focus-trap-react
 */

const hoisted = vi.hoisted(() => ({
  navHistory: [] as Array<{ id: string; effective_date: string; nav: number; note: string | null }>,
  fetchError: null as { message: string } | null,
  upsertManualNav: vi.fn(),
  deleteManualNav: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () =>
            Promise.resolve({
              data: hoisted.fetchError ? null : hoisted.navHistory,
              error: hoisted.fetchError,
            }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/actions/manual-nav", () => ({
  upsertManualNav: hoisted.upsertManualNav,
  deleteManualNav: hoisted.deleteManualNav,
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    error: hoisted.toastError,
  },
}));

vi.mock("focus-trap-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { UpdateNavModal } from "@/components/stocks/update-nav-modal";
import type { StockAssetWithPositions } from "@/lib/types";

const TODAY = "2026-05-15";

const ASSET: StockAssetWithPositions = {
  id: "asset-1",
  user_id: "user-123",
  ticker: "ENXF",
  yahoo_ticker: null,
  name: "EQT Nexus ELTIF",
  category: "private_equity",
  currency: "EUR",
  isin: null,
  subcategory: "ELTIF",
  tags: [],
  kind: "manual",
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  positions: [],
};

function renderModal(propOverrides?: Partial<React.ComponentProps<typeof UpdateNavModal>>) {
  const props = {
    open: true,
    onClose: vi.fn(),
    asset: ASSET,
    ...propOverrides,
  };
  return { ...render(<UpdateNavModal {...props} />), props };
}

beforeEach(() => {
  // vi.setSystemTime alone (no useFakeTimers) — matches stale-nav-banner pattern.
  // Faking timers would block waitFor's internal setTimeout polling.
  // Note: no afterEach with useRealTimers() — calling it is a no-op when
  // useFakeTimers() was never called, and including it falsely implies fake
  // timers were active.
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  vi.clearAllMocks();
  hoisted.navHistory = [];
  hoisted.fetchError = null;
  hoisted.upsertManualNav.mockResolvedValue(undefined);
  hoisted.deleteManualNav.mockResolvedValue(undefined);
});

describe("UpdateNavModal", () => {
  it("renders empty state when no NAV history exists", async () => {
    renderModal();
    await waitFor(() =>
      expect(screen.getByText(/No NAV entries yet/i)).toBeInTheDocument(),
    );
  });

  it("fetches and renders NAV history sorted DESC", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-05-01", nav: 105.5, note: "Q1 fund letter" },
      { id: "n2", effective_date: "2026-02-01", nav: 100, note: null },
    ];
    renderModal();

    await waitFor(() => expect(screen.getByLabelText(/NAV history/i)).toBeInTheDocument());
    expect(screen.getByText(/2026-05-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-02-01/)).toBeInTheDocument();
    expect(screen.getByText(/Q1 fund letter/)).toBeInTheDocument();
  });

  it("shows 'Stale —' prefix on the header when latest NAV > 45 days old", async () => {
    hoisted.navHistory = [
      // 60 days before TODAY (2026-05-15) → 2026-03-16
      { id: "n1", effective_date: "2026-03-16", nav: 100, note: null },
    ];
    renderModal();
    await waitFor(() => expect(screen.getByText(/Stale —/i)).toBeInTheDocument());
  });

  it("does NOT show 'Stale —' at exactly the 45-day threshold (uses strict >)", async () => {
    // 45 days before TODAY (2026-05-15) → 2026-03-31. Threshold is `daysAgo > 45`,
    // so the exact boundary day should still render the "Updated" prefix.
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-03-31", nav: 100, note: null },
    ];
    renderModal();
    await waitFor(() => expect(screen.getByText(/Updated/)).toBeInTheDocument());
    expect(screen.queryByText(/Stale —/i)).not.toBeInTheDocument();
  });

  it("does NOT show 'Stale —' at 44 days (clearly under threshold)", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-04-01", nav: 100, note: null },
    ];
    renderModal();
    await waitFor(() => expect(screen.getByText(/Updated/)).toBeInTheDocument());
    expect(screen.queryByText(/Stale —/i)).not.toBeInTheDocument();
  });

  it("shows fetch error in role='alert' and does NOT render a history list when supabase fails", async () => {
    hoisted.fetchError = { message: "Connection lost" };
    renderModal();
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/Connection lost/);
    });
    // Defense against a regression where the component renders both an error
    // banner AND a (potentially stale) history list — the user should not see
    // entries they can interact with when the load failed.
    // Note: query by role="list" (not getByLabelText) because the modal's
    // dialog title also matches /NAV history/i via aria-labelledby.
    expect(screen.queryByRole("list", { name: /NAV history/i })).not.toBeInTheDocument();
  });

  it("submits a new NAV via upsertManualNav and refreshes the list", async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/No NAV entries yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^NAV$/i), { target: { value: "105.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Record NAV/i }));

    await waitFor(() =>
      expect(hoisted.upsertManualNav).toHaveBeenCalledWith({
        asset_id: "asset-1",
        effective_date: TODAY,
        nav: 105.5,
        note: null,
      }),
    );
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("NAV recorded for ENXF");
  });

  it("populates the form and disables the date input when entering edit mode", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-05-01", nav: 105.5, note: "Q1" },
    ];
    renderModal();

    await waitFor(() => expect(screen.getByLabelText(/Edit NAV for 2026-05-01/i)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Edit NAV for 2026-05-01/i));

    const dateInput = screen.getByLabelText(/As of date/i);
    expect(dateInput).toBeDisabled();
    expect(dateInput).toHaveValue("2026-05-01");
    expect(screen.getByLabelText(/^NAV$/i)).toHaveValue(105.5);
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeInTheDocument();
  });

  it("cancel-edit returns to add mode and clears the form", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-05-01", nav: 105.5, note: "Q1" },
    ];
    renderModal();

    await waitFor(() => expect(screen.getByLabelText(/Edit NAV for 2026-05-01/i)).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Edit NAV for 2026-05-01/i));
    fireEvent.click(screen.getByRole("button", { name: /Cancel edit/i }));

    expect(screen.getByRole("button", { name: /Record NAV/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/As of date/i)).not.toBeDisabled();
  });

  it("delete requires Yes confirmation; No cancels it", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-05-01", nav: 105.5, note: null },
    ];
    renderModal();

    await waitFor(() =>
      expect(screen.getByLabelText(/Delete NAV for 2026-05-01/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/Delete NAV for 2026-05-01/i));

    expect(screen.getByText(/Delete\?/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Confirm delete NAV for 2026-05-01/i)).toBeInTheDocument();

    // No button cancels — no server action call
    fireEvent.click(screen.getByLabelText(/Cancel delete/i));
    expect(hoisted.deleteManualNav).not.toHaveBeenCalled();
    expect(screen.queryByText(/Delete\?/)).not.toBeInTheDocument();
  });

  it("Yes confirmation calls deleteManualNav and refetches", async () => {
    hoisted.navHistory = [
      { id: "n1", effective_date: "2026-05-01", nav: 105.5, note: null },
    ];
    renderModal();

    await waitFor(() =>
      expect(screen.getByLabelText(/Delete NAV for 2026-05-01/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/Delete NAV for 2026-05-01/i));
    fireEvent.click(screen.getByLabelText(/Confirm delete NAV for 2026-05-01/i));

    await waitFor(() =>
      expect(hoisted.deleteManualNav).toHaveBeenCalledWith({
        asset_id: "asset-1",
        effective_date: "2026-05-01",
      }),
    );
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("ENXF NAV entry removed");
  });

  it("server action error displays in role='alert' on save", async () => {
    hoisted.upsertManualNav.mockRejectedValue(new Error("Asset not found"));
    renderModal();
    await waitFor(() => expect(screen.getByText(/No NAV entries yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^NAV$/i), { target: { value: "105.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Record NAV/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Asset not found/));
  });

  it("submit button is disabled when NAV is empty", async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/No NAV entries yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Record NAV/i })).toBeDisabled();
  });
});
