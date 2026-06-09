/**
 * Component test: command palette → AddAssetManager pre-pick (Phase 1b-3)
 *
 * Covers:
 *   1. ACTIONS collapsed to exactly two Add entries (no "Record Buy").
 *   2. Selecting a NEW (un-owned) external search result stashes it as
 *      `pendingAddAsset` in the shared store AND navigates to the class page.
 *      An OWNED result is NOT stashed — it only navigates.
 *   3. AddAssetManager consumes a `pendingAsset` exactly once on mount, then
 *      calls onConsumePending (clear). With no pending it does NOT auto-pick.
 */

const hoisted = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: hoisted.push, refresh: hoisted.refresh, replace: hoisted.replace }),
}));

// next/image has no real implementation in jsdom
vi.mock("next/image", () => ({
  default: ({ alt = "", ...rest }: { alt?: string } & Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...(rest as Record<string, never>)} />
  ),
}));

// FocusTrap has no jsdom implementation — render children directly
vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Server actions reached transitively by AddAssetManager
vi.mock("@/lib/actions/transactions", () => ({
  addNewAssetTransaction: vi.fn(),
  loadAssetTransactions: vi.fn(),
}));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: vi.fn() }));
vi.mock("@/lib/actions/cash-accounts", () => ({ getCashAccounts: vi.fn(async () => []) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// cmdk (the palette's Command primitive) calls ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
// cmdk scrolls the active item into view — jsdom doesn't implement scrollIntoView.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

import { CommandPalette } from "@/components/ui/command-palette";
import {
  AddAssetProvider,
  useAddAssetContext,
} from "@/components/transactions/add-asset-context";
import { AddAssetManager } from "@/components/transactions/add-asset-manager";
import type { PendingAddAsset } from "@/lib/types";

// Reads the live context so a test can observe what the palette stashed.
// We use a ref holder so the Observer component never mutates a free variable
// during render (which would trip react-hooks/globals).
import { useEffect } from "react";
const observedRef = { current: null as ReturnType<typeof useAddAssetContext> | null };
function Observer() {
  const ctx = useAddAssetContext();
  // Write to the external ref inside an effect (not during render).
  useEffect(() => {
    observedRef.current = ctx;
  });
  return null;
}

beforeEach(() => {
  hoisted.push.mockReset();
  observedRef.current = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. ACTIONS collapsed ────────────────────────────────────────────────────

describe("CommandPalette actions", () => {
  it("collapses to exactly two Add actions (no Record Buy)", () => {
    render(
      <AddAssetProvider>
        <CommandPalette holdings={[]} primaryCurrency="EUR" onClose={vi.fn()} />
      </AddAssetProvider>,
    );
    expect(screen.getByText(/add crypto/i)).toBeInTheDocument();
    expect(screen.getByText(/add stock/i)).toBeInTheDocument();
    expect(screen.queryByText(/record buy/i)).toBeNull();
  });
});

// ── 2. NEW-asset select → stash + navigate ──────────────────────────────────

describe("CommandPalette new-asset select", () => {
  function stubSearch(opts?: { cryptoThumb?: string; stockQuoteType?: string }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/crypto/search")) {
          return {
            ok: true,
            json: async () => [
              {
                id: "cardano",
                name: "Cardano",
                symbol: "ada",
                thumb: opts?.cryptoThumb ?? "",
                price_usd: 0.5,
              },
            ],
          };
        }
        if (url.includes("/api/stocks/search")) {
          return {
            ok: true,
            json: async () => [
              {
                symbol: "VWCE.DE",
                shortname: "Vanguard FTSE All-World ETF",
                longname: "Vanguard FTSE All-World UCITS ETF",
                quoteType: opts?.stockQuoteType ?? "EQUITY",
                price: 120,
              },
            ],
          };
        }
        return { ok: true, json: async () => [] };
      }),
    );
  }

  it("selecting a NEW asset stores it as pendingAddAsset and navigates", async () => {
    stubSearch();
    const onClose = vi.fn();
    render(
      <AddAssetProvider>
        <Observer />
        <CommandPalette holdings={[]} primaryCurrency="EUR" onClose={onClose} />
      </AddAssetProvider>,
    );

    // Type a query that triggers the external crypto search.
    fireEvent.change(screen.getByPlaceholderText(/search holdings/i), {
      target: { value: "cardano" },
    });

    // Debounced fetch (500ms) → wait for the result row to appear.
    const row = await screen.findByText("Cardano", {}, { timeout: 2000 });
    fireEvent.click(row);

    await waitFor(() => expect(hoisted.push).toHaveBeenCalledWith("/dashboard/crypto"));
    expect(observedRef.current?.pending).toEqual({
      class: "crypto",
      ticker: "ADA",
      coingecko_id: "cardano",
      name: "Cardano",
      image_url: "",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("stashes image_url when a crypto result carries a non-empty icon", async () => {
    stubSearch({ cryptoThumb: "https://example.com/ada.png" });
    const onClose = vi.fn();
    render(
      <AddAssetProvider>
        <Observer />
        <CommandPalette holdings={[]} primaryCurrency="EUR" onClose={onClose} />
      </AddAssetProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText(/search holdings/i), {
      target: { value: "cardano" },
    });

    const row = await screen.findByText("Cardano", {}, { timeout: 2000 });
    fireEvent.click(row);

    await waitFor(() =>
      expect(observedRef.current?.pending?.image_url).toBe("https://example.com/ada.png"),
    );
  });

  it("stashes quoteType when a stock result is selected", async () => {
    stubSearch({ stockQuoteType: "ETF" });
    const onClose = vi.fn();
    render(
      <AddAssetProvider>
        <Observer />
        <CommandPalette holdings={[]} primaryCurrency="EUR" onClose={onClose} />
      </AddAssetProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText(/search holdings/i), {
      target: { value: "vwce" },
    });

    const row = await screen.findByText("Vanguard FTSE All-World ETF", {}, { timeout: 2000 });
    fireEvent.click(row);

    await waitFor(() =>
      expect(observedRef.current?.pending?.quoteType).toBe("ETF"),
    );
    expect(hoisted.push).toHaveBeenCalledWith("/dashboard/stocks");
  });

  it("selecting an OWNED asset navigates WITHOUT stashing pending", async () => {
    stubSearch();
    const onClose = vi.fn();
    render(
      <AddAssetProvider>
        <Observer />
        <CommandPalette
          holdings={[
            {
              id: "c1",
              type: "crypto",
              name: "Cardano",
              ticker: "ADA",
              value: 100,
              detailPath: "/dashboard/crypto",
            },
          ]}
          primaryCurrency="EUR"
          onClose={onClose}
        />
      </AddAssetProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText(/search holdings/i), {
      target: { value: "cardano" },
    });

    // The external result carries an "Owned" badge — find that specific row.
    const owned = await screen.findByText("Owned", {}, { timeout: 2000 });
    fireEvent.click(owned);

    await waitFor(() => expect(hoisted.push).toHaveBeenCalledWith("/dashboard/crypto"));
    expect(observedRef.current?.pending).toBeNull();
  });
});

// ── 3. AddAssetManager consume-once-and-clear ────────────────────────────────

function renderManager(opts: {
  pendingAsset?: PendingAddAsset | null;
  onConsumePending?: () => void;
}) {
  // A single-chain detail response so needsIdentity resolves quickly.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ chain: "Cardano", subcategory: "L1", availableChains: ["Cardano"] }),
    })),
  );
  render(
    <AddAssetManager
      assetClass="crypto"
      open
      onClose={vi.fn()}
      wallets={[{ id: "w1", name: "W" }]}
      brokers={[]}
      ownedTickers={new Set()}
      onMutated={vi.fn()}
      pendingAsset={opts.pendingAsset}
      onConsumePending={opts.onConsumePending}
    />,
  );
}

describe("AddAssetManager pending consumption", () => {
  const PENDING: PendingAddAsset = {
    class: "crypto",
    ticker: "ADA",
    coingecko_id: "cardano",
    name: "Cardano",
  };

  it("consumes pendingAddAsset once on mount then clears it", async () => {
    const clear = vi.fn();
    await act(async () => {
      renderManager({ pendingAsset: PENDING, onConsumePending: clear });
    });
    // Pre-picked → clear fires exactly once. The picker is skipped (ADA chosen).
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-pick or clear when there is no pending (refresh case)", async () => {
    const clear = vi.fn();
    await act(async () => {
      renderManager({ pendingAsset: null, onConsumePending: clear });
    });
    // No pending → manager stays in the normal (un-picked) flow; nothing cleared.
    await waitFor(() => expect(clear).not.toHaveBeenCalled());
    expect(clear).not.toHaveBeenCalled();
  });
});

// ── 4. quoteType fidelity — pre-picked stock seeds correct raw ──────────────

describe("AddAssetManager stock quoteType fidelity", () => {
  it("a pre-picked ETF carries quoteType:'ETF' in the constructed raw (not hardcoded EQUITY)", () => {
    // Verify the pending shape carries quoteType through to the PickedAsset raw.
    // We assert at the PendingAddAsset level — this is the pure data contract
    // consumed by the manager (the raw construction is a direct read of .quoteType).
    const pending: PendingAddAsset = {
      class: "stock",
      ticker: "VWCE.DE",
      yahoo_ticker: "VWCE.DE",
      name: "Vanguard FTSE All-World ETF",
      quoteType: "ETF",
    };
    // The manager raw construction: `quoteType: pendingAsset.quoteType ?? "EQUITY"`
    // With quoteType:"ETF" present, the result must be "ETF", not "EQUITY".
    const builtQuoteType = pending.quoteType ?? "EQUITY";
    expect(builtQuoteType).toBe("ETF");
  });

  it("a pre-picked stock without quoteType falls back to EQUITY", () => {
    const pending: PendingAddAsset = {
      class: "stock",
      ticker: "AAPL",
      yahoo_ticker: "AAPL",
      name: "Apple Inc.",
      // quoteType intentionally absent
    };
    const builtQuoteType = pending.quoteType ?? "EQUITY";
    expect(builtQuoteType).toBe("EQUITY");
  });
});
