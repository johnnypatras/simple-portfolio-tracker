import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToolbarBuyManager } from "@/components/transactions/toolbar-buy-manager";
import type { PickedAsset } from "@/lib/types";
import type { TransactionSubmit } from "@/components/transactions/transaction-modal";

// ── Mocks ────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  addNewAsset: vi.fn(),
  execTransfer: vi.fn(),
}));
vi.mock("@/lib/actions/transactions", () => ({ addNewAssetTransaction: hoisted.addNewAsset }));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: hoisted.execTransfer }));
vi.mock("@/lib/actions/cash-accounts", () => ({ getCashAccounts: vi.fn(async () => []) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Mock the modal to a harness exposing pick + submit(route) buttons. Typed (no any).
vi.mock("@/components/transactions/transaction-modal", () => ({
  TransactionModal: ({
    pickerMode,
    onSubmit,
  }: {
    pickerMode: { onAssetPicked: (a: PickedAsset) => void };
    onSubmit: (s: TransactionSubmit) => void;
  }) => (
    <div>
      <button
        onClick={() =>
          pickerMode.onAssetPicked({
            assetClass: "crypto",
            ticker: "SOL",
            name: "Solana",
            raw: { id: "solana", name: "Solana", symbol: "sol", thumb: "", large: "", market_cap_rank: 5 },
          })
        }
      >
        pick
      </button>
      <button
        onClick={() =>
          onSubmit({
            type: "buy",
            quantity: 2,
            date: "",
            walletId: "w1",
            moneyFlow: { route: "external" },
            cashflowOverride: { amount: 200, currency: "EUR" },
          })
        }
      >
        submit-external
      </button>
      <button
        onClick={() =>
          onSubmit({
            type: "buy",
            quantity: 2,
            date: "",
            walletId: "w1",
            moneyFlow: { route: "tracked", accountId: "acc1" },
            cashflowOverride: { amount: 200, currency: "EUR" },
          })
        }
      >
        submit-tracked
      </button>
      <button
        onClick={() =>
          pickerMode.onAssetPicked({
            assetClass: "stock",
            ticker: "VUSA",
            name: "Vanguard S&P 500",
            raw: {
              symbol: "VUSA.AS",
              shortname: "Vanguard S&P 500",
              longname: "Vanguard S&P 500 UCITS ETF",
              quoteType: "ETF",
              exchDisp: "Amsterdam",
              exchange: "AMS",
              currency: "EUR",
            },
          })
        }
      >
        pick-stock
      </button>
      <button
        onClick={() =>
          onSubmit({
            type: "buy",
            quantity: 2,
            date: "",
            newLocationName: "Ledger",
            walletType: "non_custodial",
            moneyFlow: { route: "external" },
            cashflowOverride: { amount: 200, currency: "EUR" },
          })
        }
      >
        submit-external-newloc
      </button>
      <button
        onClick={() =>
          onSubmit({
            type: "buy",
            quantity: 5,
            date: "",
            brokerId: "b1",
            moneyFlow: { route: "external" },
            cashflowOverride: { amount: 1000, currency: "USD" },
          })
        }
      >
        submit-external-broker
      </button>
    </div>
  ),
}));

beforeEach(() => {
  hoisted.addNewAsset.mockReset().mockResolvedValue({ success: true });
  hoisted.execTransfer.mockReset().mockResolvedValue({ success: true });
});

function renderMgr(assetClass: "crypto" | "stock" = "crypto") {
  const onClose = vi.fn();
  const onMutated = vi.fn();
  render(
    <ToolbarBuyManager
      assetClass={assetClass}
      open
      onClose={onClose}
      wallets={assetClass === "crypto" ? [{ id: "w1", name: "W" }] : []}
      brokers={assetClass === "stock" ? [{ id: "b1", name: "DEGIRO" }] : []}
      ownedTickers={new Set()}
      onMutated={onMutated}
    />,
  );
  return { onClose, onMutated };
}

describe("ToolbarBuyManager routing", () => {
  it("external route → addNewAssetTransaction with newCryptoAsset + locationId", async () => {
    const { onMutated } = renderMgr();
    fireEvent.click(screen.getByText("pick"));
    fireEvent.click(screen.getByText("submit-external"));
    await waitFor(() => expect(hoisted.addNewAsset).toHaveBeenCalledTimes(1));
    const arg = hoisted.addNewAsset.mock.calls[0][0];
    expect(arg.assetClass).toBe("crypto");
    expect(arg.newCryptoAsset).toMatchObject({ coingecko_id: "solana", ticker: "SOL" });
    expect(arg.locationId).toBe("w1");
    expect(arg.quantity).toBe(2);
    expect(arg.cost).toEqual({ amount: 200, currency: "EUR" });
    expect(hoisted.execTransfer).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("tracked route → executeTransfer with PENDING asset + cash source + newCryptoAsset", async () => {
    renderMgr();
    fireEvent.click(screen.getByText("pick"));
    fireEvent.click(screen.getByText("submit-tracked"));
    await waitFor(() => expect(hoisted.execTransfer).toHaveBeenCalledTimes(1));
    const arg = hoisted.execTransfer.mock.calls[0][0];
    expect(arg.mode).toBe("buy");
    expect(arg.source).toEqual({ type: "cash_account", accountId: "acc1", amount: 200 });
    expect(arg.destination).toMatchObject({ type: "crypto_position", assetId: "PENDING", walletId: "w1", quantity: 2 });
    expect(arg.newCryptoAsset).toMatchObject({ coingecko_id: "solana" });
    expect(hoisted.addNewAsset).not.toHaveBeenCalled();
  });

  it("tracked route success calls onMutated", async () => {
    const { onMutated } = renderMgr();
    fireEvent.click(screen.getByText("pick"));
    fireEvent.click(screen.getByText("submit-tracked"));
    await waitFor(() => expect(hoisted.execTransfer).toHaveBeenCalledTimes(1));
    expect(onMutated).toHaveBeenCalled();
  });

  it("external + NEW location → newLocationName + walletType, no locationId", async () => {
    renderMgr();
    fireEvent.click(screen.getByText("pick"));
    fireEvent.click(screen.getByText("submit-external-newloc"));
    await waitFor(() => expect(hoisted.addNewAsset).toHaveBeenCalledTimes(1));
    const arg = hoisted.addNewAsset.mock.calls[0][0];
    expect(arg.newLocationName).toBe("Ledger");
    expect(arg.walletType).toBe("non_custodial");
    expect(arg.locationId).toBeUndefined();
  });

  it("STOCK external → newStockAsset (from Yahoo result) + brokerId, no custody", async () => {
    renderMgr("stock");
    fireEvent.click(screen.getByText("pick-stock"));
    fireEvent.click(screen.getByText("submit-external-broker"));
    await waitFor(() => expect(hoisted.addNewAsset).toHaveBeenCalledTimes(1));
    const arg = hoisted.addNewAsset.mock.calls[0][0];
    expect(arg.assetClass).toBe("stock");
    expect(arg.newStockAsset).toMatchObject({ yahoo_ticker: "VUSA.AS", ticker: "VUSA", category: "etf", currency: "EUR" });
    expect(arg.newCryptoAsset).toBeUndefined();
    expect(arg.locationId).toBe("b1");
    expect(arg.walletType).toBeUndefined(); // custody is crypto-only
    expect(arg.cost).toEqual({ amount: 1000, currency: "USD" });
  });
});
