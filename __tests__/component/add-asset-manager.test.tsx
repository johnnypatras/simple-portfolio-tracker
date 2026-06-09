import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AddAssetManager } from "@/components/transactions/add-asset-manager";
import type { PickedAsset } from "@/lib/types";
import type { AssetIdentityValue } from "@/components/transactions/asset-identity-step";
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

// Captures the last pickerMode the manager hands the modal, so tests can assert
// the computed needsIdentity / availableChains and drive the identity onChange.
interface CapturedPickerMode {
  picked: PickedAsset | null;
  onAssetPicked: (a: PickedAsset) => void;
  needsIdentity?: boolean;
  identityValue?: AssetIdentityValue;
  onIdentityChange?: (v: AssetIdentityValue) => void;
  availableChains?: string[];
  existingChains?: string[];
  existingSubcategories?: string[];
  existingTags?: string[];
  existingAssets?: { coingecko_id: string; chain: string | null }[];
  onNotListed?: () => void;
}
const captured = vi.hoisted(() => ({ pickerMode: null as CapturedPickerMode | null }));

// Mock the modal to a harness exposing pick + submit(route) buttons. Typed (no any).
// The harness records pickerMode on every render so tests can read the computed
// needsIdentity / availableChains and invoke onIdentityChange + onAddManualNav.
vi.mock("@/components/transactions/transaction-modal", () => ({
  TransactionModal: ({
    pickerMode,
    onSubmit,
  }: {
    pickerMode: CapturedPickerMode;
    onSubmit: (s: TransactionSubmit) => void;
  }) => {
    captured.pickerMode = pickerMode;
    return (
      <div>
        {/* Mirror the real modal's pre-pick step: the "Not listed?" escape is
            rendered (only) when the manager wires pickerMode.onNotListed. */}
        {pickerMode.onNotListed && (
          <button onClick={pickerMode.onNotListed}>
            Not listed? Add a manual-NAV / illiquid fund
          </button>
        )}
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
    );
  },
}));

beforeEach(() => {
  hoisted.addNewAsset.mockReset().mockResolvedValue({ success: true });
  hoisted.execTransfer.mockReset().mockResolvedValue({ success: true });
  captured.pickerMode = null;
  // Default fetch: a single-chain detail (overridden per-test as needed).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ chain: "Solana", subcategory: "L1", availableChains: ["Solana"] }),
    })),
  );
});

function renderMgr(
  assetClass: "crypto" | "stock" = "crypto",
  extra?: { onAddManualNav?: () => void },
) {
  const onClose = vi.fn();
  const onMutated = vi.fn();
  render(
    <AddAssetManager
      assetClass={assetClass}
      open
      onClose={onClose}
      wallets={assetClass === "crypto" ? [{ id: "w1", name: "W" }] : []}
      brokers={assetClass === "stock" ? [{ id: "b1", name: "DEGIRO" }] : []}
      ownedTickers={new Set()}
      onMutated={onMutated}
      onAddManualNav={extra?.onAddManualNav}
    />,
  );
  return { onClose, onMutated };
}

describe("AddAssetManager routing", () => {
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

  it("tracked route → executeTransfer carries authored apy + acquisitionMethod", async () => {
    // Author an identity with apy/method on a crypto pick, submit via tracked path,
    // and assert the TransferInput carries them through.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chain: "Ethereum", subcategory: "DeFi", availableChains: ["Ethereum", "Solana"] }),
      })),
    );
    renderMgr();
    fireEvent.click(screen.getByText("pick"));
    // Wait for the detail fetch to seed the identity value.
    await waitFor(() => expect(captured.pickerMode?.identityValue?.chain).toBe("Ethereum"));
    // Author apy + acquisitionMethod through the modal's onIdentityChange.
    act(() => {
      captured.pickerMode!.onIdentityChange!({
        chain: "Ethereum",
        subcategory: "DeFi",
        apy: 7.5,
        acquisitionMethod: "staked",
      });
    });
    await waitFor(() => expect(captured.pickerMode?.identityValue?.apy).toBe(7.5));
    fireEvent.click(screen.getByText("submit-tracked"));
    await waitFor(() => expect(hoisted.execTransfer).toHaveBeenCalledTimes(1));
    const arg = hoisted.execTransfer.mock.calls[0][0];
    expect(arg.apy).toBe(7.5);
    expect(arg.acquisitionMethod).toBe("staked");
    expect(hoisted.addNewAsset).not.toHaveBeenCalled();
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

