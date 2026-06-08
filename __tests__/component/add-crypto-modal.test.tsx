import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * Component tests for AddCryptoModal — focused on the "Amount paid (incl. fees)"
 * cost field added for cost-basis parity with the manual-NAV modal.
 *
 * Strategy mirrors add-manual-nav-modal.test.tsx:
 *   - Mock the server actions (createCryptoAsset, upsertPosition) so the submit
 *     resolves synchronously in jsdom.
 *   - Mock global.fetch so the search + detail API calls return empty (the
 *     modal's search phase is driven directly by injecting a selected coin via
 *     the search flow).
 *   - Mock focus-trap-react + sonner as the other modal tests do.
 *   - Use fireEvent (sync) throughout.
 */

const hoisted = vi.hoisted(() => ({
  createCryptoAsset: vi.fn(),
  upsertPosition: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/actions/crypto", () => ({
  createCryptoAsset: hoisted.createCryptoAsset,
  upsertPosition: hoisted.upsertPosition,
}));

vi.mock("sonner", () => ({
  toast: { success: hoisted.toastSuccess, error: hoisted.toastError },
}));

vi.mock("focus-trap-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// next/image renders an <img> in jsdom without complaint when mocked simply.
// Default `alt` to "" so the stub satisfies jsx-a11y/alt-text — only the
// next-specific element rule needs suppressing.
vi.mock("next/image", () => ({
  default: ({ alt = "", ...rest }: { alt?: string } & Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt={alt} {...(rest as Record<string, never>)} />;
  },
}));

import { AddCryptoModal } from "@/components/crypto/add-crypto-modal";
import type { Wallet, CoinGeckoSearchResult } from "@/lib/types";

const WALLETS: Wallet[] = [
  {
    id: "wallet-1",
    user_id: "user-123",
    name: "Ledger",
    wallet_type: "non_custodial",
    privacy_label: null,
    chain: null,
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const COIN: CoinGeckoSearchResult = {
  id: "bitcoin",
  symbol: "btc",
  name: "Bitcoin",
  thumb: "",
  large: "",
  market_cap_rank: 1,
  price_usd: 50000,
};

function renderOpen() {
  const props = {
    open: true,
    onClose: vi.fn(),
    wallets: WALLETS,
    existingSubcategories: [],
    existingChains: [],
    existingAssets: [],
  };
  return { ...render(<AddCryptoModal {...props} />), props };
}

/** Drive the search phase: type a query, then click the returned coin. */
async function selectCoin() {
  fireEvent.change(screen.getByLabelText(/Search coins/i), { target: { value: "bitcoin" } });
  await waitFor(() => expect(screen.getByText("Bitcoin")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Bitcoin"));
  // Wait for the form phase (Back to search link appears).
  await waitFor(() => expect(screen.getByText(/Back to search/i)).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createCryptoAsset.mockResolvedValue("new-asset-id");
  hoisted.upsertPosition.mockResolvedValue(undefined);
  // Search returns [COIN]; detail returns {} (no chain/subcategory).
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/api/crypto/search")) {
      return { ok: true, json: async () => [COIN] } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AddCryptoModal — Amount paid (incl. fees) cost field", () => {
  it("renders the cost field inside the position section with EUR/USD currency select", async () => {
    renderOpen();
    await selectCoin();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    const costInput = screen.getByLabelText(/Amount paid \(incl\. fees\)/i);
    expect(costInput).toBeInTheDocument();
    expect(costInput).toHaveValue("");
    expect(screen.getByLabelText(/Amount paid currency/i)).toHaveValue("EUR");
  });

  it("an untouched cost field passes NO cost to upsertPosition (market fallback)", async () => {
    renderOpen();
    await selectCoin();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Wallet \/ Exchange/i), { target: { value: "wallet-1" } });
    fireEvent.change(screen.getByLabelText(/Quantity/i), { target: { value: "2" } });
    // Cost field left untouched.
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertPosition.mock.calls[0];
    expect(opts.cost).toBeUndefined();
  });

  it("a typed cost is threaded to upsertPosition with the chosen currency", async () => {
    renderOpen();
    await selectCoin();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Wallet \/ Exchange/i), { target: { value: "wallet-1" } });
    fireEvent.change(screen.getByLabelText(/Quantity/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Amount paid \(incl\. fees\)/i), { target: { value: "1500" } });
    fireEvent.change(screen.getByLabelText(/Amount paid currency/i), { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertPosition.mock.calls[0];
    expect(opts.cost).toEqual({ amount: 1500, currency: "USD" });
  });

  it("blanking a dirtied cost field passes NO cost (provenance gate)", async () => {
    renderOpen();
    await selectCoin();
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Wallet \/ Exchange/i), { target: { value: "wallet-1" } });
    fireEvent.change(screen.getByLabelText(/Quantity/i), { target: { value: "2" } });
    const costInput = screen.getByLabelText(/Amount paid \(incl\. fees\)/i);
    fireEvent.change(costInput, { target: { value: "1500" } });
    fireEvent.change(costInput, { target: { value: "" } }); // blanked after dirtying
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    const [, opts] = hoisted.upsertPosition.mock.calls[0];
    expect(opts.cost).toBeUndefined();
  });
});

// ─── Backdated/no-cost entries defer pricing to the backfill ──
// The search result carries only price_usd (no EUR). Passing USD-only would
// book a $0 EUR cashflow at cashflow_status=complete (the EUR-leg bug), so a
// no-cost entry omits the price entirely — backfill values both currencies at
// the effective date. An entry WITH a user cost keeps the USD price.
describe("AddCryptoModal — backdated/no-cost defers to backfill", () => {
  async function fillPosition() {
    fireEvent.click(screen.getByRole("button", { name: /Add initial position/i }));
    fireEvent.change(screen.getByLabelText(/Wallet \/ Exchange/i), { target: { value: "wallet-1" } });
    fireEvent.change(screen.getByLabelText(/Quantity/i), { target: { value: "2" } });
  }

  it("backdated + no cost → upsertPosition called WITHOUT currentPriceUsd", async () => {
    renderOpen();
    await selectCoin();
    await fillPosition();
    fireEvent.change(screen.getByLabelText("Effective date (optional)"), { target: { value: "2026-03-02" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceUsd: expect.anything() }),
    );
  });

  it("today (no effectiveDate) + no cost → upsertPosition called WITHOUT currentPriceUsd (no EUR source → defer)", async () => {
    renderOpen();
    await selectCoin();
    await fillPosition();
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceUsd: expect.anything() }),
    );
  });

  it("with a user cost → currentPriceUsd still passes", async () => {
    renderOpen();
    await selectCoin();
    await fillPosition();
    fireEvent.change(screen.getByLabelText(/Amount paid \(incl\. fees\)/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to Portfolio/i }));

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentPriceUsd: 50000 }),
    );
  });
});
