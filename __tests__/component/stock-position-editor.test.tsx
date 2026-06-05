import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StockPositionEditor } from "@/components/stocks/stock-position-editor";
import { formatBackdateChipDate } from "@/lib/format";
import type { StockAssetWithPositions, Broker } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  upsertStockPosition: vi.fn(),
  deleteStockPosition: vi.fn(),
  updateStockAsset: vi.fn(),
  loadLastChangeDate: vi.fn(),
}));

vi.mock("@/lib/actions/stocks", () => ({
  upsertStockPosition: hoisted.upsertStockPosition,
  deleteStockPosition: hoisted.deleteStockPosition,
  updateStockAsset: hoisted.updateStockAsset,
}));

vi.mock("@/lib/actions/transactions", () => ({
  loadLastChangeDate: hoisted.loadLastChangeDate,
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
  return {
    onClose,
    ...render(
      <StockPositionEditor
        open
        onClose={onClose}
        asset={asset}
        brokers={BROKERS}
        existingSubcategories={[]}
        existingTags={[]}
        prices={{ "VUSA.AS": { price: 80, currency: "USD" } }}
      />,
    ),
  };
}

function adjCheckboxes(): HTMLInputElement[] {
  return screen
    .getAllByRole("checkbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

function chipButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /backdate the effective date/i });
}

function dateInput(): HTMLInputElement {
  return screen.getByLabelText("Effective date (optional)") as HTMLInputElement;
}

beforeEach(() => {
  hoisted.upsertStockPosition.mockReset();
  hoisted.upsertStockPosition.mockResolvedValue(undefined);
  hoisted.deleteStockPosition.mockReset();
  hoisted.updateStockAsset.mockReset();
  hoisted.loadLastChangeDate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Correction-date suggest chip ─────────────────────────

describe("stock StockPositionEditor — correction-date chip", () => {
  it("appears when exactly one adjustment checkbox is ON and the fetch resolves a date", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();
    expect(chipButton()).toBeNull();

    fireEvent.click(adjCheckboxes()[0]);

    await waitFor(() => expect(chipButton()).not.toBeNull());
    expect(chipButton()!).toHaveTextContent(formatBackdateChipDate("2026-03-02"));
  });

  it("is hidden when ZERO checkboxes are checked", () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();
    expect(chipButton()).toBeNull();
    expect(hoisted.loadLastChangeDate).not.toHaveBeenCalled();
  });

  it("is hidden when MULTIPLE checkboxes are checked (ambiguous)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(chipButton()).not.toBeNull());

    fireEvent.click(adjCheckboxes()[1]);
    expect(chipButton()).toBeNull();
  });

  it("is hidden when the fetch resolves null (no history)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    expect(chipButton()).toBeNull();
  });

  it("is hidden when the fetch rejects (failure → no dead end)", async () => {
    hoisted.loadLastChangeDate.mockRejectedValue(new Error("boom"));
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    expect(chipButton()).toBeNull();
    expect(dateInput()).toBeEnabled();
  });

  it("click fills the effective-date input with the fetched date", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(chipButton()).not.toBeNull());
    expect(dateInput().value).toBe("");

    fireEvent.click(chipButton()!);
    expect(dateInput().value).toBe("2026-03-02");
  });

  it("the chip label contains the formatted date", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(chipButton()).not.toBeNull());
    expect(chipButton()!).toHaveTextContent(
      `Backdate to last change (${formatBackdateChipDate("2026-03-02")})?`,
    );
  });

  it("lazily fetches once per position (cached across toggles)", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue("2026-03-02");
    renderEditor();

    fireEvent.click(adjCheckboxes()[0]);
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    fireEvent.click(adjCheckboxes()[0]);
    fireEvent.click(adjCheckboxes()[0]);

    await waitFor(() => expect(chipButton()).not.toBeNull());
    expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1);
    expect(hoisted.loadLastChangeDate).toHaveBeenCalledWith("pos-b-1");
  });
});

// ─── Date prominence toggles with checkbox state ──────────

describe("stock StockPositionEditor — date prominence", () => {
  it("the date label is amber while a correction is checked and zinc otherwise", () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    renderEditor();

    const label = screen.getByText("Effective date (optional)");
    expect(label.className).toContain("text-zinc-400");
    expect(label.className).not.toContain("text-amber-400");

    fireEvent.click(adjCheckboxes()[0]);
    expect(label.className).toContain("text-amber-400");

    fireEvent.click(adjCheckboxes()[0]);
    expect(label.className).toContain("text-zinc-400");
    expect(label.className).not.toContain("text-amber-400");
  });
});

// ─── Amount paid (cost spine) — parity sanity ─────────────
// The stock editor already shipped this field; these guard the provenance gate
// that the crypto editor mirrors, so a regression in either is caught.

describe("stock StockPositionEditor — amount paid (cost spine)", () => {
  function costInput(): HTMLInputElement {
    return screen.getAllByLabelText("Amount paid (incl. fees)")[0] as HTMLInputElement;
  }
  function firstRowSave(): HTMLElement {
    return screen.getAllByRole("button", { name: "Save" })[0];
  }

  it("untouched → save payload contains NO cost", async () => {
    renderEditor();
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertStockPosition.mock.calls[0][1]).not.toHaveProperty("cost");
  });

  it("typed amount → payload carries { amount, currency }", async () => {
    renderEditor();
    fireEvent.change(costInput(), { target: { value: "1234.56" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertStockPosition.mock.calls[0][1].cost).toEqual({ amount: 1234.56, currency: "EUR" });
  });

  it("dirty-then-blanked → no cost (market fallback)", async () => {
    renderEditor();
    fireEvent.change(costInput(), { target: { value: "500" } });
    fireEvent.change(costInput(), { target: { value: "" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertStockPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertStockPosition.mock.calls[0][1]).not.toHaveProperty("cost");
  });
});
