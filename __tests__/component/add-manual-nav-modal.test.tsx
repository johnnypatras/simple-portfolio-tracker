import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for AddManualNavModal.
 *
 * Strategy:
 *   - Mock the server actions (addManualNavAsset, upsertStockPosition) so
 *     tests run synchronously in jsdom.
 *   - Mock focus-trap-react to a transparent wrapper — its focus management
 *     conflicts with jsdom's incomplete focus simulation.
 *   - Mock sonner toasts so we can assert success/error feedback.
 *   - Use fireEvent (not userEvent) for sync DOM events; faster + simpler.
 */

// Mocks must be hoisted before module imports.
const hoisted = vi.hoisted(() => ({
  addManualNavAsset: vi.fn(),
  upsertStockPosition: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/manual-nav", () => ({
  addManualNavAsset: hoisted.addManualNavAsset,
}));

vi.mock("@/lib/actions/stocks", () => ({
  upsertStockPosition: hoisted.upsertStockPosition,
}));

vi.mock("sonner", () => ({
  toast: {
    success: hoisted.toastSuccess,
    error: hoisted.toastError,
  },
}));

// focus-trap-react's focus loop misbehaves in jsdom — render children directly.
vi.mock("focus-trap-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AddManualNavModal } from "@/components/stocks/add-manual-nav-modal";
import type { Broker } from "@/lib/types";

const BROKERS: Broker[] = [
  {
    id: "broker-1",
    user_id: "user-123",
    name: "Trade Republic",
    institution_id: "inst-1",
    created_at: "2026-01-01T00:00:00Z",
  },
];

function renderOpen(propOverrides?: Partial<React.ComponentProps<typeof AddManualNavModal>>) {
  const props = {
    open: true,
    onClose: vi.fn(),
    brokers: BROKERS,
    existingSubcategories: [],
    existingTags: [],
    ...propOverrides,
  };
  return { ...render(<AddManualNavModal {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.addManualNavAsset.mockResolvedValue("new-asset-id");
  hoisted.upsertStockPosition.mockResolvedValue(undefined);
});

describe("AddManualNavModal", () => {
  it("renders the modal with sensible ELTIF defaults", () => {
    renderOpen();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/Ticker/i)).toHaveValue("");
    expect(screen.getByLabelText(/Currency/i)).toHaveValue("EUR");
    expect(screen.getByLabelText(/Subtype/i)).toHaveValue("ELTIF");
    expect(screen.getByLabelText(/^Type/i)).toHaveValue("private_equity");
  });

  it("submit button is disabled until ticker and name are filled", () => {
    renderOpen();
    const btn = screen.getByRole("button", { name: /Add to Portfolio/i });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    expect(btn).not.toBeDisabled();
  });

  it("forces kind='manual' and yahoo_ticker=null when submitting", async () => {
    const { props } = renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.addManualNavAsset).toHaveBeenCalled());
    const [assetArg] = hoisted.addManualNavAsset.mock.calls[0];
    expect(assetArg).toMatchObject({
      ticker: "ENXF",
      name: "EQT Nexus",
      yahoo_ticker: null,
    });
    expect(props.onClose).toHaveBeenCalled();
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("EQT Nexus added to portfolio");
  });

  it("includes initialNav when NAV value is filled", async () => {
    renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.change(screen.getByLabelText(/^NAV/i), { target: { value: "105.50" } });
    fireEvent.change(screen.getByLabelText(/As of date/i), { target: { value: "2026-05-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.addManualNavAsset).toHaveBeenCalled());
    const [, opts] = hoisted.addManualNavAsset.mock.calls[0];
    expect(opts).toEqual(
      expect.objectContaining({
        initialNav: expect.objectContaining({ nav: 105.5, effectiveDate: "2026-05-01" }),
      }),
    );
  });

  it("rejects zero NAV without calling the server action", async () => {
    // The input's `min="0"` permits 0 at the browser level, but the app rule
    // requires strictly positive — defense-in-depth client-side check that
    // mirrors validateAmount on the server.
    renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.change(screen.getByLabelText(/^NAV/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toMatch(/positive number/i);
    expect(hoisted.addManualNavAsset).not.toHaveBeenCalled();
  });

  it("displays NAV gap warning when effective_date < nav_date and qty > 0", () => {
    renderOpen();
    // Open the optional position section first
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/As of date/i), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText(/Effective date/i), { target: { value: "2026-02-22" } });
    expect(screen.getByText(/chart will show €0 for this asset/i)).toBeInTheDocument();
  });

  it("does NOT show NAV gap warning when no position qty", () => {
    renderOpen();
    fireEvent.change(screen.getByLabelText(/As of date/i), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText(/Effective date/i), { target: { value: "2026-02-22" } });
    expect(screen.queryByText(/chart will show €0/i)).not.toBeInTheDocument();
  });

  it("shows server-action error in role='alert' and does not close", async () => {
    hoisted.addManualNavAsset.mockRejectedValue(new Error("Ticker already exists"));
    const { props } = renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ticker already exists"));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("surfaces a recovery message when position upsert fails after asset created", async () => {
    hoisted.upsertStockPosition.mockRejectedValue(new Error("Broker not found"));
    renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Broker/i), { target: { value: "broker-1" } });
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => {
      const alert = screen.getByRole("alert").textContent;
      expect(alert).toMatch(/was added, but the initial position could not be created/i);
      expect(alert).toMatch(/Broker not found/);
    });
  });

  it("sets aria-busy during submission", async () => {
    let resolveAdd: (v: string) => void = () => {};
    hoisted.addManualNavAsset.mockReturnValue(new Promise<string>((r) => { resolveAdd = r; }));
    renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "ENXF" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "EQT Nexus" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add to Portfolio/i })).toHaveAttribute("aria-busy", "true");
    });
    resolveAdd("new-asset-id");
  });

  it("resets state when the modal re-opens after closing", () => {
    const { rerender } = renderOpen();
    fireEvent.change(screen.getByLabelText(/Ticker/i), { target: { value: "DIRTY" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "Old Name" } });

    rerender(
      <AddManualNavModal
        open={false}
        onClose={vi.fn()}
        brokers={BROKERS}
        existingSubcategories={[]}
        existingTags={[]}
      />,
    );
    rerender(
      <AddManualNavModal
        open={true}
        onClose={vi.fn()}
        brokers={BROKERS}
        existingSubcategories={[]}
        existingTags={[]}
      />,
    );

    expect(screen.getByLabelText(/Ticker/i)).toHaveValue("");
    expect(screen.getByLabelText(/Name/i)).toHaveValue("");
    expect(screen.getByLabelText(/Subtype/i)).toHaveValue("ELTIF");
  });
});
