import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PositionEditor } from "@/components/crypto/position-editor";
import { formatBackdateChipDate } from "@/lib/format";
import type { CryptoAssetWithPositions, Wallet } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  upsertPosition: vi.fn(),
  deletePosition: vi.fn(),
  updateCryptoAsset: vi.fn(),
  loadLastChangeDate: vi.fn(),
}));

vi.mock("@/lib/actions/crypto", () => ({
  upsertPosition: hoisted.upsertPosition,
  deletePosition: hoisted.deletePosition,
  updateCryptoAsset: hoisted.updateCryptoAsset,
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
  return {
    onClose,
    ...render(
      <PositionEditor
        open
        onClose={onClose}
        asset={asset}
        wallets={WALLETS}
        existingSubcategories={[]}
        existingChains={[]}
        prices={{ bitcoin: { usd: 60000, eur: 55000 } }}
      />,
    ),
  };
}

/** The per-row adjustment checkboxes (label "Adj."). One per position row. */
function adjCheckboxes(): HTMLInputElement[] {
  return screen
    .getAllByRole("checkbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

function chipButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /backdate the effective date/i });
}

function dateInput(): HTMLInputElement {
  // Exact label text — avoids matching the chip's aria-label, which also
  // contains the phrase "effective date".
  return screen.getByLabelText("Effective date (optional)") as HTMLInputElement;
}

beforeEach(() => {
  hoisted.upsertPosition.mockReset();
  hoisted.upsertPosition.mockResolvedValue(undefined);
  hoisted.deletePosition.mockReset();
  hoisted.updateCryptoAsset.mockReset();
  hoisted.loadLastChangeDate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Correction-date suggest chip ─────────────────────────

describe("crypto PositionEditor — correction-date chip", () => {
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

    // Check the second row too → ambiguous → chip disappears.
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
    // The date field still works — no dead end.
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

    fireEvent.click(adjCheckboxes()[0]); // ON → fetch
    await waitFor(() => expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1));
    fireEvent.click(adjCheckboxes()[0]); // OFF
    fireEvent.click(adjCheckboxes()[0]); // ON again → cached, no re-fetch

    await waitFor(() => expect(chipButton()).not.toBeNull());
    expect(hoisted.loadLastChangeDate).toHaveBeenCalledTimes(1);
    expect(hoisted.loadLastChangeDate).toHaveBeenCalledWith("pos-w-1");
  });
});

// ─── Date prominence toggles with checkbox state ──────────

describe("crypto PositionEditor — date prominence", () => {
  it("the date label is amber while a correction is checked and zinc otherwise", async () => {
    hoisted.loadLastChangeDate.mockResolvedValue(null);
    renderEditor();

    const label = screen.getByText(/effective date/i);
    expect(label.className).toContain("text-zinc-400");
    expect(label.className).not.toContain("text-amber-400");

    fireEvent.click(adjCheckboxes()[0]);
    expect(label.className).toContain("text-amber-400");

    fireEvent.click(adjCheckboxes()[0]);
    expect(label.className).toContain("text-zinc-400");
    expect(label.className).not.toContain("text-amber-400");
  });
});

// ─── Crypto "Amount paid (incl. fees)" cost spine ─────────

describe("crypto PositionEditor — amount paid (cost spine)", () => {
  /** Find the cost input for a given wallet row by its label. */
  function costInput(): HTMLInputElement {
    return screen.getAllByLabelText("Amount paid (incl. fees)")[0] as HTMLInputElement;
  }

  /** The Save button inside the FIRST position row. */
  function firstRowSave(): HTMLElement {
    return screen.getAllByRole("button", { name: "Save" })[0];
  }

  it("untouched → save payload contains NO cost", async () => {
    renderEditor();
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    const opts = hoisted.upsertPosition.mock.calls[0][1];
    expect(opts).not.toHaveProperty("cost");
  });

  it("typed amount → payload carries { amount, currency } (default EUR)", async () => {
    renderEditor();
    fireEvent.change(costInput(), { target: { value: "1234.56" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    const opts = hoisted.upsertPosition.mock.calls[0][1];
    expect(opts.cost).toEqual({ amount: 1234.56, currency: "EUR" });
  });

  it("typed amount honors the per-row currency select (USD)", async () => {
    renderEditor();
    const currencySelect = screen.getAllByLabelText("Amount paid currency")[0];
    fireEvent.change(currencySelect, { target: { value: "USD" } });
    fireEvent.change(costInput(), { target: { value: "999" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertPosition.mock.calls[0][1].cost).toEqual({ amount: 999, currency: "USD" });
  });

  it("dirty-then-blanked → no cost (market fallback)", async () => {
    renderEditor();
    fireEvent.change(costInput(), { target: { value: "500" } });
    fireEvent.change(costInput(), { target: { value: "" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertPosition.mock.calls[0][1]).not.toHaveProperty("cost");
  });

  it("non-numeric typed value → no cost emitted (provenance gate)", async () => {
    renderEditor();
    fireEvent.change(costInput(), { target: { value: "abc" } });
    fireEvent.click(firstRowSave());

    await waitFor(() => expect(hoisted.upsertPosition).toHaveBeenCalledTimes(1));
    expect(hoisted.upsertPosition.mock.calls[0][1]).not.toHaveProperty("cost");
  });
});
