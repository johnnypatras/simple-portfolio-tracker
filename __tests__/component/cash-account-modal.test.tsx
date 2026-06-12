import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CashAccountModal } from "@/components/cash/cash-account-modal";
import * as cashActions from "@/lib/actions/cash-accounts";
import * as instActions from "@/lib/actions/institutions";
import { INTENT_COPY } from "@/lib/cost-basis-copy";
import type { CashAccount, Institution } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────

vi.mock("@/lib/actions/cash-accounts", () => ({
  createCashAccount: vi.fn(),
  updateCashAccount: vi.fn(),
}));

vi.mock("@/lib/actions/institutions", () => ({
  findOrCreateInstitution: vi.fn(),
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

function makeInstitution(id: string, name: string): Institution {
  return {
    id,
    user_id: "u-1",
    name,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  };
}

const BANKS: Institution[] = [
  makeInstitution("inst-alpha", "Alpha Bank"),
  makeInstitution("inst-revolut", "Revolut"),
];

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

  it("effective date field is rendered", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    expect(screen.getByLabelText(/Effective date/)).toBeInTheDocument();
    expect(screen.getByText(/Leave empty to use today/)).toBeInTheDocument();
  });

  it("currency selector can be changed", () => {
    render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    const currencySelect = screen.getByLabelText("Currency") as HTMLSelectElement;
    expect(currencySelect.value).toBe("EUR");

    fireEvent.change(currencySelect, { target: { value: "USD" } });
    expect(currencySelect.value).toBe("USD");
  });
});

// ─── Form validation: balance + APY ────────────────────────────────────────
//
// Previously the modal coerced empty/non-numeric inputs to 0 via
// `parseFloat(x) || 0`, silently destroying the user's value on save.
// New behavior: block submit and surface a clear error message.

describe("CashAccountModal — input validation", () => {
  beforeEach(() => {
    vi.mocked(cashActions.createCashAccount).mockReset();
    vi.mocked(cashActions.updateCashAccount).mockReset();
  });

  it("blocks save on edit when balance is cleared (empty string → NaN)", async () => {
    const account = makeCashAccount({ balance: 1500, apy: 1.5 });

    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    const balanceInput = screen.getByLabelText("Balance") as HTMLInputElement;
    fireEvent.change(balanceInput, { target: { value: "" } });

    // fireEvent.submit on the form bypasses HTML5 button-triggered validation
    // and exercises the form's onSubmit handler directly — same path the real
    // submission takes, just without the browser's pre-submit field check.
    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Balance must be a valid number/);
    });
    expect(vi.mocked(cashActions.updateCashAccount)).not.toHaveBeenCalled();
  });

  it("blocks save on edit when APY is cleared (empty string → NaN)", async () => {
    const account = makeCashAccount({ balance: 1500, apy: 1.5 });

    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    const apyInput = screen.getByLabelText(/APY/) as HTMLInputElement;
    fireEvent.change(apyInput, { target: { value: "" } });

    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/APY must be a valid number/);
    });
    expect(vi.mocked(cashActions.updateCashAccount)).not.toHaveBeenCalled();
  });

  it("allows save on edit with explicit balance=0 — goes through the intent question", async () => {
    // C3: balance changes (1500 → 0) triggers the intent step; Yes is pre-selected,
    // so clicking Continue saves with isAdjustment: false.
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5 });

    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    const balanceInput = screen.getByLabelText("Balance") as HTMLInputElement;
    fireEvent.change(balanceInput, { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    // Intent step appears — Yes is pre-selected, Continue saves
    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled();
    });
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).toMatchObject({ balance: 0 });
  });

  it("allows save on edit with explicit apy=0 (zero is a valid number)", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5 });

    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    const apyInput = screen.getByLabelText(/APY/) as HTMLInputElement;
    fireEvent.change(apyInput, { target: { value: "0" } });

    // Balance unchanged → saves silently (no intent step)
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled();
    });
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).toMatchObject({ apy: 0 });
  });

  it("blocks save on create when balance is empty (no value typed)", async () => {
    const { container } = render(
      <CashAccountModal
        isOpen
        onClose={vi.fn()}
        institutionId="inst-1"
        institutionName="Revolut"
      />,
    );

    // Default state: balance string is "" (no pre-fill in create mode).
    // No need to fireEvent.change — just submit and verify the JS guard fires.
    const form = container.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Balance must be a valid number/);
    });
    expect(vi.mocked(cashActions.createCashAccount)).not.toHaveBeenCalled();
  });
});

