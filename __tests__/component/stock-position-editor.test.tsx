import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StockPositionEditor } from "@/components/stocks/stock-position-editor";
import { INTENT_COPY } from "@/lib/cost-basis-copy";
import type { StockAssetWithPositions, Broker } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  upsertStockPosition: vi.fn(),
  deleteStockPosition: vi.fn(),
  updateStockAsset: vi.fn(),
  getStockAssetsWithPositions: vi.fn(),
  loadLastChangeDate: vi.fn(),
  addTransaction: vi.fn(),
  getWallets: vi.fn(),
  getBrokers: vi.fn(),
  getCashAccounts: vi.fn(),
  getCryptoAssetsWithPositions: vi.fn(),
  executeTransfer: vi.fn(),
}));

vi.mock("@/lib/actions/stocks", () => ({
  upsertStockPosition: hoisted.upsertStockPosition,
  deleteStockPosition: hoisted.deleteStockPosition,
  updateStockAsset: hoisted.updateStockAsset,
  getStockAssetsWithPositions: hoisted.getStockAssetsWithPositions,
}));

vi.mock("@/lib/actions/transactions", () => ({
  loadLastChangeDate: hoisted.loadLastChangeDate,
  addTransaction: hoisted.addTransaction,
}));

vi.mock("@/lib/actions/wallets", () => ({ getWallets: hoisted.getWallets }));
vi.mock("@/lib/actions/brokers", () => ({ getBrokers: hoisted.getBrokers }));
vi.mock("@/lib/actions/cash-accounts", () => ({ getCashAccounts: hoisted.getCashAccounts }));
vi.mock("@/lib/actions/crypto", () => ({ getCryptoAssetsWithPositions: hoisted.getCryptoAssetsWithPositions }));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: hoisted.executeTransfer }));

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

const BROKERS: Broker[] = [
  { id: "b-1", user_id: "u-1", name: "DEGIRO", institution_id: null, created_at: "2026-01-01T00:00:00Z", deleted_at: null },
  { id: "b-2", user_id: "u-1", name: "IBKR", institution_id: null, created_at: "2026-01-01T00:00:00Z", deleted_at: null },
];

function makeAsset(positionBrokerIds: string[] = ["b-1", "b-2"]): StockAssetWithPositions {
  return {
    id: "sa-1",
    user_id: "u-1",
    ticker: "VUSA",
    name: "Vanguard S&P 500",
    isin: null,
    yahoo_ticker: "VUSA.AS",
    kind: "yahoo",
    category: "etf",
    tags: [],
    currency: "USD",
    subcategory: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    positions: positionBrokerIds.map((bid, i) => ({
      id: `pos-${bid}`,
      stock_asset_id: "sa-1",
      broker_id: bid,
      quantity: 10 + i,
      last_was_adjustment: false,
      last_was_transfer: false,
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      broker_name: BROKERS.find((b) => b.id === bid)?.name ?? "Unknown",
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
      <StockPositionEditor
        open
        onClose={onClose}
        asset={asset}
        brokers={BROKERS}
        existingSubcategories={[]}
        existingTags={[]}
        prices={{ "VUSA.AS": { price: 80, currency: "USD" } }}
        onTrade={onTrade}
      />,
    ),
  };
}

// Provide prices so approxValueEur is computable:
// priceNative €0.50/unit (EUR-denominated) × fxRates={} → 1:1 → keeps a
// ±10-unit change at €5 (below the €10 gate → quiet cosmetic), and a ±100-unit
// change at €50 (≥ €10 → guard fires).
const PRICES_EUR = { "VUSA.AS": { price: 0.5, currency: "EUR" } };

// Helper: get the first spinbutton (qty input) in the first broker row.
// The stock qty inputs have no placeholder — find by role.
function firstQtyInput(): HTMLInputElement {
  return screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
}

function chipButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /backdate the effective date/i });
}

