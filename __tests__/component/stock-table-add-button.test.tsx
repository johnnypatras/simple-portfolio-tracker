/**
 * Component test: stock table toolbar — single "Add" button (Phase 1b-3)
 *
 * Asserts that after the button-merge:
 *   1. There is no separate "Buy" button and no "Add ▾" dropdown trigger.
 *   2. Clicking the single "Add" button opens the AddAssetManager picker
 *      (the "Search stocks or ETFs" input appears).
 *   3. Clicking the "Not listed?" escape inside the picker closes AddAssetManager
 *      and opens AddManualNavModal ("Add Manual NAV Asset" heading appears).
 */

const hoisted = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/shared-view-context", () => ({
  useSharedView: () => ({ shareToken: null, isReadOnly: false }),
}));

// Server actions used transitively by AddAssetManager + StockTable
vi.mock("@/lib/actions/stocks", () => ({
  deleteStockAsset: vi.fn(),
  createStockAsset: vi.fn(),
  upsertStockPosition: vi.fn(),
}));
vi.mock("@/lib/actions/manual-nav", () => ({
  addManualNavAsset: vi.fn(),
}));
vi.mock("@/lib/actions/transactions", () => ({
  addNewAssetTransaction: vi.fn(),
  loadAssetTransactions: vi.fn(),
}));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: vi.fn() }));
vi.mock("@/lib/actions/cash-accounts", () => ({ getCashAccounts: vi.fn(async () => []) }));

// Silence sonner toasts in jsdom
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// FocusTrap has no jsdom implementation — render children directly
vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// next/image has no real implementation in jsdom
vi.mock("next/image", () => ({
  default: ({ alt = "", ...rest }: { alt?: string } & Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...(rest as Record<string, never>)} />
  ),
}));

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StockTable } from "@/components/stocks/stock-table";
import type { StockAssetWithPositions, Broker, YahooStockPriceData } from "@/lib/types";

// ── Minimal fixtures ──────────────────────────────────────────────────────────

const BROKERS: Broker[] = [
  {
    id: "b-1",
    user_id: "u-1",
    name: "DEGIRO",
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const MINIMAL_PROPS = {
  assets: [] as StockAssetWithPositions[],
  prices: {} as YahooStockPriceData,
  brokers: BROKERS,
  primaryCurrency: "EUR",
  fxRates: { EUR: 1, USD: 1.1 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StockTable toolbar — single Add button (Phase 1b-3)", () => {
  it("shows a single Add button and no separate Buy or Add-menu dropdown", () => {
    render(<StockTable {...MINIMAL_PROPS} />);

    // The one button we expect
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();

    // Neither the old separate Buy button nor the old Add-menu dropdown trigger
    expect(screen.queryByRole("button", { name: /^buy$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add ▾|add menu/i })).toBeNull();
  });

  it("clicking Add opens the AddAssetManager picker (stock search input appears)", () => {
    render(<StockTable {...MINIMAL_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // AssetPicker renders this input with aria-label "Search stocks or ETFs" for stocks
    expect(
      screen.getByRole("textbox", { name: /search stocks or etfs/i }),
    ).toBeInTheDocument();
  });

  it("'Not listed?' escape in the picker opens AddManualNavModal", async () => {
    render(<StockTable {...MINIMAL_PROPS} />);

    // Open the manager (picker step)
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // The "Not listed?" escape is rendered inside the picker step
    fireEvent.click(screen.getByRole("button", { name: /not listed/i }));

    // AddManualNavModal is lazy-loaded via next/dynamic — wait for it to resolve
    // and render its title ("Add Manual NAV Asset")
    await waitFor(() =>
      expect(screen.getByText(/add manual nav asset/i)).toBeInTheDocument(),
    );
  });
});
