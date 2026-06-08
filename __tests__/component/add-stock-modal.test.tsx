import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for AddStockModal — focused on the "Amount paid (incl. fees)"
 * cost field added for cost-basis parity with the manual-NAV modal.
 *
 * Strategy mirrors add-manual-nav-modal.test.tsx: mock the server actions,
 * mock global.fetch for the Yahoo search, mock focus-trap-react + sonner, and
 * drive the search→select flow with fireEvent.
 */

const hoisted = vi.hoisted(() => ({
  createStockAsset: vi.fn(),
  upsertStockPosition: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/stocks", () => ({
  createStockAsset: hoisted.createStockAsset,
  upsertStockPosition: hoisted.upsertStockPosition,
}));

vi.mock("sonner", () => ({
  toast: { success: hoisted.toastSuccess, error: hoisted.toastError },
}));

vi.mock("focus-trap-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AddStockModal } from "@/components/stocks/add-stock-modal";
import type { Broker, YahooSearchResult } from "@/lib/types";

const BROKERS: Broker[] = [
  {
    id: "broker-1",
    user_id: "user-123",
    name: "DEGIRO",
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const RESULT: YahooSearchResult = {
  symbol: "AAPL",
  shortname: "Apple Inc.",
  longname: "Apple Inc.",
  quoteType: "EQUITY",
  exchDisp: "NASDAQ",
  exchange: "NMS",
  currency: "USD",
  price: 200,
};

function renderOpen() {
  const props = {
    open: true,
    onClose: vi.fn(),
    brokers: BROKERS,
    existingSubcategories: [],
    existingTags: [],
  };
  return { ...render(<AddStockModal {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createStockAsset.mockResolvedValue("new-asset-id");
  hoisted.upsertStockPosition.mockResolvedValue(undefined);
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/api/stocks/search")) {
      return { ok: true, json: async () => [RESULT] } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Move from search phase into the form phase by selecting the search result. */
async function intoForm() {
  fireEvent.change(screen.getByLabelText(/Search stocks and ETFs/i), { target: { value: "apple" } });
  // The result row shows the symbol "AAPL" — wait for it, then click.
  const row = await screen.findByText("Apple Inc.");
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByText(/Back to search/i)).toBeInTheDocument());
}

describe("AddStockModal — Amount paid (incl. fees) cost field", () => {
  it("renders the cost field inside the position section with EUR/USD currency select", async () => {
    renderOpen();
    await intoForm();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    const costInput = screen.getByLabelText(/Amount paid \(incl\. fees\)/i);
    expect(costInput).toBeInTheDocument();
    expect(costInput).toHaveValue("");
    expect(screen.getByLabelText(/Amount paid currency/i)).toHaveValue("EUR");
  });

  it("an untouched cost field passes NO cost to upsertStockPosition (market fallback)", async () => {
    renderOpen();
    await intoForm();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Broker/i), { target: { value: "broker-1" } });
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertStockPosition.mock.calls[0];
    expect(opts.cost).toBeUndefined();
  });

  it("a typed cost is threaded to upsertStockPosition with the chosen currency", async () => {
    renderOpen();
    await intoForm();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Broker/i), { target: { value: "broker-1" } });
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Amount paid \(incl\. fees\)/i), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertStockPosition.mock.calls[0];
    expect(opts.cost).toEqual({ amount: 2000, currency: "EUR" });
  });

  it("blanking a dirtied cost field passes NO cost (provenance gate)", async () => {
    renderOpen();
    await intoForm();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Broker/i), { target: { value: "broker-1" } });
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "10" } });
    const costInput = screen.getByLabelText(/Amount paid \(incl\. fees\)/i);
    fireEvent.change(costInput, { target: { value: "2000" } });
    fireEvent.change(costInput, { target: { value: "" } }); // blanked after dirtying
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertStockPosition.mock.calls[0];
    expect(opts.cost).toBeUndefined();
  });
});

// ─── Backdated no-cost entries defer pricing to the backfill ──
// A backdated row with NO user cost must NOT carry a write-time market price,
// so the row lands cashflow_status=null and the backfill prices it at
// effective_date. A today no-cost row keeps the native price.
describe("AddStockModal — backdated no-cost defers to backfill", () => {
  async function fillPosition() {
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Broker/i), { target: { value: "broker-1" } });
    fireEvent.change(screen.getByLabelText(/Shares/i), { target: { value: "10" } });
  }

  it("backdated + no cost → upsertStockPosition called WITHOUT currentPriceNative", async () => {
    renderOpen();
    await intoForm();
    await fillPosition();
    fireEvent.change(screen.getByLabelText("Effective date (optional)"), { target: { value: "2026-03-02" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceNative: expect.anything() }),
    );
  });

  it("today (no effectiveDate) + no cost → upsertStockPosition called WITH currentPriceNative", async () => {
    renderOpen();
    await intoForm();
    await fillPosition();
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentPriceNative: 200 }),
    );
  });

  it("backdated WITH a user cost → currentPriceNative still passes", async () => {
    renderOpen();
    await intoForm();
    await fillPosition();
    fireEvent.change(screen.getByLabelText("Effective date (optional)"), { target: { value: "2026-03-02" } });
    fireEvent.change(screen.getByLabelText(/Amount paid \(incl\. fees\)/i), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentPriceNative: 200 }),
    );
  });
});