beforeEach(() => {
  hoisted.upsertStockPosition.mockReset();
  hoisted.upsertStockPosition.mockResolvedValue(undefined);
  hoisted.deleteStockPosition.mockReset();
  hoisted.deleteStockPosition.mockResolvedValue(undefined);
  hoisted.updateStockAsset.mockReset();
  hoisted.getStockAssetsWithPositions.mockReset();
  hoisted.getStockAssetsWithPositions.mockResolvedValue([]);
  hoisted.loadLastChangeDate.mockReset();
  hoisted.loadLastChangeDate.mockResolvedValue(null);
  hoisted.addTransaction.mockReset();
  hoisted.addTransaction.mockResolvedValue(undefined);
  hoisted.getWallets.mockReset();
  hoisted.getWallets.mockResolvedValue([]);
  hoisted.getBrokers.mockReset();
  hoisted.getBrokers.mockResolvedValue([]);
  hoisted.getCashAccounts.mockReset();
  hoisted.getCashAccounts.mockResolvedValue([]);
  hoisted.getCryptoAssetsWithPositions.mockReset();
  hoisted.getCryptoAssetsWithPositions.mockResolvedValue([]);
  hoisted.executeTransfer.mockReset();
  hoisted.executeTransfer.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── C3 intent step ────────────────────────────────────────
// These tests cover the new C3 behavior: Save dispatches to the intent step,
// trash routes through it as a full-quantity decrease, and the removed
// Adj checkbox / per-row cost / footer date are gone.

describe("StockPositionEditor — C3 intent step", () => {
  it("quantity change + Save opens the intent step (no immediate write)", () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    const qtyInput = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(qtyInput, { target: { value: "20" } }); // +10
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(INTENT_COPY.questionIncrease)).toBeInTheDocument();
    expect(hoisted.upsertStockPosition).not.toHaveBeenCalled();
  });

  it("zero-delta Save (qty untouched) saves silently — no intent step", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    // qty is already 10 — save without changing it (zero-delta path)
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(screen.queryByText(INTENT_COPY.questionIncrease)).toBeNull();
    expect(hoisted.upsertStockPosition.mock.calls[0][0]).toMatchObject({ quantity: 10 });
    expect(hoisted.upsertStockPosition.mock.calls[0][1]).not.toMatchObject({ isAdjustment: true });
  });

  it("Yes + typed cost routes to Buy with the prefill (no upsert)", async () => {
    const onTrade = vi.fn();
    const onClose = vi.fn();
    render(
      <StockPositionEditor open onClose={onClose} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={onTrade} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } }); // +10
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), { target: { value: "8.70" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onTrade).toHaveBeenCalled());
    expect(onTrade).toHaveBeenCalledWith("buy", {
      quantity: 10,
      amount: 8.7,
      amountCurrency: "EUR",
      brokerId: "b-1",
      brokerOption: { id: "b-1", name: "DEGIRO" },
    });
    expect(onClose).toHaveBeenCalled();
    expect(hoisted.upsertStockPosition).not.toHaveBeenCalled();
  });

  it("free toggle books yield directly via addTransaction", async () => {
    const onClose = vi.fn();
    render(
      <StockPositionEditor open onClose={onClose} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } }); // +10
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp("These were free") }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.addTransaction).toHaveBeenCalled());
    expect(hoisted.addTransaction).toHaveBeenCalledWith(
      { class: "stock", assetId: "sa-1" },
      expect.objectContaining({ type: "yield", quantity: 10, brokerId: "b-1" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("cosmetic below the gate saves off-book directly", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } }); // +10 ≈ €5 < €10
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition.mock.calls[0][0]).toMatchObject({ quantity: 20 });
    expect(hoisted.upsertStockPosition.mock.calls[0][1]).toMatchObject({ isAdjustment: true });
  });

  it("cosmetic at/above the gate arms the guard first", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "110" } }); // +100 ≈ €50
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(hoisted.upsertStockPosition).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Stop counting/);
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardProceed }));
    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition.mock.calls[0][1]).toMatchObject({ isAdjustment: true });
  });

  it("trash opens the step as a full-quantity decrease; cosmetic calls deleteStockPosition", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(INTENT_COPY.questionDecrease)).toBeInTheDocument();
    expect(hoisted.deleteStockPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" })); // qty 10 ≈ €5 < €10 → quiet
    await waitFor(() => expect(hoisted.deleteStockPosition).toHaveBeenCalled());
    expect(hoisted.deleteStockPosition).toHaveBeenCalledWith("pos-b-1", expect.objectContaining({ isAdjustment: true }));
  });

  it("the Adj checkbox, per-row cost field, and footer effective date are gone", () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    expect(screen.queryByRole("checkbox", { name: /adj/i })).toBeNull();
    expect(screen.queryByLabelText("Amount paid (incl. fees)")).toBeNull();
    expect(screen.queryByLabelText(/effective date/i)).toBeNull();
  });

  it("a failed yield keeps the step open and shows the error", async () => {
    const onClose = vi.fn();
    hoisted.addTransaction.mockRejectedValueOnce(new Error("Failed to record yield"));
    render(
      <StockPositionEditor open onClose={onClose} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp("These were free") }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to record yield"));
    expect(screen.getByText(INTENT_COPY.questionIncrease)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the transfer nudge button closes the step and opens the move dialog", async () => {
    const asset = makeAsset(["b-1"]);
    asset.positions[0].last_was_transfer = true;
    const onClose = vi.fn();
    render(
      <StockPositionEditor open onClose={onClose} asset={asset} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(INTENT_COPY.nudgeTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.nudgeButton }));
    expect(screen.queryByText(INTENT_COPY.questionIncrease)).toBeNull();
    // The editor modal stays open (onClose not called) and the TransferDialog is mounted
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a new-row Buy forwards the brokerOption prefill", async () => {
    const onTrade = vi.fn();
    const onClose = vi.fn();
    render(
      <StockPositionEditor open onClose={onClose} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={onTrade} />,
    );
    // Add b-2 as a new row
    const brokerSelect = screen.getByRole("option", { name: /add to broker/i })
      ?.closest("select") as HTMLSelectElement;
    fireEvent.change(brokerSelect, { target: { value: "b-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to selected broker" }));
    // Set qty on the new row (second spinbutton)
    const qtyInputs = screen.getAllByRole("spinbutton");
    fireEvent.change(qtyInputs[1], { target: { value: "5" } });
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[1]);
    // Step is open — Continue without cost (blank)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onTrade).toHaveBeenCalled());
    expect(onTrade).toHaveBeenCalledWith("buy", expect.objectContaining({
      quantity: 5,
      brokerId: "b-2",
      brokerOption: { id: "b-2", name: "IBKR" },
    }));
  });

  // ─── Backdated cosmetic defers to backfill ─────────────────
  // The cosmetic path in the intent step passes a date to handleIntentCosmetic
  // which calls omitWriteTimePrice to decide whether to strip the write-time price.

  it("cosmetic with a past date → upsertStockPosition called WITHOUT currentPriceNative", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } }); // +10 ≈ €5 < €10 gate
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Set a past date in the cosmetic date input
    const dateInput = screen.getByLabelText("Effective date") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-03-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ currentPriceNative: expect.anything() }),
    );
    expect(hoisted.upsertStockPosition.mock.calls[0][1].effectiveDate).toBe("2026-03-02");
  });

  it("cosmetic with today's default date → upsertStockPosition called WITH currentPriceNative", async () => {
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    // Leave the date at the step's default (today) — don't change it
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalled());
    expect(hoisted.upsertStockPosition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentPriceNative: 0.5, assetCurrency: "EUR" }),
    );
  });

  // ─── Correction-date chip (via intent step) ─────────────────

  it("chip appears in the intent step when position has history and cosmetic path chosen", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /backdate the effective date/i })).not.toBeNull()
    );
  });

  it("chip is absent when fetch resolves null (no history)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /backdate the effective date/i })).toBeNull();
  });

  it("chip does not appear for new positions (no positionId)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    // Add b-2 as a new row
    const brokerSelect = screen.getByRole("option", { name: /add to broker/i })
      ?.closest("select") as HTMLSelectElement;
    fireEvent.change(brokerSelect, { target: { value: "b-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to selected broker" }));
    // Change the new row's quantity (second spinbutton)
    const qtyInputs = screen.getAllByRole("spinbutton");
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
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /backdate the effective date/i })).not.toBeNull()
    );
  });
});

