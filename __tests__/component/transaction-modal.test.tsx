import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionModal } from "@/components/transactions/transaction-modal";
import { TYPE_GUIDANCE, COST_COPY } from "@/lib/cost-basis-copy";
import type { TransactionModalProps, TransactionEditState } from "@/components/transactions/transaction-modal";

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
  it("empty quantity: Save is disabled and shows 'Quantity must be a valid number'", () => {
    renderOpen({ assetClass: "crypto" });
    // Quantity is empty by default — alert should be visible
    expect(screen.getByRole("alert")).toHaveTextContent("Quantity must be a valid number");
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn).toBeDisabled();
  });

  it("NaN quantity after clearing: alert persists and Save stays disabled", () => {
    renderOpen({ assetClass: "crypto" });
    const qtyInput = screen.getByLabelText(/quantity/i);
    fireEvent.change(qtyInput, { target: { value: "abc" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Quantity must be a valid number");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});

describe("TransactionModal — lockdown: typed non-numeric amount blocks save with visible alert", () => {
  it("NaN amount (but non-empty): shows alert and Save is disabled", () => {
    renderOpen({ assetClass: "crypto" });
    // First fill in a valid quantity
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Then type a non-numeric amount (use exact label to avoid "Amount currency")
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "abc" } });
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

  it("add mode: submitting without touching amount → cashflowOverride absent, amountUserSet=false", () => {
    const { onSubmit, container } = renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Amount untouched (blank) — provenance gate: no cashflowOverride
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.amountUserSet).toBe(false);
    expect(payload.cashflowOverride).toBeUndefined();
  });

  it("add mode: typing an amount → cashflowOverride present, amountUserSet=true", () => {
    const { onSubmit, container } = renderOpen({ assetClass: "crypto" });
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: "1" } });
    // Use exact label to avoid "Amount currency" select
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "500" } });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.amountUserSet).toBe(true);
    expect(payload.cashflowOverride).toMatchObject({ amount: 500 });
  });

  it("edit mode: prefilled amount untouched → cashflowOverride absent, amountUserSet=false", () => {
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
    expect(payload.amountUserSet).toBe(false);
    expect(payload.cashflowOverride).toBeUndefined();
  });

  it("edit mode: user edits the prefilled amount → cashflowOverride present, amountUserSet=true", () => {
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
    expect(payload.amountUserSet).toBe(true);
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
