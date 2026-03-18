import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CashAccountModal } from "@/components/cash/cash-account-modal";
import type { CashAccount } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

vi.mock("@/lib/actions/cash-accounts", () => ({
  createCashAccount: vi.fn(),
  updateCashAccount: vi.fn(),
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Helpers ──────────────────────────────────────────────

function makeCashAccount(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: "ca-1",
    user_id: "u-1",
    institution_id: "inst-1",
    name: "Savings",
    currency: "EUR",
    balance: 1500,
    apy: 1.5,
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
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("CashAccountModal", () => {
  it("bank-origin create mode: shows name field and 'Add Account' button", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    // Name field is visible
    expect(screen.getByLabelText("Account Name")).toBeInTheDocument();
    // Submit button says "Add Account"
    expect(screen.getByRole("button", { name: "Add Account" })).toBeInTheDocument();
  });

  it("deposit-origin create mode (walletId): hides name field and shows 'Add Deposit'", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        walletId="w-1"
        walletName="Binance"
      />,
    );

    // Name field should NOT be visible
    expect(screen.queryByLabelText("Account Name")).not.toBeInTheDocument();
    // Submit button says "Add Deposit"
    expect(screen.getByRole("button", { name: "Add Deposit" })).toBeInTheDocument();
  });

  it("deposit-origin create mode (brokerId): hides name field and shows 'Add Deposit'", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        brokerId="b-1"
        brokerName="DEGIRO"
      />,
    );

    expect(screen.queryByLabelText("Account Name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Deposit" })).toBeInTheDocument();
  });

  it("edit mode: pre-fills form values and shows 'Save Changes' button", () => {
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });

    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        cashAccount={account}
      />,
    );

    // Submit button says "Save Changes"
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();

    // Form pre-fills: balance input has the value
    const balanceInput = screen.getByLabelText("Balance") as HTMLInputElement;
    expect(balanceInput.value).toBe("1500");

    // APY pre-fills
    const apyInput = screen.getByLabelText(/APY/) as HTMLInputElement;
    expect(apyInput.value).toBe("1.5");
  });

  it("modal title: bank-origin shows 'Add Account — <institutionName>'", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    expect(screen.getByText("Add Account — Revolut")).toBeInTheDocument();
  });

  it("modal title: exchange-origin shows 'Add Deposit — <walletName>'", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        walletId="w-1"
        walletName="Binance"
      />,
    );

    expect(screen.getByText("Add Deposit — Binance")).toBeInTheDocument();
  });

  it("modal title: edit bank account shows 'Edit Bank Account'", () => {
    const account = makeCashAccount();

    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        cashAccount={account}
      />,
    );

    expect(screen.getByText("Edit Bank Account")).toBeInTheDocument();
  });

  it("modal title: edit exchange deposit shows 'Edit Exchange Deposit'", () => {
    const account = makeCashAccount({
      wallet_id: "w-1",
      wallet_name: "Binance",
    });

    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        cashAccount={account}
      />,
    );

    expect(screen.getByText("Edit Exchange Deposit")).toBeInTheDocument();
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <CashAccountModal
        isOpen={false}
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});
