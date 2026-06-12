import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PositionEditor } from "@/components/crypto/position-editor";
import { INTENT_COPY } from "@/lib/cost-basis-copy";
import type { CryptoAssetWithPositions, Wallet } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  upsertPosition: vi.fn(),
  deletePosition: vi.fn(),
  updateCryptoAsset: vi.fn(),
  loadLastChangeDate: vi.fn(),
  addTransaction: vi.fn(),
}));

vi.mock("@/lib/actions/crypto", () => ({
  upsertPosition: hoisted.upsertPosition,
  deletePosition: hoisted.deletePosition,
  updateCryptoAsset: hoisted.updateCryptoAsset,
}));

vi.mock("@/lib/actions/transactions", () => ({
  loadLastChangeDate: hoisted.loadLastChangeDate,
  addTransaction: hoisted.addTransaction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Fixtures ─────────────────────────────────────────────

const WALLETS: Wallet[] = [
  { id: "w-1", user_id: "u-1", name: "Ledger", wallet_type: "non_custodial", privacy_label: null, chain: null, institution_id: null, created_at: "2026-01-01T00:00:00Z", deleted_at: null },
  { id: "w-2", user_id: "u-1", name: "Binance", wallet_type: "custodial", privacy_label: null, chain: null, institution_id: null, created_at: "2026-01-01T00:00:00Z", deleted_at: null },
];

function makeAsset(positionWalletIds: string[] = ["w-1", "w-2"]): CryptoAssetWithPositions {
  return {
    id: "ca-1",
    user_id: "u-1",
    ticker: "BTC",
    name: "Bitcoin",
    coingecko_id: "bitcoin",
    chain: null,
    subcategory: null,
    image_url: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    positions: positionWalletIds.map((wid, i) => ({
      id: `pos-${wid}`,
      crypto_asset_id: "ca-1",
      wallet_id: wid,
      quantity: 1 + i,
      acquisition_method: "bought" as const,
      apy: 0,
      network: null,
      last_was_adjustment: false,
      last_was_transfer: false,
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      wallet_name: WALLETS.find((w) => w.id === wid)?.name ?? "Unknown",
      wallet_type: WALLETS.find((w) => w.id === wid)?.wallet_type ?? ("custodial" as const),
    })),
  };
}

function renderEditor(asset = makeAsset()) {
  const onClose = vi.fn();
  const onTrade = vi.fn();
  return {
    onClose,
    onTrade,
    ...render(
      <PositionEditor
        open
        onClose={onClose}
        asset={asset}
        wallets={WALLETS}
        existingSubcategories={[]}
        existingChains={[]}
        prices={{ bitcoin: { usd: 60000, eur: 55000 } }}
        onTrade={onTrade}
      />,
    ),
  };
}

// Provide prices so approxValueEur is computable: priceEur €0.50/unit keeps a
// ±10-unit change at €5 (below the €10 gate → quiet cosmetic), and a ±100-unit
// change at €50 (≥ €10 → guard fires).
const PRICES = { bitcoin: { usd: 0.55, eur: 0.5 } };

beforeEach(() => {
  hoisted.upsertPosition.mockReset();
  hoisted.upsertPosition.mockResolvedValue(undefined);
  hoisted.deletePosition.mockReset();
  hoisted.deletePosition.mockResolvedValue(undefined);
  hoisted.updateCryptoAsset.mockReset();
  hoisted.loadLastChangeDate.mockReset();
  hoisted.loadLastChangeDate.mockResolvedValue(null);
  hoisted.addTransaction.mockReset();
  hoisted.addTransaction.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── C3 intent step ────────────────────────────────────────
// These tests cover the new C3 behavior: Save dispatches to the intent step,
// trash routes through it as a full-quantity decrease, and the removed
// Adj checkbox / per-row cost / footer date are gone.

describe("PositionEditor — C3 intent step", () => {
  it("quantity change + Save opens the intent step (no immediate write)", () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(INTENT_COPY.questionIncrease)).toBeInTheDocument();
    expect(hoisted.upsertPosition).not.toHaveBeenCalled();
  });

  it("metadata-only Save (qty untouched) saves silently with the ORIGINAL qty", async () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByTitle("APY %"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(screen.queryByText(INTENT_COPY.questionIncrease)).toBeNull();
    expect(hoisted.upsertPosition.mock.calls[0][0]).toMatchObject({ quantity: 1, apy: 4 });
    expect(hoisted.upsertPosition.mock.calls[0][1]).not.toMatchObject({ isAdjustment: true });
  });

  it("Yes + typed cost routes to Buy with the prefill (no upsert)", async () => {
    const onTrade = vi.fn();
    const onClose = vi.fn();
    render(
      <PositionEditor open onClose={onClose} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={onTrade} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), { target: { value: "8.70" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onTrade).toHaveBeenCalled());
    expect(onTrade).toHaveBeenCalledWith("buy", {
      quantity: 10,
      amount: 8.7,
      amountCurrency: "EUR",
      walletId: "w-1",
      walletOption: { id: "w-1", name: "Ledger" },
    });
    expect(onClose).toHaveBeenCalled();
    expect(hoisted.upsertPosition).not.toHaveBeenCalled();
  });

  it("metadata + qty change routes Buy AFTER a zero-delta metadata save", async () => {
    const onTrade = vi.fn();
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={onTrade} />,
    );
    fireEvent.change(screen.getByTitle("APY %"), { target: { value: "4" } });
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onTrade).toHaveBeenCalled());
    // Metadata persisted FIRST at the ORIGINAL quantity (zero-delta, benchmark-invisible)
    expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertPosition.mock.calls[0][0]).toMatchObject({ quantity: 1, apy: 4 });
  });

  it("free toggle books yield directly via addTransaction", async () => {
    const onClose = vi.fn();
    render(
      <PositionEditor open onClose={onClose} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp("These were free") }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.addTransaction).toHaveBeenCalled());
    expect(hoisted.addTransaction).toHaveBeenCalledWith(
      { class: "crypto", assetId: "ca-1" },
      expect.objectContaining({ type: "yield", quantity: 10, walletId: "w-1" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("cosmetic below the gate saves off-book directly", async () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } }); // +10 ≈ €5 < €10
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition.mock.calls[0][0]).toMatchObject({ quantity: 11 });
    expect(hoisted.upsertPosition.mock.calls[0][1]).toMatchObject({ isAdjustment: true });
  });

  it("cosmetic at/above the gate arms the guard first", async () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "101" } }); // +100 ≈ €50
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(hoisted.upsertPosition).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Stop counting/);
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardProceed }));
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition.mock.calls[0][1]).toMatchObject({ isAdjustment: true });
  });

  it("trash opens the step as a full-quantity decrease; cosmetic calls deletePosition", async () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(INTENT_COPY.questionDecrease)).toBeInTheDocument();
    expect(hoisted.deletePosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // qty 1 ≈ €0.50 < €10 → quiet
    await waitFor(() => expect(hoisted.deletePosition).toHaveBeenCalled());
    expect(hoisted.deletePosition).toHaveBeenCalledWith("pos-w-1", expect.objectContaining({ isAdjustment: true }));
  });

  it("the Adj checkbox, per-row cost field, and footer date are gone", () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    expect(screen.queryByRole("checkbox", { name: /adj/i })).toBeNull();
    expect(screen.queryByLabelText("Amount paid (incl. fees)")).toBeNull();
    expect(screen.queryByLabelText(/effective date/i)).toBeNull();
  });
});