// ─── Bank picker: prevent orphan "Unknown Bank" accounts + self-fix path ────
//
// Regression coverage for the prod bug where the toolbar "Add Cash" created a
// cash account with no institution (rendered "Unknown Bank", invisible in the
// Accounts tab). The picker appears whenever a bank-origin account has no parent
// bank — covering both a context-free add AND editing an existing orphan.

describe("CashAccountModal — bank picker (orphan fix)", () => {
  beforeEach(() => {
    vi.mocked(cashActions.createCashAccount).mockReset();
    vi.mocked(cashActions.updateCashAccount).mockReset();
    vi.mocked(instActions.findOrCreateInstitution).mockReset();
  });

  it("standalone 'Add Cash' (no institution context) shows the Bank picker", () => {
    render(<CashAccountModal isOpen onClose={vi.fn()} institutions={BANKS} />);
    expect(screen.getByLabelText("Bank")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Alpha Bank" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "+ New bank…" })).toBeInTheDocument();
  });

  it("does NOT show the picker when launched from a bank context (institutionId set)", () => {
    render(
      <CashAccountModal isOpen onClose={vi.fn()} institutionId="inst-alpha" institutionName="Alpha Bank" institutions={BANKS} />,
    );
    expect(screen.queryByLabelText("Bank")).not.toBeInTheDocument();
  });

  it("shows the picker when editing an existing orphan (institution_id = null)", () => {
    const orphan = makeCashAccount({ institution_id: null, institution_name: null, name: "test" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={orphan} institutions={BANKS} />);
    expect(screen.getByLabelText("Bank")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();
  });

  it("submitting with no bank selected is blocked (createCashAccount not called)", async () => {
    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} institutions={BANKS} />);
    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Savings" } });
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "0" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Select a bank/);
    });
    expect(vi.mocked(cashActions.createCashAccount)).not.toHaveBeenCalled();
  });

  it("selecting an existing bank passes its institution_id to createCashAccount", async () => {
    vi.mocked(cashActions.createCashAccount).mockResolvedValue("new-id");
    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} institutions={BANKS} />);
    fireEvent.change(screen.getByLabelText("Bank"), { target: { value: "inst-revolut" } });
    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Savings" } });
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "0" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(vi.mocked(cashActions.createCashAccount)).toHaveBeenCalled();
    });
    const [input] = vi.mocked(cashActions.createCashAccount).mock.calls[0];
    expect(input).toMatchObject({ institution_id: "inst-revolut" });
    expect(vi.mocked(instActions.findOrCreateInstitution)).not.toHaveBeenCalled();
  });

  it("'+ New bank' creates the institution first, then uses its id", async () => {
    vi.mocked(instActions.findOrCreateInstitution).mockResolvedValue("inst-new");
    vi.mocked(cashActions.createCashAccount).mockResolvedValue("new-id");
    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} institutions={BANKS} />);
    fireEvent.change(screen.getByLabelText("Bank"), { target: { value: "__new_bank__" } });
    fireEvent.change(screen.getByPlaceholderText(/New bank name/), { target: { value: "Snappi Bank" } });
    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Payments" } });
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "0" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(vi.mocked(instActions.findOrCreateInstitution)).toHaveBeenCalledWith("Snappi Bank");
    });
    await waitFor(() => {
      expect(vi.mocked(cashActions.createCashAccount)).toHaveBeenCalled();
    });
    const [input] = vi.mocked(cashActions.createCashAccount).mock.calls[0];
    expect(input).toMatchObject({ institution_id: "inst-new" });
  });

  it("fixing an orphan: picking a bank passes institution_id to updateCashAccount", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const orphan = makeCashAccount({ institution_id: null, institution_name: null, name: "test", balance: 1, apy: 0 });
    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={orphan} institutions={BANKS} />);
    fireEvent.change(screen.getByLabelText("Bank"), { target: { value: "inst-alpha" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled();
    });
    const [id, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(id).toBe("ca-1");
    expect(input).toMatchObject({ institution_id: "inst-alpha" });
    // Picked an EXISTING bank → must not create a new institution.
    expect(vi.mocked(instActions.findOrCreateInstitution)).not.toHaveBeenCalled();
  });

  // Regression guard for the new `!cashAccount?.institution_id` clause: a normal
  // account (institution already set) must NOT show the picker, even when the
  // modal is opened WITHOUT the (redundant) institutionId prop.
  it("normal edit (account already has a bank) does NOT show the picker", () => {
    const acct = makeCashAccount(); // institution_id: "inst-1"
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={acct} institutions={BANKS} />);
    expect(screen.queryByLabelText("Bank")).not.toBeInTheDocument();
  });

  it("normal edit save omits institution_id (partialUpdate leaves the bank intact)", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const acct = makeCashAccount({ balance: 1500, apy: 1.5 });
    const { container } = render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={acct} institutions={BANKS} />);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).not.toHaveProperty("institution_id");
  });

  // Dominant flow: adding cash from a bank's context (picker hidden) must pass
  // the contextual institutionId straight through, without findOrCreate.
  it("create from a bank context (institutionId set): no picker, passes it through", async () => {
    vi.mocked(cashActions.createCashAccount).mockResolvedValue("new-id");
    const { container } = render(
      <CashAccountModal isOpen onClose={vi.fn()} institutionId="inst-1" institutionName="Alpha Bank" institutions={BANKS} />,
    );
    expect(screen.queryByLabelText("Bank")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Savings" } });
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "0" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(vi.mocked(cashActions.createCashAccount)).toHaveBeenCalled());
    const [input] = vi.mocked(cashActions.createCashAccount).mock.calls[0];
    expect(input).toMatchObject({ institution_id: "inst-1" });
    expect(vi.mocked(instActions.findOrCreateInstitution)).not.toHaveBeenCalled();
  });
});

