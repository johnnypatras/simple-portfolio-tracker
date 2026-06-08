import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionModal } from "@/components/transactions/transaction-modal";
import { TYPE_GUIDANCE, COST_COPY, MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";
import type {
  TransactionModalProps,
  TransactionEditState,
  CashAccountOption,
} from "@/components/transactions/transaction-modal";

// Shared cash-account fixtures for the money-flow (C2a) tests.
const EUR_ACCOUNTS: CashAccountOption[] = [
  { id: "acc-eur", name: "Revolut EUR", balance: 5000, currency: "EUR" },
];
const USD_ACCOUNTS: CashAccountOption[] = [
  { id: "acc-usd", name: "IBKR Cash", balance: 3000, currency: "USD" },
];
const GBP_ACCOUNTS: CashAccountOption[] = [
  { id: "acc-gbp", name: "Wise GBP", balance: 1000, currency: "GBP" },
];

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// ── Helpers ──────────────────────────────────────────────

function renderOpen(overrides: Partial<TransactionModalProps> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const props: TransactionModalProps = {
    isOpen: true,
    onClose,
    assetClass: "crypto",
    onSubmit,
    ...overrides,
  };
  return { ...render(<TransactionModal {...props} />), onSubmit, onClose, props };
}

// ── Test Group 0: initialType prop ────────────────────────────────────────────

describe("TransactionModal — initialType prop", () => {
  it("honors initialType as the add-mode default type", () => {
    renderOpen({ assetClass: "crypto", initialType: "sell" });
    // The type <select> should show "Sell" selected by default (add-mode, no edit).
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect.value).toBe("sell");
  });
});

// ── Test Group 1: Type options by asset class ─────────────────────────────────

describe("TransactionModal — type options by asset class", () => {
  it("crypto: shows Buy / Sell / Yield / Transfer options", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    const options = Array.from(typeSelect.options).map((o) => o.value);
    expect(options).toEqual(["buy", "sell", "yield", "transfer"]);
  });

  it("stock: shows Buy / Sell / Yield / Transfer options", () => {
    renderOpen({ assetClass: "stock" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    const options = Array.from(typeSelect.options).map((o) => o.value);
    expect(options).toEqual(["buy", "sell", "yield", "transfer"]);
  });

  it("cash: shows Deposit / Withdrawal / Yield / Transfer options", () => {
    renderOpen({ assetClass: "cash" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    const options = Array.from(typeSelect.options).map((o) => o.value);
    expect(options).toEqual(["deposit", "withdrawal", "yield", "transfer"]);
  });
});

// ── Test Group 2: Per-type guidance copy renders ─────────────────────────────

describe("TransactionModal — per-type guidance copy", () => {
  it("buy type shows TYPE_GUIDANCE.buy text", () => {
    renderOpen({ assetClass: "crypto" });
    // buy is the default for crypto
    expect(screen.getByText(TYPE_GUIDANCE.buy)).toBeInTheDocument();
  });

  it("sell type shows TYPE_GUIDANCE.sell text", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "sell" } });
    expect(screen.getByText(TYPE_GUIDANCE.sell)).toBeInTheDocument();
  });

  it("yield type shows TYPE_GUIDANCE.yield text", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "yield" } });
    expect(screen.getByText(TYPE_GUIDANCE.yield)).toBeInTheDocument();
  });

  it("transfer type shows TYPE_GUIDANCE.transfer text", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "transfer" } });
    expect(screen.getByText(TYPE_GUIDANCE.transfer)).toBeInTheDocument();
  });

  it("deposit type shows TYPE_GUIDANCE.deposit text", () => {
    renderOpen({ assetClass: "cash" });
    // deposit is the default for cash
    expect(screen.getByText(TYPE_GUIDANCE.deposit)).toBeInTheDocument();
  });

  it("withdrawal type shows TYPE_GUIDANCE.withdrawal text", () => {
    renderOpen({ assetClass: "cash" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "withdrawal" } });
    expect(screen.getByText(TYPE_GUIDANCE.withdrawal)).toBeInTheDocument();
  });
});

