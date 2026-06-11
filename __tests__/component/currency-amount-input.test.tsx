import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  CurrencyAmountInput,
  type CurrencyAmountValue,
} from "@/components/ui/currency-amount-input";
import { MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";

const OTHER_OPTION_LABEL = "Other…";

function baseProps(overrides?: Partial<React.ComponentProps<typeof CurrencyAmountInput>>) {
  return {
    id: "test-amount",
    label: "Amount paid (incl. fees)",
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
      label="Amount paid (incl. fees)"
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

describe("CurrencyAmountInput", () => {
  it("renders the label wired to the amount input and emits onChange on typing", () => {
    const onChange = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({ onChange, value: { amountStr: "1", currency: "EUR" } })}
      />,
    );

    const input = screen.getByLabelText("Amount paid (incl. fees)");
    expect(input).toHaveAttribute("id", "test-amount");
    expect(input).toHaveAttribute("inputmode", "decimal");

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

    const select = screen.getByRole("combobox", { name: "Amount currency" });
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

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "USD" },
    });
    expect(onChange).toHaveBeenCalledWith({ amountStr: "42", currency: "USD" });
  });

  it("lockedCurrency renders a static code with the lock tooltip and no select; amount stays editable", () => {
    const onChange = vi.fn();
    render(
      <CurrencyAmountInput
        {...baseProps({ onChange, lockedCurrency: "NOK" })}
      />,
    );

    const code = screen.getByText("NOK");
    expect(code).toHaveAttribute("title", MONEY_FLOW_COPY.currencyLockTooltip);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), {
      target: { value: "9" },
    });
    expect(onChange).toHaveBeenCalledWith({ amountStr: "9", currency: "EUR" });
  });

  it("Other… flow: typing a valid code commits it uppercased and returns to the select", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ amountStr: "10", currency: "EUR" }}
        spy={spy}
        defaultCurrency="EUR"
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "__other__" },
    });

    const codeInput = screen.getByLabelText("Currency code");
    expect(codeInput).toHaveAttribute("maxlength", "3");
    fireEvent.change(codeInput, { target: { value: "gbp" } });
    // Auto-uppercase as you type.
    expect(codeInput).toHaveValue("GBP");

    fireEvent.blur(codeInput);
    expect(spy).toHaveBeenCalledWith({ amountStr: "10", currency: "GBP" });

    // Back in select mode with the new code selected and in the shortlist.
    const select = screen.getByRole("combobox", { name: "Amount currency" });
    expect(select).toHaveValue("GBP");
    expect(optionTexts(select)).toContain("GBP");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Other… flow: an unknown code shows the alert and never commits", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "__other__" },
    });
    const codeInput = screen.getByLabelText("Currency code");
    fireEvent.change(codeInput, { target: { value: "XX" } });
    fireEvent.blur(codeInput);

    expect(screen.getByRole("alert")).toHaveTextContent("Unknown currency code");
    // Still in custom-entry mode, nothing emitted.
    expect(screen.getByLabelText("Currency code")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Other… flow: Enter commits a valid code without duplicating shortlist entries", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ amountStr: "5", currency: "EUR" }}
        spy={spy}
        defaultCurrency="EUR"
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "__other__" },
    });
    const codeInput = screen.getByLabelText("Currency code");
    fireEvent.change(codeInput, { target: { value: "usd" } });
    fireEvent.keyDown(codeInput, { key: "Enter" });

    expect(spy).toHaveBeenCalledWith({ amountStr: "5", currency: "USD" });
    const select = screen.getByRole("combobox", { name: "Amount currency" });
    expect(select).toHaveValue("USD");
    // USD was already in the shortlist — no duplicate option.
    expect(optionTexts(select).filter((t) => t === "USD")).toHaveLength(1);
  });

  it("Other… flow: Escape reverts to the previous currency without emitting", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "__other__" },
    });
    const codeInput = screen.getByLabelText("Currency code");
    fireEvent.change(codeInput, { target: { value: "GB" } });
    fireEvent.keyDown(codeInput, { key: "Escape" });

    const select = screen.getByRole("combobox", { name: "Amount currency" });
    expect(select).toHaveValue("EUR");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Other… flow: blur with a blank code reverts without emitting or erroring", () => {
    const onChange = vi.fn();
    render(<CurrencyAmountInput {...baseProps({ onChange })} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Amount currency" }), {
      target: { value: "__other__" },
    });
    fireEvent.blur(screen.getByLabelText("Currency code"));

    expect(
      screen.getByRole("combobox", { name: "Amount currency" }),
    ).toHaveValue("EUR");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disabled disables both the amount input and the currency select", () => {
    render(<CurrencyAmountInput {...baseProps({ disabled: true })} />);

    expect(screen.getByLabelText("Amount paid (incl. fees)")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Amount currency" })).toBeDisabled();
  });

  it("renders hint and placeholder; forwards onBlur from the amount input", () => {
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

    expect(
      screen.getByText("Leave blank to use the market value on that date."),
    ).toBeInTheDocument();
    const input = screen.getByPlaceholderText("0.00");
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

    const select = screen.getByRole("combobox", { name: "Amount currency" });
    expect(select).toHaveValue("SEK");
    expect(optionTexts(select)).toEqual(["EUR", "USD", "SEK", OTHER_OPTION_LABEL]);
  });
});
