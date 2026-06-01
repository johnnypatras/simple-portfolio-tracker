import { IS_ADJUSTMENT_TOOLTIP_TEXT, IS_ADJUSTMENT_HELP_TEXT } from "@/lib/constants";

interface IsAdjustmentCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Unique per-mount slug for aria id wiring (e.g. "crypto", "stock", "cash", "manual-nav"). */
  idSlug: string;
}

/**
 * Shared "Portfolio adjustment" checkbox + helper text block.
 *
 * Renders the amber-accented checkbox, its tooltip-bearing label, and the
 * helper paragraph below it — extracted from the four add/edit modals
 * (add-crypto, add-stock, cash-account, add-manual-nav) which previously
 * duplicated this markup verbatim. `idSlug` keeps the label↔input↔helper
 * aria wiring unique when multiple modals mount.
 */
export function IsAdjustmentCheckbox({ checked, onChange, idSlug }: IsAdjustmentCheckboxProps) {
  const helpId = `is-adjustment-help-${idSlug}`;
  const inputId = `is-adjustment-checkbox-${idSlug}`;
  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none"
        title={IS_ADJUSTMENT_TOOLTIP_TEXT}
      >
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-amber-500"
          aria-describedby={helpId}
        />
        Portfolio adjustment
      </label>
      <p id={helpId} className="text-xs text-zinc-400 mt-1">{IS_ADJUSTMENT_HELP_TEXT}</p>
    </div>
  );
}