// ── Test Group 3: Field visibility per type ───────────────────────────────────

describe("TransactionModal — field visibility per type", () => {
  it("buy type shows Quantity, Amount, and Date fields", () => {
    renderOpen({ assetClass: "crypto" });
    expect(screen.getByLabelText(/quantity/i)).toBeInTheDocument();
    // Use exact label text to avoid matching "Amount currency" select
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
  });

  it("sell type shows Quantity, Amount, and Date fields", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "sell" } });
    expect(screen.getByLabelText(/quantity/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
    expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
  });

  it("yield type HIDES the Amount field entirely", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "yield" } });
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    // Quantity and Date still visible
    expect(screen.getByLabelText(/quantity/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/date/i)).toBeInTheDocument();
  });

  it("transfer type replaces qty/amount fields with 'Continue in Transfer' button", () => {
    const onContinueToTransfer = vi.fn();
    renderOpen({ assetClass: "crypto", onContinueToTransfer });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "transfer" } });
    expect(screen.queryByLabelText(/quantity/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    const continueBtn = screen.getByRole("button", { name: /continue in transfer/i });
    expect(continueBtn).toBeInTheDocument();
  });

  it("clicking 'Continue in Transfer' button calls onContinueToTransfer", () => {
    const onContinueToTransfer = vi.fn();
    renderOpen({ assetClass: "crypto", onContinueToTransfer });
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "transfer" } });
    fireEvent.click(screen.getByRole("button", { name: /continue in transfer/i }));
    expect(onContinueToTransfer).toHaveBeenCalledOnce();
  });
});

// ── Test Group 4: UI lockdown states — each must show a visible reason ────────