// ─── Currency: any-ISO on create + no-rewrite on edit ──────────────────────
//
// Regression coverage for the currency-audit CRITICAL: `CashAccount.currency`
// is free-ISO (imports and transfers create GBP/CHF accounts), but the modal
// hardcoded an EUR/USD <select> — opening a GBP account displayed EUR and
// saving REWROTE the real stored currency. Edit mode now shows the stored
// code read-only with a deliberate "Change" affordance, and the payload omits
// `currency` unless it was actually changed (updateCashAccount's partialUpdate
// then leaves the column untouched).

describe("CashAccountModal — currency (any-ISO + no-rewrite)", () => {
  beforeEach(() => {
    vi.mocked(cashActions.createCashAccount).mockReset();
    vi.mocked(cashActions.updateCashAccount).mockReset();
  });

  it("edit shows the REAL stored ISO (GBP) and a balance-only save goes through the intent step", async () => {
    // C3: balance changes (1500 → 2000) triggers the intent step; Yes is
    // pre-selected, so Continue saves. The currency key must still be absent.
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ currency: "GBP" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // The stored code is displayed (read-only) — not an EUR-defaulted select.
    expect(screen.getByText("GBP")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Account currency" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    // Intent step appears — Yes pre-selected → Continue saves
    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).toMatchObject({ balance: 2000 });
    // THE regression: an ordinary edit must never carry a currency key.
    expect(input).not.toHaveProperty("currency");
  });

  it("edit: Change → pick CHF via Other… → payload carries currency: 'CHF'", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ currency: "GBP" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // Accessible name is "Change currency" (aria-label contains the visible
    // "Change" — WCAG 2.5.3).
    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    const select = screen.getByRole("combobox", { name: "Account currency" });
    // Seeded from the account's real currency, not EUR.
    expect(select).toHaveValue("GBP");

    fireEvent.change(select, { target: { value: "__other__" } });
    const codeInput = screen.getByLabelText("Account currency code");
    fireEvent.change(codeInput, { target: { value: "CHF" } });
    fireEvent.blur(codeInput);

    // Balance is unchanged (pre-filled 1500 === cashAccount.balance 1500)
    // → saves silently without the intent step
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).toMatchObject({ currency: "CHF" });
  });

  it("edit: Change opened but code left untouched → currency still omitted", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ currency: "GBP" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    fireEvent.click(screen.getByRole("button", { name: "Change currency" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    const [, input] = vi.mocked(cashActions.updateCashAccount).mock.calls[0];
    expect(input).not.toHaveProperty("currency");
  });

  it("create: defaults to EUR and accepts any ISO via Other… (SEK)", async () => {
    vi.mocked(cashActions.createCashAccount).mockResolvedValue("new-id");
    const { container } = render(
      <CashAccountModal isOpen onClose={vi.fn()} institutionId="inst-1" institutionName="Revolut" />,
    );

    const select = screen.getByRole("combobox", { name: "Account currency" });
    expect(select).toHaveValue("EUR");

    fireEvent.change(select, { target: { value: "__other__" } });
    const codeInput = screen.getByLabelText("Account currency code");
    fireEvent.change(codeInput, { target: { value: "SEK" } });
    fireEvent.blur(codeInput);

    fireEvent.change(screen.getByLabelText("Account Name"), { target: { value: "Savings" } });
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "0" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(vi.mocked(cashActions.createCashAccount)).toHaveBeenCalled());
    const [input] = vi.mocked(cashActions.createCashAccount).mock.calls[0];
    expect(input).toMatchObject({ currency: "SEK" });
  });
});