// ─── Correction-date chip (via intent step) ────────────────
// The chip now lives INSIDE the EditorIntentStep (cosmetic path), not the
// footer. Tests confirm it appears when a position has history and the user
// opens the cosmetic path after a quantity-changing save (or trash).

describe("crypto PositionEditor — correction-date chip (intent step)", () => {
  it("chip appears in the intent step when position has history and cosmetic path chosen", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Intent step open — switch to cosmetic
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Chip should appear once the fetch resolves
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /backdate the effective date/i })).not.toBeNull()
    );
  });

  it("chip is absent when fetch resolves null (no history)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /backdate the effective date/i })).toBeNull();
  });

  it("chip is absent when fetch rejects (failure → no dead end)", async () => {
    hoisted.loadLastChangeDate.mockRejectedValue(new Error("boom"));
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /backdate the effective date/i })).toBeNull();
  });

  it("chip does not appear for new positions (no positionId)", async () => {
    // New wallet row (w-2 not yet a position) — no positionId → no fetch
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    // Add w-2 as a new row — the wallet select has placeholder "Add to wallet / exchange..."
    const walletSelect = screen.getByRole("option", { name: /add to wallet/i })
      ?.closest("select") as HTMLSelectElement;
    fireEvent.change(walletSelect, { target: { value: "w-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to selected wallet" }));
    // Change the new row's quantity (second quantity input)
    const qtyInputs = screen.getAllByPlaceholderText("Quantity");
    fireEvent.change(qtyInputs[1], { target: { value: "5" } });
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[1]);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Give time for any async fetch that should NOT have been called
    await waitFor(() => expect(hoisted.loadLastChangeDate).not.toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /backdate the effective date/i })).toBeNull();
  });

  it("trash also exposes chip when position has history and cosmetic path chosen", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-05-01");
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /backdate the effective date/i })).not.toBeNull()
    );
  });
});

