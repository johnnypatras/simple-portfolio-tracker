import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransferDialog } from "@/components/ui/transfer-dialog";
import type { InitialSide } from "@/components/ui/transfer-dialog";
import type {
  Wallet,
  Broker,
  CashAccount,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  TransferInput,
  TransferResult,
} from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────
//
// TransferDialog imports executeTransfer DIRECTLY from "@/lib/actions/transfers"
// (it does NOT take an onExecute prop), so the submit path is mocked at the
// action boundary. The five data-loader actions populate the FROM/TO pickers on
// open — without them the dialog stays stuck on its "Loading..." spinner, so
// each is mocked to resolve a small deterministic fixture.

const hoisted = vi.hoisted(() => ({
  executeTransfer: vi.fn(),
  getWallets: vi.fn(),
  getBrokers: vi.fn(),
  getCashAccounts: vi.fn(),
  getCryptoAssetsWithPositions: vi.fn(),
  getStockAssetsWithPositions: vi.fn(),
}));

vi.mock("@/lib/actions/transfers", () => ({
  executeTransfer: hoisted.executeTransfer,
}));
vi.mock("@/lib/actions/wallets", () => ({ getWallets: hoisted.getWallets }));
vi.mock("@/lib/actions/brokers", () => ({ getBrokers: hoisted.getBrokers }));
vi.mock("@/lib/actions/cash-accounts", () => ({
  getCashAccounts: hoisted.getCashAccounts,
}));
vi.mock("@/lib/actions/crypto", () => ({
  getCryptoAssetsWithPositions: hoisted.getCryptoAssetsWithPositions,
}));
vi.mock("@/lib/actions/stocks", () => ({
  getStockAssetsWithPositions: hoisted.getStockAssetsWithPositions,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// jsdom focus-trap hangs; replace with a transparent wrapper (mirrors the other
// modal component tests).
vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Fixtures ─────────────────────────────────────────────

const WALLETS: Wallet[] = [
  {
    id: "w-ledger",
    user_id: "u-1",
    name: "Ledger",
    wallet_type: "non_custodial",
    privacy_label: null,
    chain: null,
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
  {
    id: "w-binance",
    user_id: "u-1",
    name: "Binance",
    wallet_type: "custodial",
    privacy_label: null,
    chain: null,
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
];

const BROKERS: Broker[] = [
  {
    id: "b-degiro",
    user_id: "u-1",
    name: "DEGIRO",
    institution_id: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
];

const CASH_ACCOUNTS: CashAccount[] = [
  {
    id: "acc-eur",
    user_id: "u-1",
    institution_id: null,
    name: "Revolut",
    currency: "EUR",
    balance: 5000,
    apy: 0,
    region: null,
    wallet_id: null,
    broker_id: null,
    last_was_adjustment: false,
    last_was_transfer: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    institution_name: "Revolut",
    wallet_name: null,
    broker_name: null,
  },
];

const CRYPTO_ASSETS: CryptoAssetWithPositions[] = [
  {
    id: "ca-btc",
    user_id: "u-1",
    ticker: "BTC",
    name: "Bitcoin",
    coingecko_id: "bitcoin",
    chain: null,
    subcategory: null,
    image_url: null,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    positions: [
      {
        id: "pos-ledger",
        crypto_asset_id: "ca-btc",
        wallet_id: "w-ledger",
        quantity: 2,
        acquisition_method: "bought",
        apy: 0,
        network: null,
        last_was_adjustment: false,
        last_was_transfer: false,
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
        wallet_name: "Ledger",
        wallet_type: "non_custodial",
      },
    ],
  },
];

const STOCK_ASSETS: StockAssetWithPositions[] = [];

/** Prefilled FROM side for a BTC-on-Ledger crypto position (the shape the
 *  crypto-table builds when launching Sell/Move from a row). */
const BTC_ON_LEDGER: InitialSide = {
  type: "crypto_position",
  assetId: "ca-btc",
  assetName: "Bitcoin",
  assetTicker: "BTC",
  locationId: "w-ledger",
  locationName: "Ledger",
  currentQty: 2,
  currency: "USD",
  currentPrice: 60000,
  currentPriceUsd: 60000,
  currentPriceEur: 55000,
};

// ── Harness ──────────────────────────────────────────────

interface RenderOpts {
  mode: "sell" | "move";
  initialSource?: InitialSide;
  initialDestCashId?: string;
}

function renderDialog({ mode, initialSource, initialDestCashId }: RenderOpts) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const utils = render(
    <TransferDialog
      open
      onClose={onClose}
      onSuccess={onSuccess}
      mode={mode}
      initialSource={initialSource}
      initialDestCashId={initialDestCashId}
    />,
  );
  return { onClose, onSuccess, ...utils };
}

/** The dialog shows a "Loading..." spinner until the five data-loaders resolve.
 *  Resolve that first so the FROM/TO form is in the DOM before interacting. */
async function waitForForm() {
  await waitFor(() =>
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(),
  );
}

function executeButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /execute transfer/i,
  }) as HTMLButtonElement;
}

beforeEach(() => {
  hoisted.executeTransfer.mockReset();
  hoisted.executeTransfer.mockResolvedValue({
    success: true,
    transferGroupId: "grp-1",
  } satisfies TransferResult);
  hoisted.getWallets.mockReset().mockResolvedValue(WALLETS);
  hoisted.getBrokers.mockReset().mockResolvedValue(BROKERS);
  hoisted.getCashAccounts.mockReset().mockResolvedValue(CASH_ACCOUNTS);
  hoisted.getCryptoAssetsWithPositions
    .mockReset()
    .mockResolvedValue(CRYPTO_ASSETS);
  hoisted.getStockAssetsWithPositions
    .mockReset()
    .mockResolvedValue(STOCK_ASSETS);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── mode="sell" ──────────────────────────────────────────

describe("TransferDialog — sell mode rendering", () => {
  it("renders the prefilled FROM position, a destination section, and the Execute Transfer button (NOT a purchase label)", async () => {
    renderDialog({ mode: "sell", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    // Title reflects a Sell of the prefilled asset.
    expect(screen.getByText("Sell BTC")).toBeInTheDocument();
    // FROM shows the prefilled "TICKER on Location" label + quantity input.
    expect(screen.getByText("BTC on Ledger")).toBeInTheDocument();
    expect(screen.getByLabelText(/quantity/i)).toBeInTheDocument();
    // Available line surfaces the position size.
    expect(screen.getByText(/Available: 2 BTC/)).toBeInTheDocument();

    // TO/destination section: the Cash/Crypto/Stock type tabs + a location picker.
    expect(screen.getByRole("button", { name: "Cash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crypto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stock" })).toBeInTheDocument();
    expect(screen.getByLabelText(/location/i)).toBeInTheDocument();

    // The surviving submit label is "Execute Transfer" — the dead "Record
    // Purchase" buy label must be gone.
    expect(executeButton()).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /record purchase/i }),
    ).not.toBeInTheDocument();
  });
});

describe("TransferDialog — sell mode submit", () => {
  it("books a sell: executeTransfer gets {mode:'sell', source:crypto_position, destination:cash_account} with the entered qty/amount", async () => {
    const { onSuccess } = renderDialog({ mode: "sell", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    // FROM: sell 0.5 BTC out of the prefilled position.
    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "0.5" },
    });

    // TO: Cash tab is the default; pick the EUR cash account as destination.
    fireEvent.change(screen.getByLabelText(/location/i), {
      target: { value: "acc-eur" },
    });
    // Destination amount (proceeds) — type explicitly so the value is deterministic.
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "30000" },
    });

    fireEvent.click(executeButton());

    await waitFor(() =>
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1),
    );
    const input = hoisted.executeTransfer.mock.calls[0][0] as TransferInput;
    expect(input.mode).toBe("sell");
    // Source = the prefilled crypto position (walletId comes from locationId).
    expect(input.source).toEqual({
      type: "crypto_position",
      assetId: "ca-btc",
      walletId: "w-ledger",
      quantity: 0.5,
    });
    // Destination = the chosen cash account at the typed amount.
    expect(input.destination).toEqual({
      type: "cash_account",
      accountId: "acc-eur",
      amount: 30000,
    });
    // Success callback fired on the resolved {success:true} result.
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("pre-selects the cash destination from initialDestCashId (accounts-page sell)", async () => {
    renderDialog({
      mode: "sell",
      initialSource: BTC_ON_LEDGER,
      initialDestCashId: "acc-eur",
    });
    await waitForForm();

    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "1" },
    });
    // Location was pre-filled by initialDestCashId — only the amount remains.
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "12345" },
    });
    fireEvent.click(executeButton());

    await waitFor(() =>
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1),
    );
    const input = hoisted.executeTransfer.mock.calls[0][0] as TransferInput;
    expect(input.destination).toEqual({
      type: "cash_account",
      accountId: "acc-eur",
      amount: 12345,
    });
  });
});

