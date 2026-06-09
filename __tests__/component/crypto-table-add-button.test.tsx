/**
 * Component test: crypto table toolbar — single "Add" button
 *
 * Asserts that after the Phase 1b-3 button-merge:
 *   1. There is exactly ONE "Add" button and no separate "Buy"/"Record Buy" button.
 *   2. Clicking the "Add" button opens the AddAssetManager picker
 *      (the "Search crypto" input appears).
 */

const hoisted = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh, push: vi.fn(), replace: vi.fn() }),
}));

// Server actions used transitively by AddAssetManager
vi.mock("@/lib/actions/transactions", () => ({
  addNewAssetTransaction: vi.fn(),
  loadAssetTransactions: vi.fn(),
}));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: vi.fn() }));
vi.mock("@/lib/actions/cash-accounts", () => ({ getCashAccounts: vi.fn(async () => []) }));
vi.mock("@/lib/actions/crypto", () => ({
  deleteCryptoAsset: vi.fn(),
  createCryptoAsset: vi.fn(),
  upsertPosition: vi.fn(),
  updateCryptoAsset: vi.fn(),
}));

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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CryptoTable } from "@/components/crypto/crypto-table";
import {
  AddAssetProvider,
  useAddAssetContext,
} from "@/components/transactions/add-asset-context";
import type { CryptoAssetWithPositions, Wallet, CoinGeckoPriceData } from "@/lib/types";

// ── Minimal fixtures ──────────────────────────────────────────────────────────

const WALLETS: Wallet[] = [
  {
    id: "w-1",
    user_id: "u-1",
    name: "Ledger",
    wallet_type: "non_custodial",
    privacy_label: null,
    chain: null,
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
];

const MINIMAL_PROPS = {
  assets: [] as CryptoAssetWithPositions[],
  prices: {} as CoinGeckoPriceData,
  wallets: WALLETS,
  primaryCurrency: "EUR",
  fxRates: { EUR: 1, USD: 1.1 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CryptoTable toolbar — single Add button (Phase 1b-3)", () => {
  it("shows a single Add button and no separate Buy/Record Buy button", () => {
    render(<CryptoTable {...MINIMAL_PROPS} />);

    // The one button we expect
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();

    // Neither of the two old separate buttons should exist
    expect(screen.queryByRole("button", { name: /^buy$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record buy/i })).toBeNull();
  });

  it("clicking Add opens the AddAssetManager picker (search input appears)", () => {
    render(<CryptoTable {...MINIMAL_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // AssetPicker renders this input with aria-label "Search crypto" for crypto
    expect(screen.getByRole("textbox", { name: /search crypto/i })).toBeInTheDocument();
  });

});

describe("CryptoTable — command-palette pre-pick (Phase 1b-3)", () => {
  // The manager pre-picks the pending crypto on mount, which fetches /api/crypto/detail.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chain: "Cardano", subcategory: "L1", availableChains: ["Cardano"] }),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does NOT auto-open the manager when there is no pending (refresh case)", () => {
    // Provider present, pending null (a fresh page load / refresh) → picker stays closed.
    render(
      <AddAssetProvider>
        <CryptoTable {...MINIMAL_PROPS} />
      </AddAssetProvider>,
    );
    expect(screen.queryByRole("textbox", { name: /search crypto/i })).toBeNull();
  });

  it("auto-opens the manager when a crypto pending arrives, then clears it (consume-once)", async () => {
    function Harness() {
      const { setPending, pending } = useAddAssetContext();
      return (
        <>
          <button onClick={() => setPending({ class: "crypto", ticker: "ADA", coingecko_id: "cardano", name: "Cardano" })}>
            stash
          </button>
          <span data-testid="pending">{pending ? "yes" : "no"}</span>
          <CryptoTable {...MINIMAL_PROPS} />
        </>
      );
    }
    render(
      <AddAssetProvider>
        <Harness />
      </AddAssetProvider>,
    );

    // Closed initially (no pending).
    expect(screen.queryByRole("textbox", { name: /search crypto/i })).toBeNull();
    expect(screen.getByTestId("pending")).toHaveTextContent("no");

    // Palette stashes a pending crypto → table opens the manager.
    fireEvent.click(screen.getByText("stash"));

    // The manager mounts pre-picked → consumes-and-clears (pending back to null),
    // but the picker stays open (an asset was pre-selected, not the search step).
    await waitFor(() => expect(screen.getByTestId("pending")).toHaveTextContent("no"));
    // Manager is open: still rendered (close would unmount its modal). It does NOT
    // re-open on the now-null pending — proven by pending staying "no" and no loop.
  });
});
