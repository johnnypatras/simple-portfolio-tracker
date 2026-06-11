import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  CurrencyAmountInput,
  CurrencyCodeSelect,
  type CurrencyAmountValue,
} from "@/components/ui/currency-amount-input";
import { Modal } from "@/components/ui/modal";
import { MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";

const OTHER_OPTION_LABEL = "Other…";
const AMOUNT_LABEL = "Amount paid (incl. fees)";
// Accessible names are derived per instance from the label prop, so two
// CurrencyAmountInputs in one form stay distinguishable to AT users.
const SELECT_NAME = `${AMOUNT_LABEL} currency`;
const CODE_INPUT_NAME = `${AMOUNT_LABEL} currency code`;

function baseProps(overrides?: Partial<React.ComponentProps<typeof CurrencyAmountInput>>) {
  return {
    id: "test-amount",
    label: AMOUNT_LABEL,
    value: { amountStr: "", currency: "EUR" },
    onChange: vi.fn(),
    defaultCurrency: "EUR",
    ...overrides,
  };
}

/** Stateful harness so the controlled value round-trips like in a real caller. */
function Harness({
  initial,
  spy,
  ...rest
}: {
  initial: CurrencyAmountValue;
  spy: (v: CurrencyAmountValue) => void;
  defaultCurrency: string;
  contextCurrencies?: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <CurrencyAmountInput
      id="test-amount"
      label={AMOUNT_LABEL}
      value={value}
      onChange={(v) => {
        spy(v);
        setValue(v);
      }}
      {...rest}
    />
  );
}

function optionTexts(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

/** Picks Other… in the currency select and returns the free-entry code input. */
function enterOtherMode(): HTMLElement {
  fireEvent.change(screen.getByRole("combobox", { name: SELECT_NAME }), {
    target: { value: "__other__" },
  });
  return screen.getByLabelText(CODE_INPUT_NAME);
}

describe("CurrencyAmountInput", () => {
  it("renders the label wired to the amount input and emits onChange on typing", () => {
    const onChange = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({ onChange, value: { amountStr: "1", currency: "EUR" } })}
      />,
    );

    const input = screen.getByLabelText(AMOUNT_LABEL);
    expect(input).toHaveAttribute("id", "test-amount");
    expect(input).toHaveAttribute("inputmode", "decimal");
    // No hint, no error → nothing to describe.
    expect(input).not.toHaveAttribute("aria-describedby");

    fireEvent.change(input, { target: { value: "123.45" } });
    expect(onChange).toHaveBeenCalledWith({ amountStr: "123.45", currency: "EUR" });
  });

  it("builds the shortlist deduped: defaultCurrency first, then EUR/USD, then contextCurrencies, then Other…", () => {
    render(
      <CurrencyAmountInput
        {...baseProps({
          value: { amountStr: "", currency: "" },
          defaultCurrency: "CHF",
          // "EUR" and lowercase "chf" overlap with the head of the list → deduped.
          contextCurrencies: ["EUR", "GBP", "chf", "JPY", "GBP"],
        })}
      />,
    );

    const select = screen.getByRole("combobox", { name: SELECT_NAME });
    expect(optionTexts(select)).toEqual([
      "CHF",
      "EUR",
      "USD",
      "GBP",
      "JPY",
      OTHER_OPTION_LABEL,
    ]);
    // value.currency is empty → defaultCurrency shown.
    expect(select).toHaveValue("CHF");
  });

  it("emits onChange with the selected shortlist currency", () => {
    const onChange = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({ onChange, value: { amountStr: "42", currency: "EUR" } })}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: SELECT_NAME }), {
      target: { value: "USD" },
    });
    expect(onChange).toHaveBeenCalledWith({ amountStr: "42", currency: "USD" });
  });

  it("lockedCurrency renders a static code with the lock tooltip and forces the lock into amount emissions", () => {
    const onChange = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({ onChange, lockedCurrency: "NOK" })}
      />,
    );

    const code = screen.getByText("NOK");
    expect(code).toHaveAttribute("title", MONEY_FLOW_COPY.currencyLockTooltip);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(AMOUNT_LABEL), {
      target: { value: "9" },
    });
    // The emission must be self-consistent with the displayed lock — never the
    // stale value.currency ("EUR" here).
    expect(onChange).toHaveBeenCalledWith({ amountStr: "9", currency: "NOK" });
  });

  it("Other… flow: typing a valid code commits it uppercased on blur and returns to the select", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ amountStr: "10", currency: "EUR" }}
        spy={spy}
        defaultCurrency="EUR"
      />,
    );

    const codeInput = enterOtherMode();
    expect(codeInput).toHaveAttribute("maxlength", "3");
    // Entering Other… mode autofocuses the code input.
    expect(codeInput).toHaveFocus();
    fireEvent.change(codeInput, { target: { value: "gbp" } });
    // Auto-uppercase as you type.
    expect(codeInput).toHaveValue("GBP");

    fireEvent.blur(codeInput);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ amountStr: "10", currency: "GBP" });

    // Back in select mode with the new code selected and in the shortlist.
    const select = screen.getByRole("combobox", { name: SELECT_NAME });
    expect(select).toHaveValue("GBP");
    expect(optionTexts(select)).toContain("GBP");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Other… flow: an unknown code shows the alert and never commits", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "XX" } });
    fireEvent.blur(codeInput);

    expect(screen.getByRole("alert")).toHaveTextContent("Unknown currency code");
    // Still in custom-entry mode, nothing emitted.
    expect(screen.getByLabelText(CODE_INPUT_NAME)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Other… flow: retyping clears the error; hint + error ids compose on the amount input", () => {
    render(<CurrencyAmountInput {...baseProps({ hint: "Optional." })} />);

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "XX" } });
    fireEvent.blur(codeInput);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText(AMOUNT_LABEL)).toHaveAttribute(
      "aria-describedby",
      "test-amount-hint test-amount-currency-error",
    );

    fireEvent.change(codeInput, { target: { value: "NOK" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(AMOUNT_LABEL)).toHaveAttribute(
      "aria-describedby",
      "test-amount-hint",
    );
  });

  it("Other… flow: Enter commits a valid code (preventing form submit) without duplicating shortlist entries", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ amountStr: "5", currency: "EUR" }}
        spy={spy}
        defaultCurrency="EUR"
      />,
    );

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "usd" } });
    // false ⇒ preventDefault fired — the enclosing form must not submit.
    expect(fireEvent.keyDown(codeInput, { key: "Enter" })).toBe(false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ amountStr: "5", currency: "USD" });
    const select = screen.getByRole("combobox", { name: SELECT_NAME });
    expect(select).toHaveValue("USD");
    // USD was already in the shortlist — no duplicate option.
    expect(optionTexts(select).filter((t) => t === "USD")).toHaveLength(1);
    // Focus restored to the select when the code input unmounted.
    expect(select).toHaveFocus();
  });

  it("Other… flow: Escape reverts to the previous currency without emitting", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "GB" } });
    fireEvent.keyDown(codeInput, { key: "Escape" });

    const select = screen.getByRole("combobox", { name: SELECT_NAME });
    expect(select).toHaveValue("EUR");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Focus restored to the select when the code input unmounted.
    expect(select).toHaveFocus();
  });

  it("Other… flow: Escape inside a Modal host stays contained — the modal does not close, only the draft reverts", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Record Buy">
        <CurrencyAmountInput {...baseProps()} />
      </Modal>,
    );

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "GB" } });

    // Same-node pin: React delegates events on the render root (the document
    // under App Router), so a sibling listener there is only suppressed by
    // nativeEvent.stopImmediatePropagation(), not stopPropagation().
    const sameNodeListener = vi.fn();
    container.addEventListener("keydown", sameNodeListener);

    fireEvent.keyDown(codeInput, { key: "Escape" });

    // Contained: the host modal stayed open and the draft reverted.
    expect(onClose).not.toHaveBeenCalled();
    expect(sameNodeListener).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: SELECT_NAME })).toHaveValue("EUR");

    // The pin listener is live — an uncontained key reaches it.
    fireEvent.keyDown(screen.getByLabelText(AMOUNT_LABEL), { key: "a" });
    expect(sameNodeListener).toHaveBeenCalledTimes(1);

    // And the modal's own document-level Escape handling still works.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Other… flow: reopening after Escape starts with a cleared draft", () => {
    render(<CurrencyAmountInput {...baseProps()} />);

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "GB" } });
    fireEvent.keyDown(codeInput, { key: "Escape" });

    // Reopen Other… — the abandoned draft must not survive.
    expect(enterOtherMode()).toHaveValue("");
  });

  it("Other… flow: blur with a blank code reverts without emitting or erroring", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    fireEvent.blur(enterOtherMode());

    expect(
      screen.getByRole("combobox", { name: SELECT_NAME }),
    ).toHaveValue("EUR");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears Other… draft and error when lockedCurrency arrives mid-entry", () => {
    const { rerender } = render(<CurrencyAmountInput {...baseProps()} />);

    const codeInput = enterOtherMode();
    fireEvent.change(codeInput, { target: { value: "XX" } });
    fireEvent.blur(codeInput);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The host locks the currency (e.g. a tracked account got selected).
    rerender(<CurrencyAmountInput {...baseProps({ lockedCurrency: "NOK" })} />);
    expect(screen.getByText("NOK")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Unlocking lands back in select mode — no stale code input or error.
    rerender(<CurrencyAmountInput {...baseProps()} />);
    expect(screen.getByRole("combobox", { name: SELECT_NAME })).toBeInTheDocument();
    expect(screen.queryByLabelText(CODE_INPUT_NAME)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disabled disables both the amount input and the currency select", () => {
    render(<CurrencyAmountInput {...baseProps({ disabled: true })} />);

    expect(screen.getByLabelText(AMOUNT_LABEL)).toBeDisabled();
    expect(screen.getByRole("combobox", { name: SELECT_NAME })).toBeDisabled();
  });

  it("renders hint (described-by the amount input) and placeholder; forwards onBlur", () => {
    const onBlur = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({
          hint: "Leave blank to use the market value on that date.",
          placeholder: "0.00",
          onBlur,
        })}
      />,
    );

    const hint = screen.getByText(
      "Leave blank to use the market value on that date.",
    );
    expect(hint).toHaveAttribute("id", "test-amount-hint");
    const input = screen.getByPlaceholderText("0.00");
    expect(input).toHaveAttribute("aria-describedby", "test-amount-hint");
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("shows a caller-provided currency outside the shortlist as a selectable option", () => {
    // Editors hydrate from stored original_* — any ISO must render, not break the
    // controlled select.
    render(
      <CurrencyAmountInput
        {...baseProps({ value: { amountStr: "7", currency: "SEK" } })}
      />,
    );

    const select = screen.getByRole("combobox", { name: SELECT_NAME });
    expect(select).toHaveValue("SEK");
    expect(optionTexts(select)).toEqual(["EUR", "USD", "SEK", OTHER_OPTION_LABEL]);
  });

  it("amountAriaInvalid mirrors aria-invalid on the amount input; omitted → attribute absent", () => {
    // Hosts with touched-gated validation (transaction modal) pass a boolean —
    // both true and false must render, matching the inline input it replaces.
    const { rerender } = render(
      <CurrencyAmountInput {...baseProps({ amountAriaInvalid: true })} />,
    );
    expect(screen.getByLabelText(AMOUNT_LABEL)).toHaveAttribute("aria-invalid", "true");

    rerender(<CurrencyAmountInput {...baseProps({ amountAriaInvalid: false })} />);
    expect(screen.getByLabelText(AMOUNT_LABEL)).toHaveAttribute("aria-invalid", "false");

    // Hosts without validation pass nothing → no attribute (plain cost inputs).
    rerender(<CurrencyAmountInput {...baseProps()} />);
    expect(screen.getByLabelText(AMOUNT_LABEL)).not.toHaveAttribute("aria-invalid");
  });
});