// ─── C3 edit-mode intent question ──────────────────────────────────────────
//
// In edit mode, a balance change shows the "Does this reflect real money
// moving?" question before saving. The answer controls isAdjustment.
// APY-only / name-only changes save silently (no intent step).

describe("CashAccountModal — C3 edit-mode intent question", () => {
  beforeEach(() => {
    vi.mocked(cashActions.createCashAccount).mockReset();
    vi.mocked(cashActions.updateCashAccount).mockReset();
  });

  it("balance change → submit shows the cash question instead of saving", () => {
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // Change balance by +5 (1500 → 1505)
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "1505" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    expect(vi.mocked(cashActions.updateCashAccount)).not.toHaveBeenCalled();
  });

  it("'Money came in / went out' saves counted (isAdjustment false)", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // Δ +5: change balance, submit → intent step; Yes is pre-selected
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "1505" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });
    // Yes radio is pre-selected — click Continue
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    expect(vi.mocked(cashActions.updateCashAccount).mock.calls[0][2]).toMatchObject({
      isAdjustment: false,
    });
  });

  it("cosmetic below €10 saves off-book quietly (no guard)", async () => {
    // Δ +5 (EUR) → approxEur = 5 < 10 → no guard, saves immediately on Continue
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} fxRates={{}} />);

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "1505" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });

    // Select the cosmetic radio (second radio in the intent fieldset)
    const [, cosmeticRadio] = screen.getAllByRole("radio");
    fireEvent.click(cosmeticRadio);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    expect(vi.mocked(cashActions.updateCashAccount).mock.calls[0][2]).toMatchObject({
      isAdjustment: true,
    });
    // Guard must NOT have appeared
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cosmetic ≥ €10 arms the guard first, then saves on confirm", async () => {
    // Δ +500 (EUR) → approxEur = 500 ≥ 10 → guard fires
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} fxRates={{}} />);

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });

    // Select the cosmetic radio (second radio in the intent fieldset)
    const [, cosmeticRadio] = screen.getAllByRole("radio");
    fireEvent.click(cosmeticRadio);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Guard is now armed — save has NOT been called
    expect(screen.getByRole("alert")).toHaveTextContent(/Stop counting/);
    expect(vi.mocked(cashActions.updateCashAccount)).not.toHaveBeenCalled();

    // Confirming the guard saves as adjustment
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardProceed }));
    await waitFor(() =>
      expect(vi.mocked(cashActions.updateCashAccount).mock.calls[0][2]).toMatchObject({
        isAdjustment: true,
      }),
    );
  });

  it("'It's real value' returns to the Yes answer", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} fxRates={{}} />);

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });

    // Arm the guard — second radio is cosmetic
    const [, cosmeticRadio] = screen.getAllByRole("radio");
    fireEvent.click(cosmeticRadio);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // Click "← It's real value" → guard gone, Yes radio should be checked
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardReal }));

    expect(screen.queryByRole("alert")).toBeNull();
    // First radio is Yes — should now be checked
    const [yesRadio] = screen.getAllByRole("radio");
    expect(yesRadio).toBeChecked();
  });

  it("Back returns to the form with values intact", async () => {
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "1505" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    // Back to the form — Balance input retains the typed value
    const balanceInput = screen.getByLabelText("Balance") as HTMLInputElement;
    expect(balanceInput.value).toBe("1505");
  });

  it("APY-only edit saves silently (no question)", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // Change only APY; balance stays at pre-filled 1500
    fireEvent.change(screen.getByLabelText(/APY/), { target: { value: "2.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    expect(screen.queryByText(INTENT_COPY.questionCash)).toBeNull();
  });

  it("the effective date typed in the form is carried through the intent save", async () => {
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "EUR" });
    render(<CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />);

    // Set effective date in the form
    fireEvent.change(screen.getByLabelText(/Effective date/), {
      target: { value: "2026-01-15" },
    });
    // Change balance to trigger intent step
    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "1505" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });
    // Yes pre-selected → Continue
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(vi.mocked(cashActions.updateCashAccount)).toHaveBeenCalled());
    expect(vi.mocked(cashActions.updateCashAccount).mock.calls[0][2]).toMatchObject({
      effectiveDate: "2026-01-15",
    });
  });

  it("guard label names the EUR approximation, not the account symbol (spec §8.11)", async () => {
    // GBP account, fxRates { GBP: 0.85 } → 1 EUR = 0.85 GBP → £500 ≈ €588.24
    // The guard text must contain "€588.24" and must NOT contain "£".
    vi.mocked(cashActions.updateCashAccount).mockResolvedValue();
    const account = makeCashAccount({ balance: 1500, apy: 1.5, currency: "GBP" });
    render(
      <CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} fxRates={{ GBP: 0.85 }} />,
    );

    fireEvent.change(screen.getByLabelText("Balance"), { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText(INTENT_COPY.questionCash)).toBeInTheDocument();
    });

    const [, cosmeticRadio] = screen.getAllByRole("radio");
    fireEvent.click(cosmeticRadio);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toContain("€588.24");
    expect(alertText).not.toContain("£");
  });

  it("edit mode has no IsAdjustmentCheckbox; create mode still has it", () => {
    // Edit mode: no checkbox
    const account = makeCashAccount();
    const { unmount } = render(
      <CashAccountModal isOpen onClose={vi.fn()} cashAccount={account} />,
    );
    // IsAdjustmentCheckbox renders a label "Portfolio adjustment"
    expect(screen.queryByLabelText("Portfolio adjustment")).toBeNull();
    unmount();

    // Create mode: checkbox present
    render(
      <CashAccountModal isOpen onClose={vi.fn()} institutionId="inst-1" institutionName="Revolut" />,
    );
    expect(screen.getByLabelText("Portfolio adjustment")).toBeInTheDocument();
  });
});