// ─── Sell/Buy header buttons ───────────────────────────────
// Rewritten: the old tests remain valid (1a behavior unchanged);
// onTrade signature now accepts prefill as second arg.

describe("StockPositionEditor — Sell/Buy delegate to the trade modal (1a)", () => {
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

// ─── Correction-date chip (intent step, via qty-change flow) ──
// Previously the chip lived in the footer; now it lives inside EditorIntentStep.
// These tests confirm it appears/disappears correctly after Save opens the step
// and the user selects the cosmetic path.

describe("stock StockPositionEditor — correction-date chip (intent step)", () => {
  it("appears when position has history and cosmetic path is chosen after Save", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    expect(chipButton()).toBeNull();
    fireEvent.change(firstQtyInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(chipButton()).not.toBeNull());
  });

  it("is hidden when the fetch resolves null (no history)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(firstQtyInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    expect(chipButton()).toBeNull();
  });

  it("is hidden when the fetch rejects (failure → no dead end)", async () => {
    hoisted.loadLastChangeDate.mockRejectedValue(new Error("boom"));
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(firstQtyInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    expect(chipButton()).toBeNull();
    // Date input in the step is still present and editable
    expect(screen.getByLabelText("Effective date")).toBeEnabled();
  });

  it("lazily fetches once per position (cached across open)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    render(
      <StockPositionEditor open onClose={vi.fn()} asset={makeAsset(["b-1"])} brokers={BROKERS}
        existingSubcategories={[]} existingTags={[]} prices={PRICES_EUR} fxRates={{}} onTrade={vi.fn()} />,
    );
    fireEvent.change(firstQtyInput(), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    expect(hoisted.loadLastChangeDate).toHaveBeenCalledWith("pos-b-1");
  });
});