describe("TransactionModal — lockdown: NaN/empty quantity blocks save with visible alert", () => {
  it("fresh modal: NO eager alert, but Save is already disabled (display gated, blocking not)", () => {
    renderOpen({ assetClass: "crypto" });
    // Quantity is empty by default — the error must NOT render before the user
    // visits the field (touched-gating), but Save stays disabled regardless.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("empty quantity after blur: alert appears and Save stays disabled", () => {
    renderOpen({ assetClass: "crypto" });
    const qtyInput = screen.getByLabelText(/quantity/i);
    fireEvent.blur(qtyInput);
    expect(screen.getByRole("alert")).toHaveTextContent("Quantity must be a valid number");
    expect(qtyInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("NaN quantity after typing + blur: alert persists and Save stays disabled", () => {
    renderOpen({ assetClass: "crypto" });
    const qtyInput = screen.getByLabelText(/quantity/i);
    fireEvent.change(qtyInput, { target: { value: "abc" } });
    fireEvent.blur(qtyInput);
    expect(screen.getByRole("alert")).toHaveTextContent("Quantity must be a valid number");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("fixing the quantity after blur clears the alert live", () => {
    renderOpen({ assetClass: "crypto" });
    const qtyInput = screen.getByLabelText(/quantity/i);
    fireEvent.blur(qtyInput);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(qtyInput, { target: { value: "2" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(qtyInput).toHaveAttribute("aria-invalid", "false");
  });
});

describe("TransactionModal — lockdown: typed non-numeric amount blocks save with visible alert", () => {
  it("NaN amount (but non-empty): shows alert and Save is disabled", () => {
    renderOpen({ assetClass: "crypto" });
    // First fill in a valid quantity
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Then type a non-numeric amount (use exact label to avoid "Amount currency")
    // and blur it — error text renders only for touched fields.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "abc" } });
    fireEvent.blur(screen.getByLabelText("Amount"));
    expect(screen.getByRole("alert")).toHaveTextContent("Amount must be a valid number");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("blank amount (empty string) is allowed — shows amountOptionalHint", () => {
    renderOpen({ assetClass: "crypto" });
    // Fill in valid quantity so save isn't blocked by that
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Amount left blank — no validation error, shows the optional hint
    // (quantity error is gone now that we filled it; no amount error for blank)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(COST_COPY.amountOptionalHint)).toBeInTheDocument();
  });
});

describe("TransactionModal — lockdown: future date blocked with visible alert", () => {
  it("future date shows 'cannot be in the future' alert and disables Save", () => {
    renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    const dateInput = screen.getByLabelText(/date/i);
    fireEvent.change(dateInput, { target: { value: "2099-12-31" } });
    fireEvent.blur(dateInput);
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be in the future/i);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});

describe("TransactionModal — lockdown: transfer-leg lock in edit mode", () => {
  it("isTransferLeg: type and amount are read-only, shows transferLegLocked reason", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 0.5,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
      isTransferLeg: true,
    };
    renderOpen({ assetClass: "crypto", edit });
    expect(screen.getByText(COST_COPY.transferLegLocked)).toBeInTheDocument();
    // Type selector should be read-only/disabled
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect).toBeDisabled();
  });

  it("isTransferLeg: quantity, amount, and date inputs are all disabled", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 0.5,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
      isTransferLeg: true,
    };
    renderOpen({ assetClass: "crypto", edit });
    // Quantity input disabled
    const qtyInput = screen.getByLabelText(/quantity/i);
    expect(qtyInput).toBeDisabled();
    // Amount input disabled — use exact label to avoid "Amount currency" select
    const amountInput = screen.getByLabelText("Amount");
    expect(amountInput).toBeDisabled();
    // Date input disabled
    const dateInput = screen.getByLabelText(/date/i);
    expect(dateInput).toBeDisabled();
  });

  it("isTransferLeg: renders 'Continue in Transfer' route-out button", () => {
    const onContinueToTransfer = vi.fn();
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 0.5,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
      isTransferLeg: true,
    };
    renderOpen({ assetClass: "crypto", edit, onContinueToTransfer });
    const continueBtn = screen.getByRole("button", { name: /continue in transfer/i });
    expect(continueBtn).toBeInTheDocument();
    fireEvent.click(continueBtn);
    expect(onContinueToTransfer).toHaveBeenCalledOnce();
  });
});

describe("TransactionModal — lockdown: split-child / undone entry blocks editing", () => {
  it("isSplitChild: shows splitChildLocked reason and Unsplit affordance", () => {
    const onUnsplit = vi.fn();
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 2,
      amount: 500,
      amountCurrency: "EUR",
      date: "2026-02-01",
      isSplitChild: true,
    };
    renderOpen({ assetClass: "crypto", edit, onUnsplit });
    expect(screen.getByText(COST_COPY.splitChildLocked)).toBeInTheDocument();
    const unsplitBtn = screen.getByRole("button", { name: /unsplit/i });
    expect(unsplitBtn).toBeInTheDocument();
    fireEvent.click(unsplitBtn);
    expect(onUnsplit).toHaveBeenCalledOnce();
  });

  it("isUndone: also shows splitChildLocked reason", () => {
    const edit: TransactionEditState = {
      type: "sell",
      quantity: 1,
      date: "2026-03-01",
      isUndone: true,
    };
    renderOpen({ assetClass: "crypto", edit });
    expect(screen.getByText(COST_COPY.splitChildLocked)).toBeInTheDocument();
  });
});

// ── Test Group 5: Amount hint — blank vs typed ────────────────────────────────

describe("TransactionModal — amount hints", () => {
  it("blank amount shows COST_COPY.amountOptionalHint", () => {
    renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    expect(screen.getByText(COST_COPY.amountOptionalHint)).toBeInTheDocument();
    expect(screen.queryByText(COST_COPY.amountUserSetHint)).not.toBeInTheDocument();
  });

  it("typed amount shows COST_COPY.amountUserSetHint", () => {
    renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Use exact label to avoid "Amount currency" select
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    expect(screen.getByText(COST_COPY.amountUserSetHint)).toBeInTheDocument();
    expect(screen.queryByText(COST_COPY.amountOptionalHint)).not.toBeInTheDocument();
  });

  it("typed then cleared amount shows COST_COPY.amountOptionalHint (not suppressed by amountDirty)", () => {
    renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    const amountInput = screen.getByLabelText("Amount");
    // Type a value first (sets amountDirty=true)
    fireEvent.change(amountInput, { target: { value: "5" } });
    // Clear it — now blank AND dirty: optional hint should still show
    fireEvent.change(amountInput, { target: { value: "" } });
    expect(screen.getByText(COST_COPY.amountOptionalHint)).toBeInTheDocument();
    expect(screen.queryByText(COST_COPY.amountUserSetHint)).not.toBeInTheDocument();
  });
});

// ── Test Group 6: No-op-save provenance guard (CRITICAL) ─────────────────────

describe("TransactionModal — no-op-save provenance guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("add mode: submitting without touching amount → cashflowOverride absent (provenance gate)", () => {
    const { onSubmit, container } = renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Amount untouched (blank) — provenance gate: no cashflowOverride
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    // cashflowOverride PRESENCE is the provenance signal (the redundant
    // amountUserSet boolean was removed).
    expect(payload.cashflowOverride).toBeUndefined();
  });

  it("add mode: typing an amount → cashflowOverride present (provenance gate)", () => {
    const { onSubmit, container } = renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Use exact label to avoid "Amount currency" select
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.cashflowOverride).toMatchObject({ amount: 500 });
  });

  it("edit mode: prefilled amount untouched → cashflowOverride absent (provenance gate)", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      amount: 1000,        // prefilled — user didn't touch it
      amountCurrency: "EUR",
      date: "2026-01-15",
    };
    const { onSubmit, container } = renderOpen({ assetClass: "crypto", edit });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.cashflowOverride).toBeUndefined();
  });

  it("edit mode: user edits the prefilled amount → cashflowOverride present (provenance gate)", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
    };
    const { onSubmit, container } = renderOpen({ assetClass: "crypto", edit });
    // User changes the amount — this marks it dirty (use exact label)
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1100" } });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.cashflowOverride).toMatchObject({ amount: 1100 });
  });
});