// ── Standalone CurrencyCodeSelect (amount-less hosts) ────────────────────────

const CODE_SELECT_NAME = "Cost currency";
const CODE_SELECT_INPUT_NAME = "Cost currency code";

/** Stateful harness — the standalone control round-trips like a real caller. */
function CodeSelectHarness({
  spy,
  lockedCurrency,
}: {
  spy: (code: string) => void;
  lockedCurrency?: string;
}) {
  const [currency, setCurrency] = useState("EUR");
  return (
    <CurrencyCodeSelect
      id="cost-currency"
      labelBase="Cost"
      currency={currency}
      onCurrencyChange={(code) => {
        spy(code);
        setCurrency(code);
      }}
      defaultCurrency="EUR"
      lockedCurrency={lockedCurrency}
    />
  );
}

describe("CurrencyCodeSelect", () => {
  it("renders the deduped shortlist + Other… and emits a picked code", () => {
    const spy = vi.fn();
    render(<CodeSelectHarness spy={spy} />);

    const select = screen.getByRole("combobox", { name: CODE_SELECT_NAME });
    expect(optionTexts(select)).toEqual(["EUR", "USD", OTHER_OPTION_LABEL]);

    fireEvent.change(select, { target: { value: "USD" } });
    expect(spy).toHaveBeenCalledWith("USD");
    expect(select).toHaveValue("USD");
  });

  it("Other… flow commits a valid free-typed code (uppercased) and adds it to the shortlist", () => {
    const spy = vi.fn();
    render(<CodeSelectHarness spy={spy} />);

    fireEvent.change(screen.getByRole("combobox", { name: CODE_SELECT_NAME }), {
      target: { value: "__other__" },
    });
    const codeInput = screen.getByLabelText(CODE_SELECT_INPUT_NAME);
    fireEvent.change(codeInput, { target: { value: "nok" } });
    fireEvent.blur(codeInput);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("NOK");
    const select = screen.getByRole("combobox", { name: CODE_SELECT_NAME });
    expect(select).toHaveValue("NOK");
    expect(optionTexts(select)).toContain("NOK");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Other… flow rejects an unknown code with its own alert wired via aria-describedby", () => {
    const spy = vi.fn();
    render(<CodeSelectHarness spy={spy} />);

    fireEvent.change(screen.getByRole("combobox", { name: CODE_SELECT_NAME }), {
      target: { value: "__other__" },
    });
    const codeInput = screen.getByLabelText(CODE_SELECT_INPUT_NAME);
    fireEvent.change(codeInput, { target: { value: "XX" } });
    fireEvent.blur(codeInput);

    expect(screen.getByRole("alert")).toHaveTextContent("Unknown currency code");
    expect(codeInput).toHaveAttribute("aria-describedby", "cost-currency-error");
    expect(spy).not.toHaveBeenCalled();
  });

  it("lockedCurrency renders the static code with the lock tooltip, no combobox", () => {
    render(<CodeSelectHarness spy={vi.fn()} lockedCurrency="NOK" />);

    expect(screen.getByText("NOK")).toHaveAttribute(
      "title",
      MONEY_FLOW_COPY.currencyLockTooltip,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
