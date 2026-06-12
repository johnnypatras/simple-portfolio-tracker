import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorIntentStep, CosmeticConfirm } from "@/components/transactions/editor-intent-step";
import { INTENT_COPY, ADJUSTMENT_COPY } from "@/lib/cost-basis-copy";
import { formatBackdateChipDate } from "@/lib/format";

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function renderStep(overrides: Partial<Parameters<typeof EditorIntentStep>[0]> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onBuy: vi.fn(),
    onYield: vi.fn(),
    onSell: vi.fn(),
    onCosmetic: vi.fn(),
    onOpenTransfer: vi.fn(),
  };
  const props = {
    ticker: "GHO",
    delta: 10,
    approxValueEur: 8.7,
    lastWasTransfer: false,
    lastChangeDate: null as string | null | undefined,
    ...handlers,
    ...overrides,
  };
  return { ...render(<EditorIntentStep {...props} />), ...handlers };
}

describe("EditorIntentStep — increase", () => {
  it("renders the increase question, Yes pre-selected, cosmetic subordinate", () => {
    renderStep();
    expect(screen.getByText(INTENT_COPY.questionIncrease)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.yesIncreaseLabel) })).toBeChecked();
    expect(screen.getByText(INTENT_COPY.noLabel)).toBeInTheDocument();
    // header carries the signed delta + approx value
    expect(screen.getByText(/\+10 GHO/)).toBeInTheDocument();
  });

  it("blank cost → Continue emits onBuy(null)", () => {
    const r = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onBuy).toHaveBeenCalledWith(null);
  });

  it("typed cost → Continue emits onBuy({amount, currency})", () => {
    const r = renderStep();
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), {
      target: { value: "8.70" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onBuy).toHaveBeenCalledWith({ amount: 8.7, currency: "EUR" });
  });

  it("free toggle disables the cost field and emits onYield(date) instead", () => {
    const r = renderStep();
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp("These were free") }));
    expect(screen.getByText(INTENT_COPY.yieldConsequence)).toBeInTheDocument();
    expect(screen.getByLabelText("Amount paid (incl. fees)")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onYield).toHaveBeenCalledWith(todayStr());
    expect(r.onBuy).not.toHaveBeenCalled();
  });
});

describe("EditorIntentStep — decrease", () => {
  it("renders the decrease question, no free toggle, emits onSell", () => {
    const r = renderStep({ delta: -10 });
    expect(screen.getByText(INTENT_COPY.questionDecrease)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: new RegExp("These were free") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onSell).toHaveBeenCalled();
  });
});

describe("EditorIntentStep — cosmetic + guard", () => {
  it("below the threshold saves directly (no guard)", () => {
    const r = renderStep({ approxValueEur: 8 });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onCosmetic).toHaveBeenCalledWith(todayStr());
    expect(screen.queryByText(/Stop counting/)).toBeNull();
  });

  it("at/above the threshold arms the guard naming the € amount", () => {
    const r = renderStep({ delta: -10, approxValueEur: 5000 });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onCosmetic).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(ADJUSTMENT_COPY.markConfirm("€5,000.00"));
    // "It's real value" returns to the Yes answer, guard disarmed
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardReal }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.yesDecreaseLabel) })).toBeChecked();
  });

  it("guard 'Yes, cosmetic' proceeds with the save", () => {
    const r = renderStep({ approxValueEur: 5000 });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardProceed }));
    expect(r.onCosmetic).toHaveBeenCalledWith(todayStr());
  });

  it("unknown value (null) warns and names the signed quantity", () => {
    renderStep({ delta: -10, approxValueEur: null });
    expect(screen.getByText(/-10 GHO/)).toBeInTheDocument(); // header has no ≈ €
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(ADJUSTMENT_COPY.markConfirm("-10 GHO"));
  });

  it("backdate chip sets the cosmetic date", () => {
    renderStep({ lastChangeDate: "2026-05-28" });
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(INTENT_COPY.noLabel) }));
    const chip = screen.getByRole("button", {
      name: new RegExp(formatBackdateChipDate("2026-05-28")),
    });
    fireEvent.click(chip);
    expect(screen.getByLabelText("Effective date")).toHaveValue("2026-05-28");
  });
});

describe("EditorIntentStep — transfer nudge + navigation", () => {
  it("nudge renders only when lastWasTransfer, button emits onOpenTransfer, Yes sub swaps", () => {
    const r = renderStep({ lastWasTransfer: true });
    expect(screen.getByText(INTENT_COPY.nudgeTitle)).toBeInTheDocument();
    expect(screen.getByText(INTENT_COPY.yesTransferNudgeSub)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: INTENT_COPY.nudgeButton }));
    expect(r.onOpenTransfer).toHaveBeenCalled();
  });

  it("no nudge without transfer history", () => {
    renderStep();
    expect(screen.queryByText(INTENT_COPY.nudgeTitle)).toBeNull();
  });

  it("Back emits onBack without any save callback", () => {
    const r = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(r.onBack).toHaveBeenCalled();
    expect(r.onBuy).not.toHaveBeenCalled();
    expect(r.onCosmetic).not.toHaveBeenCalled();
  });

  it("Escape inside the step emits onBack (containment)", () => {
    const r = renderStep();
    fireEvent.keyDown(screen.getByLabelText("Amount paid (incl. fees)"), { key: "Escape" });
    expect(r.onBack).toHaveBeenCalled();
  });
});

describe("EditorIntentStep — cost rejection", () => {
  it("typed 0 → Continue emits onBuy(null) (zero/negative costs never reach the Buy machinery)", () => {
    const r = renderStep();
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onBuy).toHaveBeenCalledWith(null);
  });

  it("negative typed cost → onBuy(null)", () => {
    const r = renderStep();
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(r.onBuy).toHaveBeenCalledWith(null);
  });

  it("per-unit hint renders for a typed cost", () => {
    renderStep({ delta: 10 });
    fireEvent.change(screen.getByLabelText("Amount paid (incl. fees)"), {
      target: { value: "8.70" },
    });
    expect(screen.getByText(/0\.87\/unit/)).toBeInTheDocument();
  });
});

describe("EditorIntentStep — pending guard", () => {
  it("pending disables Continue", () => {
    renderStep({ pending: true });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("pending disables the guard's proceed button", () => {
    const spy = vi.fn();
    render(
      <CosmeticConfirm
        amountLabel="€5,000.00"
        onReal={vi.fn()}
        onProceed={spy}
        pending
      />,
    );
    const proceedBtn = screen.getByRole("button", { name: INTENT_COPY.cosmeticGuardProceed });
    expect(proceedBtn).toBeDisabled();
    fireEvent.click(proceedBtn);
    expect(spy).not.toHaveBeenCalled();
  });
});