// ── mode="move" ──────────────────────────────────────────

describe("TransferDialog — move mode rendering", () => {
  it("renders the prefilled FROM and a same-asset destination wallet picker (no Cash/Crypto/Stock tabs)", async () => {
    renderDialog({ mode: "move", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    expect(screen.getByText("Move BTC")).toBeInTheDocument();
    // FROM: prefilled position + quantity.
    expect(screen.getByText("BTC on Ledger")).toBeInTheDocument();
    expect(screen.getByLabelText(/quantity/i)).toBeInTheDocument();

    // TO: a "same asset, different location" note + a New Wallet picker.
    expect(
      screen.getByText(/same asset, different location/i),
    ).toBeInTheDocument();
    const destPicker = screen.getByLabelText(/new wallet/i) as HTMLSelectElement;
    expect(destPicker).toBeInTheDocument();
    // The source wallet is excluded; the OTHER wallet is offered as a target.
    const optionValues = Array.from(destPicker.options).map((o) => o.value);
    expect(optionValues).toContain("w-binance");
    expect(optionValues).not.toContain("w-ledger");

    // Move mode does NOT render the destination-type tabs.
    expect(
      screen.queryByRole("button", { name: "Cash" }),
    ).not.toBeInTheDocument();
    expect(executeButton()).toBeInTheDocument();
  });
});

describe("TransferDialog — move mode submit", () => {
  it("moves between locations: executeTransfer gets {mode:'move'} with same-asset source+destination wallets", async () => {
    renderDialog({ mode: "move", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    // Move 1 BTC from Ledger → Binance.
    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText(/new wallet/i), {
      target: { value: "w-binance" },
    });

    fireEvent.click(executeButton());

    await waitFor(() =>
      expect(hoisted.executeTransfer).toHaveBeenCalledTimes(1),
    );
    const input = hoisted.executeTransfer.mock.calls[0][0] as TransferInput;
    expect(input.mode).toBe("move");
    // Source: the prefilled wallet. Destination: the picked wallet — same asset,
    // same quantity.
    expect(input.source).toEqual({
      type: "crypto_position",
      assetId: "ca-btc",
      walletId: "w-ledger",
      quantity: 1,
    });
    expect(input.destination).toEqual({
      type: "crypto_position",
      assetId: "ca-btc",
      walletId: "w-binance",
      quantity: 1,
    });
  });
});

// ── Submit guard ─────────────────────────────────────────

describe("TransferDialog — submit guard", () => {
  it("sell: Execute Transfer is disabled until both a destination and a positive quantity/amount are set", async () => {
    renderDialog({ mode: "sell", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    // Nothing entered yet → disabled (no source qty, no destination).
    expect(executeButton()).toBeDisabled();

    // Quantity alone is not enough — destination still missing.
    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "0.5" },
    });
    expect(executeButton()).toBeDisabled();

    // Add destination + amount → now enabled.
    fireEvent.change(screen.getByLabelText(/location/i), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "30000" },
    });
    expect(executeButton()).not.toBeDisabled();

    // Zeroing the quantity disables it again (qty <= 0 → no source).
    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "0" },
    });
    expect(executeButton()).toBeDisabled();
  });

  it("move: Execute Transfer is disabled until a destination wallet and a positive quantity are set", async () => {
    renderDialog({ mode: "move", initialSource: BTC_ON_LEDGER });
    await waitForForm();

    expect(executeButton()).toBeDisabled();

    // Destination wallet without a quantity is still incomplete.
    fireEvent.change(screen.getByLabelText(/new wallet/i), {
      target: { value: "w-binance" },
    });
    expect(executeButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/quantity/i), {
      target: { value: "1" },
    });
    expect(executeButton()).not.toBeDisabled();
  });
});
