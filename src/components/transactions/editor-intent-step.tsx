"use client";

import { useId, useState } from "react";
import { History } from "lucide-react";
import { CurrencyAmountInput } from "@/components/ui/currency-amount-input";
import { ADJUSTMENT_COPY, COST_COPY, INTENT_COPY } from "@/lib/cost-basis-copy";
import { needsCosmeticConfirm } from "@/lib/cosmetic-guard";
import { fmtCurrency, formatBackdateChipDate } from "@/lib/format";

/** yyyy-mm-dd for today — the default for the step's date inputs. */
function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

/** "+10" / "-10"-style signed quantity for the header and the no-value guard label. */
function signedQty(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

export interface EditorIntentStepProps {
  ticker: string;
  /** Signed quantity change — never 0 (editors only open the step on a real delta). */
  delta: number;
  /** Approximate EUR value of the change; null = unknown (gate warns, header omits ≈). */
  approxValueEur: number | null;
  lastWasTransfer: boolean;
  /** undefined = not loaded · null = no history · string = backdate-chip date. */
  lastChangeDate: string | null | undefined;
  /** True while the host is awaiting a write from this step — disables the submit buttons (double-click = double booking). */
  pending?: boolean;
  onBack: () => void;
  onBuy: (cost: { amount: number; currency: string } | null) => void;
  onYield: (date: string | null) => void;
  onSell: () => void;
  onCosmetic: (date: string | null) => void;
  onOpenTransfer: () => void;
}

/**
 * The value-gated amber confirm for the cosmetic/off-book answer. Exported for
 * reuse by the cash modal (same guard, cash vocabulary around it).
 */
export function CosmeticConfirm({
  amountLabel,
  onReal,
  onProceed,
  pending,
}: {
  /** Pre-formatted stakes — "€5,000.00", or "-10 GHO" when no value is known. */
  amountLabel: string;
  onReal: () => void;
  onProceed: () => void;
  /** True while the host is awaiting a write from this step — disables the submit buttons (double-click = double booking). */
  pending?: boolean;
}) {
  return (
    <div role="alert" className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
      <p className="text-xs font-semibold text-amber-400">
        ⚠ {ADJUSTMENT_COPY.markConfirm(amountLabel)}
      </p>
      <p className="text-[10px] text-zinc-400 mt-1">
        {INTENT_COPY.cosmeticGuardBody} {ADJUSTMENT_COPY.reversibleNote}
      </p>
      <div className="flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onReal}
          className="px-2.5 py-1 rounded text-xs text-blue-400 hover:bg-zinc-800 transition-colors"
        >
          {INTENT_COPY.cosmeticGuardReal}
        </button>
        <button
          type="button"
          onClick={onProceed}
          disabled={pending}
          aria-busy={pending}
          className="px-2.5 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:bg-zinc-800 disabled:text-zinc-600 transition-colors"
        >
          {INTENT_COPY.cosmeticGuardProceed}
        </button>
      </div>
    </div>
  );
}

/**
 * The C3 editor intent question (spec §4): direction-aware, Yes pre-selected,
 * cosmetic subordinate. Performs no I/O — every outcome is a callback; the
 * hosting editor owns all writes (and the trash/deleteRow distinction).
 */
export function EditorIntentStep({
  ticker,
  delta,
  approxValueEur,
  lastWasTransfer,
  lastChangeDate,
  pending,
  onBack,
  onBuy,
  onYield,
  onSell,
  onCosmetic,
  onOpenTransfer,
}: EditorIntentStepProps) {
  const id = useId();
  const increase = delta > 0;
  const [choice, setChoice] = useState<"yes" | "cosmetic">("yes");
  const [free, setFree] = useState(false);
  const [cost, setCost] = useState<{ amountStr: string; currency: string }>({
    amountStr: "",
    currency: "EUR",
  });
  const [yieldDate, setYieldDate] = useState(todayStr);
  const [cosmeticDate, setCosmeticDate] = useState(todayStr);
  const [guardArmed, setGuardArmed] = useState(false);

  const absDelta = Math.abs(delta);
  const costNum = parseFloat(cost.amountStr);
  const costValid =
    cost.amountStr.trim() !== "" && Number.isFinite(costNum) && costNum > 0;

  const header = `On save · ${signedQty(delta)} ${ticker}${
    approxValueEur != null ? ` (≈ ${fmtCurrency(approxValueEur, "EUR")})` : ""
  }`;
  const guardAmountLabel =
    approxValueEur != null ? fmtCurrency(approxValueEur, "EUR") : `${signedQty(delta)} ${ticker}`;
  const yesLabel = increase ? INTENT_COPY.yesIncreaseLabel : INTENT_COPY.yesDecreaseLabel;
  const yesSub = lastWasTransfer
    ? INTENT_COPY.yesTransferNudgeSub
    : increase
      ? INTENT_COPY.yesIncreaseSub
      : INTENT_COPY.yesDecreaseSub;

  function handleContinue() {
    if (choice === "yes") {
      if (!increase) {
        onSell();
        return;
      }
      if (free) {
        onYield(yieldDate || null);
        return;
      }
      onBuy(costValid ? { amount: costNum, currency: cost.currency } : null);
      return;
    }
    if (!guardArmed && needsCosmeticConfirm(approxValueEur)) {
      setGuardArmed(true);
      return;
    }
    onCosmetic(cosmeticDate || null);
  }

  return (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Contain Escape: Back to the rows, never closing the host modal.
          // Same containment trio as currency-amount-input — React 19
          // delegates at the document root, the same node the focus trap
          // listens on, so stopPropagation alone is not enough.
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onBack();
        }
      }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{header}</p>

      {lastWasTransfer && (
        <div className="rounded-lg border border-teal-500/40 bg-teal-500/5 px-3 py-2.5">
          <p className="text-xs font-semibold text-teal-400">{INTENT_COPY.nudgeTitle}</p>
          <p className="text-[11px] text-zinc-400 mt-1">{INTENT_COPY.nudgeBody}</p>
          <div className="flex justify-end mt-2">
            <button
              type="button"
              onClick={onOpenTransfer}
              className="px-2.5 py-1 rounded text-[11px] bg-teal-600 hover:bg-teal-500 text-white transition-colors"
            >
              {INTENT_COPY.nudgeButton}
            </button>
          </div>
        </div>
      )}

      <fieldset>
        <legend className="text-sm font-medium text-zinc-200 mb-2">
          {increase ? INTENT_COPY.questionIncrease : INTENT_COPY.questionDecrease}
        </legend>

        {/* Yes — the value-bearing primary */}
        <label
          className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
            choice === "yes" ? "border-emerald-500/50 bg-emerald-500/5" : "border-zinc-800"
          }`}
        >
          <input
            type="radio"
            name={`${id}-intent`}
            checked={choice === "yes"}
            onChange={() => {
              setChoice("yes");
              setGuardArmed(false);
            }}
            className="mt-0.5 accent-emerald-500"
          />
          <span className="flex-1 min-w-0">
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-100">{yesLabel}</span>
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                {INTENT_COPY.chipCounts}
              </span>
            </span>
            <span className="block text-[10px] text-zinc-400 mt-0.5">{yesSub}</span>
          </span>
        </label>

        {choice === "yes" && increase && (
          <div className="ml-6 mt-2 pl-3 border-l-2 border-zinc-800 space-y-2.5">
            <div>
              <CurrencyAmountInput
                id={`${id}-intent-cost`}
                label="Amount paid (incl. fees)"
                value={cost}
                onChange={setCost}
                defaultCurrency="EUR"
                disabled={free}
                placeholder={free ? "— not needed —" : "Leave blank to use market value"}
              />
              {!free && (
                <p className="text-[10px] text-zinc-400 mt-1">
                  {costValid && absDelta > 0
                    ? `≈ ${fmtCurrency(costNum / absDelta, cost.currency)}/unit · `
                    : ""}
                  {COST_COPY.amountOptionalHint}
                </p>
              )}
            </div>
            <label className="flex items-start gap-1.5 text-[11px] text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={free}
                onChange={(e) => setFree(e.target.checked)}
                className="mt-0.5 w-3 h-3 accent-emerald-500"
              />
              {INTENT_COPY.freeToggle}
            </label>
            {free && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-emerald-400">{INTENT_COPY.yieldConsequence}</p>
                <div>
                  <label htmlFor={`${id}-yield-date`} className="block text-xs text-zinc-400 mb-1">
                    {INTENT_COPY.yieldDateLabel}
                  </label>
                  <input
                    id={`${id}-yield-date`}
                    type="date"
                    max={todayStr()}
                    value={yieldDate}
                    onChange={(e) => setYieldDate(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 text-sm"
                  />
                  <p className="text-[10px] text-zinc-400 mt-1">{INTENT_COPY.yieldDateHint}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* No — the subordinate cosmetic escape */}
        <label
          className={`mt-2 flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2 cursor-pointer transition-colors ${
            choice === "cosmetic" ? "border-zinc-500 bg-zinc-500/5" : "border-zinc-800 opacity-60"
          }`}
        >
          <input
            type="radio"
            name={`${id}-intent`}
            checked={choice === "cosmetic"}
            onChange={() => {
              // No disarm needed here — only the Yes path can leave an armed guard behind (arming requires cosmetic already selected).
              setChoice("cosmetic");
            }}
            className="mt-0.5 accent-zinc-400"
          />
          <span className="flex-1 min-w-0">
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-300">{INTENT_COPY.noLabel}</span>
              <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-400 border border-zinc-600/40">
                {INTENT_COPY.chipOffBook}
              </span>
            </span>
          </span>
        </label>

        {choice === "cosmetic" && (
          <div className="ml-6 mt-2 pl-3 border-l-2 border-zinc-800 space-y-1.5">
            <div>
              <label htmlFor={`${id}-cosmetic-date`} className="block text-xs text-zinc-400 mb-1">
                Effective date
              </label>
              <input
                id={`${id}-cosmetic-date`}
                type="date"
                max={todayStr()}
                value={cosmeticDate}
                onChange={(e) => setCosmeticDate(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 text-sm"
              />
              {typeof lastChangeDate === "string" && (
                <button
                  type="button"
                  onClick={() => setCosmeticDate(lastChangeDate)}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors"
                  aria-label={`Backdate the effective date to this position's last change on ${formatBackdateChipDate(lastChangeDate)}`}
                >
                  <History className="w-3 h-3" />
                  Backdate to last change ({formatBackdateChipDate(lastChangeDate)})?
                </button>
              )}
            </div>
            <p className="text-[10px] text-zinc-400">{INTENT_COPY.cosmeticQuietNote}</p>
            {guardArmed && (
              <CosmeticConfirm
                amountLabel={guardAmountLabel}
                onReal={() => {
                  setChoice("yes");
                  setGuardArmed(false);
                }}
                onProceed={() => onCosmetic(cosmeticDate || null)}
                pending={pending}
              />
            )}
          </div>
        )}
      </fieldset>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Back
        </button>
        {!guardArmed && (
          <button
            type="button"
            onClick={handleContinue}
            disabled={pending}
            aria-busy={pending}
            className={`px-4 py-2 text-sm rounded-lg text-white transition-colors disabled:bg-zinc-800 disabled:text-zinc-600 ${
              choice === "yes" && increase && free
                ? "bg-teal-600 hover:bg-teal-500"
                : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