// ── Test Group 7: Modal title + misc ─────────────────────────────────────────

describe("TransactionModal — title and general rendering", () => {
  it("shows asset name in title when assetName is provided", () => {
    renderOpen({ assetClass: "crypto", assetName: "BTC" });
    expect(screen.getByText(/Add transaction — BTC/i)).toBeInTheDocument();
  });

  it("shows generic title when no assetName provided", () => {
    renderOpen({ assetClass: "crypto" });
    expect(screen.getByText(/Add transaction/i)).toBeInTheDocument();
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = renderOpen({ isOpen: false });
    expect(container.innerHTML).toBe("");
  });

  it("edit mode: title uses 'Edit transaction'", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      date: "2026-01-15",
    };
    renderOpen({ assetClass: "crypto", edit, assetName: "ETH" });
    expect(screen.getByText(/Edit transaction — ETH/i)).toBeInTheDocument();
  });

  it("edit mode: pre-fills quantity from edit.quantity", () => {
    const edit: TransactionEditState = {
      type: "sell",
      quantity: 2.5,
      date: "2026-03-01",
    };
    renderOpen({ assetClass: "crypto", edit });
    const qtyInput = screen.getByLabelText(/quantity/i) as HTMLInputElement;
    expect(qtyInput.value).toBe("2.5");
  });
});

// ── Test Group 8: isManualNav — NAV semantics ─────────────────────────────────

describe("TransactionModal — isManualNav asset", () => {
  it("isManualNav: quantity label/help reflects NAV/subscription semantics", () => {
    renderOpen({ assetClass: "stock", isManualNav: true });
    // The quantity label should mention NAV/shares or subscription
    expect(screen.getByLabelText(/shares|units|quantity/i)).toBeInTheDocument();
  });

  it("isManualNav: no per-unit price fields rendered (amount = subscription amount)", () => {
    renderOpen({ assetClass: "stock", isManualNav: true });
    // With ManualNav, the amount field represents subscription amount
    // There should be a quantity field but no separate per-unit-price field
    // (the whole amount IS the subscription amount — no price-per-unit)
    expect(screen.queryByLabelText(/price per unit|per unit price/i)).not.toBeInTheDocument();
  });
});

