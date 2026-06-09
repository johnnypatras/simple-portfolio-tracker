/**
 * Component test: accounts page — institution-scoped AddAssetManager (Phase 1b-3)
 *
 * Asserts that after the Add-modal swap:
 *   1. Triggering "Add Crypto Asset" for institution-1 opens AddAssetManager in
 *      crypto mode and scopes wallets to institution-1 only (W1 present, W2 absent).
 *   2. Triggering "Add Stock Asset" for institution-1 opens AddAssetManager in
 *      stock mode and scopes brokers to institution-1 only (B1 present, B2 absent).
 */

const hoisted = vi.hoisted(() => ({
  refresh: vi.fn(),
  // Captures the last props AddAssetManager was rendered with
  lastManagerProps: null as {
    assetClass: string;
    open: boolean;
    wallets: { id: string; name: string }[];
    brokers: { id: string; name: string }[];
  } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/shared-view-context", () => ({
  useSharedView: () => ({ shareToken: null, isReadOnly: false }),
}));

// Capture AddAssetManager props — render a stub that exposes the search input
// so we can also verify the picker opens in the right asset class.
// Only capture when open=true so the stock manager's closed render doesn't
// overwrite the crypto manager's open capture (both are mounted simultaneously).
vi.mock("@/components/transactions/add-asset-manager", () => ({
  AddAssetManager: (props: {
    assetClass: string;
    open: boolean;
    wallets: { id: string; name: string }[];
    brokers: { id: string; name: string }[];
    onClose: () => void;
    onMutated: () => void;
  }) => {
    if (props.open) {
      hoisted.lastManagerProps = {
        assetClass: props.assetClass,
        open: props.open,
        wallets: props.wallets,
        brokers: props.brokers,
      };
    }
    if (!props.open) return null;
    return (
      <div data-testid={`add-asset-manager-${props.assetClass}`}>
        <input
          aria-label={props.assetClass === "crypto" ? "Search crypto" : "Search stocks or ETFs"}
        />
      </div>
    );
  },
}));