// ─── Backdated no-cost cosmetic defers pricing to backfill ──
// Previously the footer effective-date + per-row cost field drove this.
// Now the cosmetic path in the intent step passes a date to handleIntentCosmetic
// which calls omitWriteTimePrice to decide whether to strip the write-time price.

describe("crypto PositionEditor — backdated cosmetic defers to backfill", () => {
  it("cosmetic with a past date → upsertPosition called WITHOUT currentPriceUsd/Eur", async () => {
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } }); // +10 ≈ €5 < €10 gate
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Set a past date in the cosmetic date input
    const dateInput = screen.getByLabelText("Effective date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-03-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceUsd: expect.anything() }),
    );
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceEur: expect.anything() }),
    );
    expect(hoisted.upsertPosition.mock.calls[0][1].effectiveDate).toBe("2026-03-02");
  });

  it("cosmetic with today's default date → upsertPosition called WITH the prices", async () => {
    // EditorIntentStep defaults cosmeticDate to today — omitWriteTimePrice("today", false) = false → prices pass
    render(
      <PositionEditor open onClose={vi.fn()} asset={makeAsset(["w-1"])} wallets={WALLETS}
        existingSubcategories={[]} existingChains={[]} prices={PRICES} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText("Quantity"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Leave the date at the step's default (today) — don't change it
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalled());
    expect(hoisted.upsertPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentPriceUsd: 0.55, currentPriceEur: 0.5 }),
    );
  });
});

// ─── Sell/Buy header buttons (unchanged from 1a) ──────────

describe("PositionEditor — Sell/Buy delegate to the trade modal (1a)", () => {
  it("Sell closes the editor and delegates onTrade('sell')", () => {
    const { onClose, onTrade } = renderEditor();
    fireEvent.click(screen.getByTitle(/sell this asset/i));
    expect(onClose).toHaveBeenCalled();
    expect(onTrade).toHaveBeenCalledWith("sell");
  });
  it("Buy closes the editor and delegates onTrade('buy')", () => {
    const { onClose, onTrade } = renderEditor();
    fireEvent.click(screen.getByTitle(/buy more of this asset/i));
    expect(onClose).toHaveBeenCalled();
    expect(onTrade).toHaveBeenCalledWith("buy");
  });
});

// ─── APY editing (unchanged behavior) ─────────────────────

describe("PositionEditor — APY editing", () => {
  /** A single-row asset whose position starts with a non-zero APY. */
  function assetWithApy(apy: number): CryptoAssetWithPositions {
    const a = makeAsset(["w-1"]);
    a.positions[0].apy = apy;
    return a;
  }

  it("persists APY=0 when a non-zero APY is cleared to 0 (regression: `apy || undefined` dropped explicit 0)", async () => {
    renderEditor(assetWithApy(5));
    const apyInput = screen.getByTitle("APY %") as HTMLInputElement;
    expect(apyInput.value).toBe("5");
    fireEvent.change(apyInput, { target: { value: "0" } });
    // APY change is metadata-only (qty unchanged) → silent save
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    // The position payload (first arg) must carry an explicit 0 — NOT undefined,
    // which partialUpdate would strip, leaving the old 5 in the DB.
    expect(hoisted.upsertPosition.mock.calls[0][0].apy).toBe(0);
  });

  it("preserves a non-zero APY on save (control)", async () => {
    renderEditor(assetWithApy(5));
    // No qty change → metadata-only save
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertPosition.mock.calls[0][0].apy).toBe(5);
  });
});