// ── Test Group 9b: Type select disabled in edit mode ─────────────────────────

describe("TransactionModal — type select disabled in edit mode", () => {
  it("edit mode (plain buy): the type select is disabled (editTransaction can't change type)", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
    };
    renderOpen({ assetClass: "crypto", edit });
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect).toBeDisabled();
  });

  it("add mode: the type select is enabled", () => {
    renderOpen({ assetClass: "crypto" });
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect).not.toBeDisabled();
  });
});

// ── Test Group 9c: Wallet / broker selector (add-mode) ───────────────────────

describe("TransactionModal — wallet / broker destination selector", () => {
  it("add-mode crypto with 2 walletOptions renders a Wallet select", () => {
    renderOpen({
      assetClass: "crypto",
      walletOptions: [
        { id: "w1", name: "Ledger" },
        { id: "w2", name: "Binance" },
      ],
    });
    const walletSelect = screen.getByRole("combobox", { name: /wallet/i }) as HTMLSelectElement;
    expect(walletSelect).toBeInTheDocument();
    const options = Array.from(walletSelect.options).map((o) => o.value);
    expect(options).toEqual(["w1", "w2"]);
    // Defaults to the first option.
    expect(walletSelect.value).toBe("w1");
  });

  it("add-mode crypto: submit payload carries the chosen walletId", () => {
    const { onSubmit } = renderOpen({
      assetClass: "crypto",
      walletOptions: [
        { id: "w1", name: "Ledger" },
        { id: "w2", name: "Binance" },
      ],
    });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Pick the second wallet.
    fireEvent.change(screen.getByRole("combobox", { name: /wallet/i }), {
      target: { value: "w2" },
    });
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0].walletId).toBe("w2");
  });

  it("edit mode does NOT render the wallet selector", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
    };
    renderOpen({
      assetClass: "crypto",
      edit,
      walletOptions: [{ id: "w1", name: "Ledger" }],
    });
    expect(screen.queryByRole("combobox", { name: /wallet/i })).not.toBeInTheDocument();
  });

  it("add-mode stock with brokerOptions renders a Broker select and emits brokerId", () => {
    const { onSubmit } = renderOpen({
      assetClass: "stock",
      brokerOptions: [
        { id: "b1", name: "DEGIRO" },
        { id: "b2", name: "IBKR" },
      ],
    });
    const brokerSelect = screen.getByRole("combobox", { name: /broker/i }) as HTMLSelectElement;
    expect(brokerSelect).toBeInTheDocument();
    expect(brokerSelect.value).toBe("b1");
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "5" } });
    fireEvent.change(brokerSelect, { target: { value: "b2" } });
    const form = document.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0].brokerId).toBe("b2");
  });

  it("transfer type hides the wallet selector (transfer routes out, no destination here)", () => {
    renderOpen({
      assetClass: "crypto",
      walletOptions: [{ id: "w1", name: "Ledger" }],
      onContinueToTransfer: vi.fn(),
    });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "transfer" },
    });
    expect(screen.queryByRole("combobox", { name: /wallet/i })).not.toBeInTheDocument();
  });
});

// ── Test Group 9: Double-submit guard (isSubmitting) ──────────────────────────

describe("TransactionModal — double-submit guard", () => {
  it("in-flight submit disables Save button and prevents a second submission", async () => {
    // Use a manually-controlled promise (never resolves) to simulate in-flight state.
    // Avoids fake timers (project has a fake-timer gotcha with userEvent).
    let resolveSubmit!: () => void;
    const inflightPromise = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const onSubmit = vi.fn(() => inflightPromise);

    const { container } = render(
      <TransactionModal
        isOpen={true}
        onClose={vi.fn()}
        assetClass="crypto"
        onSubmit={onSubmit}
      />,
    );

    // Fill in a valid quantity so the form is submittable
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });

    const form = container.querySelector("form")!;
    const saveBtn = screen.getByRole("button", { name: /save/i });

    // First submit — kicks off the in-flight promise
    fireEvent.submit(form);

    // Button should become disabled while the promise is pending
    expect(saveBtn).toBeDisabled();

    // Attempt a second submit — should be ignored
    fireEvent.submit(form);

    // onSubmit must have been called exactly once despite two submit attempts
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Resolve to clean up (prevents unhandled promise warnings)
    resolveSubmit();
  });
});