// Server actions used by the component tree
vi.mock("@/lib/actions/crypto", () => ({
  deleteCryptoAsset: vi.fn(),
}));
vi.mock("@/lib/actions/stocks", () => ({
  deleteStockAsset: vi.fn(),
}));
vi.mock("@/lib/actions/cash-accounts", () => ({
  deleteCashAccount: vi.fn(),
  mergeCashAccounts: vi.fn(),
}));
vi.mock("@/lib/actions/transactions", () => ({
  addNewAssetTransaction: vi.fn(),
  loadAssetTransactions: vi.fn(),
}));
vi.mock("@/lib/actions/transfers", () => ({ executeTransfer: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", ...rest }: { alt?: string } & Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...(rest as Record<string, never>)} />
  ),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountsView } from "@/components/accounts/accounts-view";
import type {
  InstitutionWithRoles,
  Wallet,
  Broker,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  CashAccount,
  CoinGeckoPriceData,
  YahooStockPriceData,
} from "@/lib/types";
import type { FXRates } from "@/lib/prices/fx";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_1: InstitutionWithRoles = {
  id: "inst-1",
  user_id: "u-1",
  name: "Binance",
  roles: ["wallet", "broker"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const INST_2: InstitutionWithRoles = {
  id: "inst-2",
  user_id: "u-1",
  name: "DEGIRO",
  roles: ["broker"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// W1 belongs to inst-1, W2 belongs to inst-2
const W1: Wallet = {
  id: "w-1",
  user_id: "u-1",
  name: "Binance Wallet",
  wallet_type: "custodial",
  privacy_label: null,
  chain: null,
  institution_id: "inst-1",
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
};

const W2: Wallet = {
  id: "w-2",
  user_id: "u-1",
  name: "DEGIRO Wallet",
  wallet_type: "custodial",
  privacy_label: null,
  chain: null,
  institution_id: "inst-2",
  created_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
};

// B1 belongs to inst-1, B2 belongs to inst-2
const B1: Broker = {
  id: "b-1",
  user_id: "u-1",
  name: "Binance Broker",
  institution_id: "inst-1",
  created_at: "2026-01-01T00:00:00Z",
};

const B2: Broker = {
  id: "b-2",
  user_id: "u-1",
  name: "DEGIRO Broker",
  institution_id: "inst-2",
  created_at: "2026-01-01T00:00:00Z",
};

const BASE_PROPS = {
  institutions: [INST_1, INST_2],
  cryptoAssets: [] as CryptoAssetWithPositions[],
  stockAssets: [] as StockAssetWithPositions[],
  wallets: [W1, W2],
  brokers: [B1, B2],
  cashAccounts: [] as CashAccount[],
  cryptoPrices: {} as CoinGeckoPriceData,
  stockPrices: {} as YahooStockPriceData,
  fxRates: { EUR: 1, USD: 1.1 } as FXRates,
  primaryCurrency: "EUR" as const,
};

// ── Helper: expand institution-1 and open its Add dropdown ───────────────────

function expandInstitution1AndOpenAdd() {
  // Click the institution-1 row to expand it (role="button", aria-label=institution.name)
  fireEvent.click(screen.getByRole("button", { name: "Binance" }));
  // Click the "Add" dropdown trigger (the AddAssetDropdown's compact toggle)
  // It uses aria-haspopup="menu", so match on exact name "Add" to distinguish from "Add Wallet"
  const addBtns = screen.getAllByRole("button", { name: /^add$/i });
  // The AddAssetDropdown trigger is the one with aria-haspopup
  const addBtn = addBtns.find((b) => b.getAttribute("aria-haspopup") === "menu") ?? addBtns[0];
  fireEvent.click(addBtn);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AccountsView — institution-scoped AddAssetManager (Phase 1b-3)", () => {
  beforeEach(() => {
    hoisted.lastManagerProps = null;
  });

  it("'Add Crypto Asset' for institution-1 opens crypto AddAssetManager scoped to inst-1 wallets only", () => {
    render(<AccountsView {...BASE_PROPS} />);

    expandInstitution1AndOpenAdd();

    // Click "Add Crypto Asset" (dropdown button)
    fireEvent.click(screen.getByRole("button", { name: /add crypto asset/i }));

    // The crypto AddAssetManager should be open and show a search input
    expect(screen.getByTestId("add-asset-manager-crypto")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search crypto/i })).toBeInTheDocument();

    // Wallets must be scoped to inst-1 only: W1 in, W2 out
    expect(hoisted.lastManagerProps).not.toBeNull();
    const walletIds = hoisted.lastManagerProps!.wallets.map((w) => w.id);
    expect(walletIds).toContain("w-1");
    expect(walletIds).not.toContain("w-2");
    expect(hoisted.lastManagerProps!.assetClass).toBe("crypto");
    expect(hoisted.lastManagerProps!.brokers).toHaveLength(0);
  });

  it("'Add Stock Asset' for institution-1 opens stock AddAssetManager scoped to inst-1 brokers only", () => {
    render(<AccountsView {...BASE_PROPS} />);

    expandInstitution1AndOpenAdd();

    // Click "Add Stock Asset" (dropdown button)
    fireEvent.click(screen.getByRole("button", { name: /add stock asset/i }));

    // The stock AddAssetManager should be open
    expect(screen.getByTestId("add-asset-manager-stock")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search stocks or etfs/i })).toBeInTheDocument();

    // Brokers must be scoped to inst-1 only: B1 in, B2 out
    expect(hoisted.lastManagerProps).not.toBeNull();
    const brokerIds = hoisted.lastManagerProps!.brokers.map((b) => b.id);
    expect(brokerIds).toContain("b-1");
    expect(brokerIds).not.toContain("b-2");
    expect(hoisted.lastManagerProps!.assetClass).toBe("stock");
    expect(hoisted.lastManagerProps!.wallets).toHaveLength(0);
  });
});