describe("AddAssetManager identity step", () => {
  it("computes needsIdentity from the detail fetch: multi-chain → true, single-chain → false", async () => {
    // Case 1: multi-chain detail → needsIdentity true + availableChains passed through.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chain: "Ethereum", subcategory: "L1", availableChains: ["Ethereum", "Solana"] }),
      })),
    );
    const { onClose } = renderMgr();
    fireEvent.click(screen.getByText("pick"));
    await waitFor(() => expect(captured.pickerMode?.needsIdentity).toBe(true));
    expect(captured.pickerMode?.availableChains).toEqual(["Ethereum", "Solana"]);

    // Case 2: single-chain detail → needsIdentity false.
    onClose.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chain: "Solana", subcategory: "L1", availableChains: ["Solana"] }),
      })),
    );
    renderMgr();
    fireEvent.click(screen.getAllByText("pick")[1]);
    await waitFor(() => expect(captured.pickerMode?.availableChains).toEqual(["Solana"]));
    expect(captured.pickerMode?.needsIdentity).toBe(false);
  });

  it("threads the authored identity (chain/subcategory/apy/method) into addNewAssetTransaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chain: "Ethereum", subcategory: "DeFi", availableChains: ["Ethereum", "Solana"] }),
      })),
    );
    renderMgr();
    fireEvent.click(screen.getByText("pick"));
    // Wait for the detail fetch to seed the identity value.
    await waitFor(() => expect(captured.pickerMode?.identityValue?.chain).toBe("Ethereum"));
    // Author the identity through the modal's onIdentityChange (the edited values).
    // onIdentityChange is the manager's stable setIdentityValue setter; wait for
    // the re-render so the submit handler closes over the authored value.
    act(() => {
      captured.pickerMode!.onIdentityChange!({
        chain: "Solana",
        subcategory: "DeFi",
        apy: 5,
        acquisitionMethod: "staked",
      });
    });
    await waitFor(() => expect(captured.pickerMode?.identityValue?.chain).toBe("Solana"));
    fireEvent.click(screen.getByText("submit-external"));
    await waitFor(() => expect(hoisted.addNewAsset).toHaveBeenCalledTimes(1));
    const arg = hoisted.addNewAsset.mock.calls[0][0];
    expect(arg.newCryptoAsset.chain).toBe("Solana");
    expect(arg.newCryptoAsset.subcategory).toBe("DeFi");
    expect(arg.apy).toBe(5);
    expect(arg.acquisitionMethod).toBe("staked");
  });

  it("renders a 'Not listed?' escape that calls onAddManualNav (stock only)", () => {
    // The escape now lives INSIDE the modal's picker step (the manager wires it
    // via pickerMode.onNotListed → the modal renders it). Click → hands off.
    const onMn = vi.fn();
    renderMgr("stock", { onAddManualNav: onMn });
    fireEvent.click(screen.getByText(/not listed/i));
    expect(onMn).toHaveBeenCalledTimes(1);
  });

  it("crypto manager does NOT render the 'Not listed?' escape (no manual-NAV path)", () => {
    // Even with an onAddManualNav prop, crypto has no manual-NAV flow → the
    // manager leaves pickerMode.onNotListed undefined, so no link is rendered.
    renderMgr("crypto", { onAddManualNav: vi.fn() });
    expect(screen.queryByText(/not listed/i)).not.toBeInTheDocument();
    expect(captured.pickerMode?.onNotListed).toBeUndefined();
  });
});