// ── Test Group 10: Money-flow question (C2a) — visibility ─────────────────────

describe("TransactionModal — money-flow question visibility", () => {
  it("crypto BUY (add-mode) shows the 'Paid with?' question", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    expect(screen.getByText(MONEY_FLOW_COPY.buy.question)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("crypto SELL (add-mode) shows the 'Proceeds went to?' question", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    expect(screen.getByText(MONEY_FLOW_COPY.sell.question)).toBeInTheDocument();
  });

  it("stock BUY and SELL (add-mode) show the question", () => {
    renderOpen({ assetClass: "stock", cashAccountOptions: EUR_ACCOUNTS });
    expect(screen.getByText(MONEY_FLOW_COPY.buy.question)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    expect(screen.getByText(MONEY_FLOW_COPY.sell.question)).toBeInTheDocument();
  });

  it("cash class never shows the question", () => {
    renderOpen({ assetClass: "cash", cashAccountOptions: EUR_ACCOUNTS });
    // Default type for cash is deposit; switching to withdrawal still no question.
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "withdrawal" },
    });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("yield type does NOT show the question", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "yield" },
    });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("transfer type does NOT show the question", () => {
    renderOpen({
      assetClass: "crypto",
      cashAccountOptions: EUR_ACCOUNTS,
      onContinueToTransfer: vi.fn(),
    });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "transfer" },
    });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("edit mode does NOT show the question (editTransaction can't re-route)", () => {
    const edit: TransactionEditState = {
      type: "buy",
      quantity: 1,
      amount: 1000,
      amountCurrency: "EUR",
      date: "2026-01-15",
    };
    renderOpen({ assetClass: "crypto", edit, cashAccountOptions: EUR_ACCOUNTS });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("isManualNav does NOT show the question", () => {
    renderOpen({ assetClass: "stock", isManualNav: true, cashAccountOptions: EUR_ACCOUNTS });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});

// ── Test Group 11: Money-flow default + no-accounts fallback ──────────────────

describe("TransactionModal — money-flow default selection", () => {
  it("BUY: tracked is the DEFAULT radio when ≥1 cash account exists", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    const tracked = screen.getByRole("radio", {
      name: new RegExp(MONEY_FLOW_COPY.buy.trackedLabel, "i"),
    }) as HTMLInputElement;
    expect(tracked.checked).toBe(true);
    // The account select appears under it.
    expect(screen.getByRole("combobox", { name: /tracked account/i })).toBeInTheDocument();
  });

  it("SELL: tracked is the DEFAULT radio when ≥1 cash account exists", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    const tracked = screen.getByRole("radio", {
      name: new RegExp(MONEY_FLOW_COPY.sell.trackedLabel, "i"),
    }) as HTMLInputElement;
    expect(tracked.checked).toBe(true);
  });

  it("no accounts: external is selected, tracked is disabled with the no-accounts sub-text", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: [] });
    const tracked = screen.getByRole("radio", {
      name: new RegExp(MONEY_FLOW_COPY.buy.trackedLabel, "i"),
    }) as HTMLInputElement;
    const external = screen.getByRole("radio", {
      name: new RegExp(MONEY_FLOW_COPY.buy.externalLabel, "i"),
    }) as HTMLInputElement;
    expect(tracked).toBeDisabled();
    expect(external.checked).toBe(true);
    expect(screen.getByText(MONEY_FLOW_COPY.noAccounts)).toBeInTheDocument();
    // No account select rendered when there are no accounts.
    expect(screen.queryByRole("combobox", { name: /tracked account/i })).not.toBeInTheDocument();
  });

  it("undefined cashAccountOptions behaves like empty (external-only)", () => {
    renderOpen({ assetClass: "crypto" });
    const external = screen.getByRole("radio", {
      name: new RegExp(MONEY_FLOW_COPY.buy.externalLabel, "i"),
    }) as HTMLInputElement;
    expect(external.checked).toBe(true);
  });
});

