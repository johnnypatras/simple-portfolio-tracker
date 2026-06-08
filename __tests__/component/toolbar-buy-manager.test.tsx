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
    </div>
  ),
}));

beforeEach(() => {
  hoisted.addNewAsset.mockReset().mockResolvedValue({ success: true });
  hoisted.execTransfer.mockReset().mockResolvedValue({ success: true });
});

function renderMgr() {
  const onClose = vi.fn();
  const onMutated = vi.fn();
  render(
    <ToolbarBuyManager
      assetClass="crypto"
      open
      onClose={onClose}
      wallets={[{ id: "w1", name: "W" }]}
      brokers={[]}
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
});
