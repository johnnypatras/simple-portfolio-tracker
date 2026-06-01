import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * Tests for the IS_ADJUSTMENT semantic refresh + shared checkbox component:
 *   • The new tooltip + helper text constants in src/lib/constants.ts.
 *   • The shared <IsAdjustmentCheckbox> component (markup + aria wiring).
 *   • A form modal (CashAccountModal) renders the helper text below the
 *     "Portfolio adjustment" checkbox via that shared component.
 *
 * CashAccountModal is the simplest example — it opens straight into the
 * form (no search/multi-step flow). The other 3 modals (add-crypto,
 * add-stock, add-manual-nav) render the same shared component in the same
 * place, only varying the idSlug + checked/onChange wiring.
 */

vi.mock("@/lib/actions/cash-accounts", () => ({
  createCashAccount: vi.fn(),
  updateCashAccount: vi.fn(),
}));

vi.mock("focus-trap-react", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { CashAccountModal } from "@/components/cash/cash-account-modal";
import { IsAdjustmentCheckbox } from "@/components/ui/is-adjustment-checkbox";
import { IS_ADJUSTMENT_HELP_TEXT, IS_ADJUSTMENT_TOOLTIP_TEXT } from "@/lib/constants";

describe("is_adjustment semantic refresh", () => {
  describe("copy constants", () => {
    it("tooltip uses the new 'cash flow' phrasing instead of 'real transaction'", () => {
      expect(IS_ADJUSTMENT_TOOLTIP_TEXT).not.toMatch(/Not a real transaction/i);
      expect(IS_ADJUSTMENT_TOOLTIP_TEXT).toMatch(/Not a real cash flow/i);
      expect(IS_ADJUSTMENT_TOOLTIP_TEXT).toMatch(/internal adjustment/i);
    });

    it("helper text explains the cash flow distinction and points to Effective date", () => {
      expect(IS_ADJUSTMENT_HELP_TEXT).toMatch(/real money flowing in or out/i);
      expect(IS_ADJUSTMENT_HELP_TEXT).toMatch(/balance correction/i);
      expect(IS_ADJUSTMENT_HELP_TEXT).toMatch(/Effective date/i);
      expect(IS_ADJUSTMENT_HELP_TEXT).toMatch(/leave this unchecked/i);
    });
  });

  describe("IsAdjustmentCheckbox (shared component)", () => {
    it("renders the label, helper text, and amber checkbox with correct aria wiring", () => {
      render(
        <IsAdjustmentCheckbox checked={false} onChange={vi.fn()} idSlug="crypto" />,
      );

      // Label text + tooltip.
      const label = screen.getByText("Portfolio adjustment").closest("label");
      expect(label).not.toBeNull();
      expect(label).toHaveAttribute("title", IS_ADJUSTMENT_TOOLTIP_TEXT);

      // Checkbox: stable per-slug id, amber accent, describedby → helper id.
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveAttribute("id", "is-adjustment-checkbox-crypto");
      expect(checkbox).toHaveClass("accent-amber-500");
      expect(checkbox).toHaveAttribute("aria-describedby", "is-adjustment-help-crypto");
      expect(checkbox).not.toBeChecked();

      // Helper paragraph: verbatim copy + matching id.
      const help = screen.getByText(IS_ADJUSTMENT_HELP_TEXT);
      expect(help).toHaveAttribute("id", "is-adjustment-help-crypto");
    });

    it("derives per-slug ids so multiple mounts stay unique", () => {
      render(
        <IsAdjustmentCheckbox checked onChange={vi.fn()} idSlug="manual-nav" />,
      );
      const checkbox = screen.getByRole("checkbox");
      expect(checkbox).toHaveAttribute("id", "is-adjustment-checkbox-manual-nav");
      expect(checkbox).toHaveAttribute("aria-describedby", "is-adjustment-help-manual-nav");
      expect(checkbox).toBeChecked();
      expect(screen.getByText(IS_ADJUSTMENT_HELP_TEXT)).toHaveAttribute(
        "id",
        "is-adjustment-help-manual-nav",
      );
    });

    it("calls onChange with the next boolean when toggled", () => {
      const onChange = vi.fn();
      render(
        <IsAdjustmentCheckbox checked={false} onChange={onChange} idSlug="cash" />,
      );
      fireEvent.click(screen.getByRole("checkbox"));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(true);
    });
  });

  describe("CashAccountModal", () => {
    it("renders the helper paragraph immediately below the checkbox", () => {
      render(
        <CashAccountModal
          isOpen
          onClose={vi.fn()}
          institutionId="inst-1"
          institutionName="Revolut"
        />,
      );

      // The checkbox label is present.
      expect(screen.getByText("Portfolio adjustment")).toBeInTheDocument();

      // Helper text constant is rendered verbatim.
      expect(screen.getByText(IS_ADJUSTMENT_HELP_TEXT)).toBeInTheDocument();
    });

    it("checkbox label carries the new tooltip via the title attribute", () => {
      render(
        <CashAccountModal
          isOpen
          onClose={vi.fn()}
          institutionId="inst-1"
          institutionName="Revolut"
        />,
      );

      // Find the label by its text — the tooltip lives on the same element.
      const label = screen.getByText("Portfolio adjustment").closest("label");
      expect(label).not.toBeNull();
      expect(label).toHaveAttribute("title", IS_ADJUSTMENT_TOOLTIP_TEXT);
    });
  });
});