// ── Test Group 12: Account select required + amount required (tracked) ────────

describe("TransactionModal — tracked routing blocks", () => {
  it("tracked + no account chosen: Save disabled with the account-required hint", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    // Fill a valid quantity + amount so only the account is missing.
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    expect(screen.getByText(MONEY_FLOW_COPY.accountRequiredHint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("tracked + account chosen + amount: Save enabled, hint gone", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    expect(screen.queryByText(MONEY_FLOW_COPY.accountRequiredHint)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });

  it("tracked + blank amount: Save disabled with the amount-required hint (BUY → 'pays')", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    // Amount left blank → required hint (not the market-fallback hint).
    expect(
      screen.getByText(MONEY_FLOW_COPY.amountRequiredHint("pays")),
    ).toBeInTheDocument();
    expect(screen.queryByText(COST_COPY.amountOptionalHint)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("tracked SELL + blank amount: amount-required hint uses 'receives'", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    expect(
      screen.getByText(MONEY_FLOW_COPY.amountRequiredHint("receives")),
    ).toBeInTheDocument();
  });

  it("external route keeps optional-amount behavior (blank allowed, market hint shown)", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    // Switch to external (new money).
    fireEvent.click(
      screen.getByRole("radio", {
        name: new RegExp(MONEY_FLOW_COPY.buy.externalLabel, "i"),
      }),
    );
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Blank amount on external → optional hint, Save enabled.
    expect(screen.getByText(COST_COPY.amountOptionalHint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });
});

// ── Test Group 13: Currency lock ──────────────────────────────────────────────

describe("TransactionModal — currency lock under tracked", () => {
  it("EUR account: currency select snaps to EUR and is disabled", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    const curSelect = screen.getByRole("combobox", {
      name: /amount currency/i,
    }) as HTMLSelectElement;
    expect(curSelect.value).toBe("EUR");
    expect(curSelect).toBeDisabled();
  });

  it("USD account: currency select snaps to USD and is disabled", () => {
    renderOpen({ assetClass: "stock", cashAccountOptions: USD_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-usd" },
    });
    const curSelect = screen.getByRole("combobox", {
      name: /amount currency/i,
    }) as HTMLSelectElement;
    expect(curSelect.value).toBe("USD");
    expect(curSelect).toBeDisabled();
  });

  it("non-EUR/USD account (GBP): renders a static code label, no select", () => {
    renderOpen({ assetClass: "stock", cashAccountOptions: GBP_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-gbp" },
    });
    // The EUR/USD select is replaced by a static "GBP" label.
    expect(screen.queryByRole("combobox", { name: /amount currency/i })).not.toBeInTheDocument();
    expect(screen.getByText("GBP")).toBeInTheDocument();
  });

  it("deselecting tracked (→ external) restores the normal EUR/USD select", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: USD_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-usd" },
    });
    // Now switch to external — the select should be back and enabled.
    fireEvent.click(
      screen.getByRole("radio", {
        name: new RegExp(MONEY_FLOW_COPY.buy.externalLabel, "i"),
      }),
    );
    const curSelect = screen.getByRole("combobox", {
      name: /amount currency/i,
    }) as HTMLSelectElement;
    expect(curSelect).not.toBeDisabled();
  });
});

// ── Test Group 14: Overdraft guard (Buy + tracked) ────────────────────────────

describe("TransactionModal — overdraft guard", () => {
  it("amount > balance: exact message + Save disabled", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    // Balance is 5000 EUR → overdraw with 6000.
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6000" } });
    // Contract format: "Only €5,000.00 available in Revolut EUR."
    const expected = MONEY_FLOW_COPY.overdraft(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(5000),
      "Revolut EUR",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(expected);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("amount == balance (boundary): allowed, Save enabled", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });

  it("SELL + tracked + amount > balance: NO overdraft (proceeds go INTO the account)", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6000" } });
    // Selling INTO the account never overdraws it.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });

  it("overdraft clears when switching type buy→sell (no stale flag)", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6000" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Switch to sell → overdraft must disappear (recomputed from state).
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ── Test Group 15: Money-flow submit payload ──────────────────────────────────

describe("TransactionModal — money-flow submit payload", () => {
  it("external route → moneyFlow {route:'external'} + legacy fields unchanged", () => {
    const { onSubmit } = renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.click(
      screen.getByRole("radio", {
        name: new RegExp(MONEY_FLOW_COPY.buy.externalLabel, "i"),
      }),
    );
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "750" } });
    fireEvent.submit(document.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.moneyFlow).toEqual({ route: "external" });
    expect(payload.quantity).toBe(2);
    expect(payload.cashflowOverride).toMatchObject({ amount: 750, currency: "EUR" });
  });

  it("tracked route → moneyFlow {route:'tracked', accountId} + account-currency cost", () => {
    const { onSubmit } = renderOpen({ assetClass: "stock", cashAccountOptions: USD_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-usd" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "900" } });
    fireEvent.submit(document.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.moneyFlow).toEqual({ route: "tracked", accountId: "acc-usd" });
    // Cost is in the account currency (USD), required on this route.
    expect(payload.cashflowOverride).toEqual({ amount: 900, currency: "USD" });
  });

  it("tracked EUR account → cost currency is EUR", () => {
    const { onSubmit } = renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "400" } });
    fireEvent.submit(document.querySelector("form")!);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.cashflowOverride).toEqual({ amount: 400, currency: "EUR" });
  });
});

// ── Test Group 16: Effect chips (live amount) ─────────────────────────────────

describe("TransactionModal — money-flow effect chips", () => {
  it("BUY external chip shows the blank fallback then the live +amount", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    // Blank amount → "S&P +contribution".
    expect(screen.getByText(MONEY_FLOW_COPY.buy.externalChipBlank)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "250" } });
    // Live → "S&P +€250.00" (en-US EUR formatting).
    const expected =
      MONEY_FLOW_COPY.buy.externalChipPrefix +
      new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(250);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("SELL external chip shows the blank fallback (S&P −withdrawal)", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    fireEvent.change(screen.getByRole("combobox", { name: /type/i }), {
      target: { value: "sell" },
    });
    expect(screen.getByText(MONEY_FLOW_COPY.sell.externalChipBlank)).toBeInTheDocument();
  });

  it("tracked chip reads 'S&P unchanged'", () => {
    renderOpen({ assetClass: "crypto", cashAccountOptions: EUR_ACCOUNTS });
    // Both buy options render their chip; tracked = unchanged.
    expect(screen.getByText(MONEY_FLOW_COPY.buy.trackedChip)).toBeInTheDocument();
  });
});

// ── Test Group 17: isSubmitting disables money-flow controls ──────────────────

describe("TransactionModal — money-flow controls disabled while submitting", () => {
  it("radios + account select disable during an in-flight submit", () => {
    let resolveSubmit!: () => void;
    const inflight = new Promise<void>((res) => { resolveSubmit = res; });
    const onSubmit = vi.fn(() => inflight);
    render(
      <TransactionModal
        isOpen
        onClose={vi.fn()}
        assetClass="crypto"
        cashAccountOptions={EUR_ACCOUNTS}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("combobox", { name: /tracked account/i }), {
      target: { value: "acc-eur" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100" } });
    fireEvent.submit(document.querySelector("form")!);
    // Tracked radio + account select are disabled while the promise is pending.
    expect(
      screen.getByRole("radio", { name: new RegExp(MONEY_FLOW_COPY.buy.trackedLabel, "i") }),
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /tracked account/i })).toBeDisabled();
    resolveSubmit();
  });
});
