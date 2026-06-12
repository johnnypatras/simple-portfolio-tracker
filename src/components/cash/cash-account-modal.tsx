"use client";

import { useState, useEffect, useId } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createCashAccount,
  updateCashAccount,
} from "@/lib/actions/cash-accounts";
import { findOrCreateInstitution } from "@/lib/actions/institutions";
import type { CashAccount, CashAccountCreateInput, CashAccountUpdateInput, Institution } from "@/lib/types";
import { IS_ADJUSTMENT_TOOLTIP_TEXT } from "@/lib/constants";
import { IsAdjustmentCheckbox } from "@/components/ui/is-adjustment-checkbox";
import { CurrencyCodeSelect } from "@/components/ui/currency-amount-input";
import { INTENT_COPY } from "@/lib/cost-basis-copy";
import { approxDeltaValueEur, needsCosmeticConfirm } from "@/lib/cosmetic-guard";
import { CosmeticConfirm } from "@/components/transactions/editor-intent-step";
import { fmtCurrency } from "@/lib/format";
import type { FXRates } from "@/lib/prices/fx";

/** Sentinel <option> value for the "create a new bank" choice in the bank picker. */
const NEW_BANK = "__new_bank__";

interface CashAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  cashAccount?: CashAccount | null;
  institutionId?: string;
  institutionName?: string;
  /** Banks to choose from when adding/fixing a bank account that has no parent institution. */
  institutions?: Institution[];
  walletId?: string;
  walletName?: string;
  brokerId?: string;
  brokerName?: string;
  /** Display-base FX rates — feeds the cosmetic guard's approximate EUR
   *  valuation of the balance delta. Optional; absent → 1:1 fallback. */
  fxRates?: FXRates;
}

export function CashAccountModal({
  isOpen,
  onClose,
  cashAccount,
  institutionId,
  institutionName,
  institutions = [],
  walletId,
  walletName,
  brokerId,
  brokerName,
  fxRates,
}: CashAccountModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdjustment, setIsAdjustment] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");

  const id = useId();

  // Form state
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<string>("EUR");
  // Edit mode shows the stored currency read-only; the "Change" affordance
  // reveals the full control for the rare deliberate currency change.
  const [changingCurrency, setChangingCurrency] = useState(false);
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const [newBankName, setNewBankName] = useState("");

  // ─── C3 edit-mode intent step ───────────────────────────
  const [step, setStep] = useState<"form" | "intent">("form");
  const [intentChoice, setIntentChoice] = useState<"yes" | "cosmetic">("yes");
  const [guardArmed, setGuardArmed] = useState(false);

  // Bank-origin accounts show the name field; deposits (wallet/broker) do not
  const isBankOrigin = !walletId && !brokerId && !cashAccount?.wallet_id && !cashAccount?.broker_id;
  const isEditing = !!cashAccount;

  // Show the bank picker only when a bank-origin account GENUINELY has no parent
  // bank: no institution from context AND (when editing) none on the row itself.
  // This covers a context-free "Add Cash" (new) and fixing an existing orphan
  // that renders as "Unknown Bank", while leaving normal accounts untouched —
  // even if the modal is opened without the (redundant) institutionId prop.
  const showInstitutionPicker =
    isBankOrigin && !institutionId && !cashAccount?.institution_id;

  // Derive modal title from context
  function getTitle(): string {
    if (isEditing) {
      if (cashAccount.wallet_id) return "Edit Exchange Deposit";
      if (cashAccount.broker_id) return "Edit Broker Deposit";
      return "Edit Bank Account";
    }
    if (walletId) return `Add Deposit — ${walletName ?? "Exchange"}`;
    if (brokerId) return `Add Deposit — ${brokerName ?? "Broker"}`;
    return institutionName ? `Add Account — ${institutionName}` : "Add Cash Account";
  }

  // Sync form when modal opens or cashAccount changes
  useEffect(() => {
    if (isOpen && cashAccount) {
      setName(cashAccount.name ?? "");
      setCurrency(cashAccount.currency);
      setChangingCurrency(false);
      setBalance(cashAccount.balance.toString());
      setApy(cashAccount.apy.toString());
      setError(null);
      setIsAdjustment(false);
      setEffectiveDate("");
      setSelectedInstitutionId("");
      setNewBankName("");
      setStep("form");
      setIntentChoice("yes");
      setGuardArmed(false);
    } else if (isOpen) {
      setName("");
      setCurrency("EUR");
      setChangingCurrency(false);
      setBalance("");
      setApy("");
      setError(null);
      setIsAdjustment(false);
      setEffectiveDate("");
      setSelectedInstitutionId("");
      setNewBankName("");
      setStep("form");
      setIntentChoice("yes");
      setGuardArmed(false);
    }
  }, [isOpen, cashAccount]);

  /**
   * Core save logic — extracted from handleSubmit so both the form-submit path
   * (create mode / APY-only edit) and the intent-step Continue button can call
   * it directly with the resolved isAdjustment flag.
   */
  async function performSave(isAdj: boolean) {
    setLoading(true);
    setError(null);
    try {
      const parsedBalance = parseFloat(balance);
      if (!Number.isFinite(parsedBalance)) {
        throw new Error("Balance must be a valid number");
      }
      const parsedApy = parseFloat(apy);
      if (!Number.isFinite(parsedApy)) {
        throw new Error("APY must be a valid number");
      }

      // Resolve the parent bank when the picker is shown (standalone "Add Cash"
      // or fixing an orphan). "+ New bank" reuses findOrCreateInstitution, which
      // also grants the bank role implicitly once the cash account links to it.
      let resolvedInstitutionId = institutionId;
      if (showInstitutionPicker) {
        if (selectedInstitutionId === NEW_BANK) {
          const trimmed = newBankName.trim();
          if (!trimmed) throw new Error("Enter a name for the new bank");
          resolvedInstitutionId = await findOrCreateInstitution(trimmed);
        } else if (selectedInstitutionId) {
          resolvedInstitutionId = selectedInstitutionId;
        } else {
          throw new Error("Select a bank for this account");
        }
      }

      if (isEditing) {
        // OMIT `currency` unless the user opened the Change affordance AND
        // actually picked a different code — updateCashAccount routes through
        // partialUpdate, so an omitted key leaves the stored (free-ISO)
        // currency untouched on ordinary balance/APY edits.
        const currencyChanged =
          changingCurrency && currency !== cashAccount.currency;
        const input: CashAccountUpdateInput = {
          balance: parsedBalance,
          apy: parsedApy,
          name: isBankOrigin ? name : undefined,
          ...(currencyChanged ? { currency } : {}),
          // Only set institution when the picker resolved one (fixing an orphan).
          // A normal edit omits it so partialUpdate leaves the existing bank intact.
          ...(showInstitutionPicker ? { institution_id: resolvedInstitutionId } : {}),
        };
        await updateCashAccount(cashAccount.id, input, {
          isAdjustment: isAdj,
          ...(effectiveDate ? { effectiveDate } : {}),
        });
      } else {
        const input: CashAccountCreateInput = {
          institution_id: resolvedInstitutionId,
          currency,
          balance: parsedBalance,
          apy: parsedApy,
          name: isBankOrigin ? name : undefined,
          wallet_id: walletId ?? null,
          broker_id: brokerId ?? null,
        };
        await createCashAccount(input, {
          isAdjustment: isAdj,
          ...(effectiveDate ? { effectiveDate } : {}),
        });
      }
      onClose();
      const adjLabel = isAdj ? " (adjustment)" : "";
      const verb = isEditing ? "updated" : "added";
      const noun = isBankOrigin ? "Bank account" : "Deposit";
      toast.success(`${noun} ${verb}${adjLabel}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Parse numeric inputs up-front to surface errors before any navigation.
    const parsedBalance = parseFloat(balance);
    if (!Number.isFinite(parsedBalance)) {
      setError("Balance must be a valid number");
      return;
    }
    const parsedApy = parseFloat(apy);
    if (!Number.isFinite(parsedApy)) {
      setError("APY must be a valid number");
      return;
    }

    // Edit mode: if the balance changed, ask the intent question instead of
    // saving immediately. APY-only / name-only edits save silently.
    if (isEditing && parsedBalance !== cashAccount.balance) {
      setIntentChoice("yes");
      setGuardArmed(false);
      setStep("intent");
      return;
    }

    await performSave(isEditing ? false : isAdjustment);
  }

  // ─── Intent step values (computed only when step === "intent") ───────────
  // Short-circuited here so approxDeltaValueEur / fmtCurrency are never
  // called in create mode or when the form is still open — avoids spurious
  // [fx] "No rate…" console warnings from a foreign currency with no rate.
  const parsedBalanceForIntent = step === "intent" ? parseFloat(balance) : NaN;
  const delta =
    step === "intent" && isEditing && Number.isFinite(parsedBalanceForIntent)
      ? parsedBalanceForIntent - cashAccount.balance
      : 0;
  const absDelta = Math.abs(delta);
  const approxEur =
    step === "intent"
      ? approxDeltaValueEur({
          kind: "cash",
          absDelta,
          currency: cashAccount?.currency ?? currency,
          fxRates,
        })
      : null;
  // approxEur is the EUR-converted value — the guard always names € (the
  // threshold's currency), never the account symbol (spec §8.11).
  const guardLabel = step === "intent" ? fmtCurrency(approxEur ?? absDelta, "EUR") : "";
  const intentHeader =
    step === "intent"
      ? `On save · ${delta >= 0 ? "+" : ""}${fmtCurrency(delta, cashAccount?.currency ?? currency)}`
      : "";

  return (
    <Modal open={isOpen} onClose={onClose} title={getTitle()}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {step === "intent" && isEditing ? (
          /* ── C3 intent step ─────────────────────────────────────────── */
          <div
            className="space-y-4"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Contain Escape: Back to the form, never closing the host modal.
                // Same containment trio as EditorIntentStep.
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                setStep("form");
              }
            }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              {intentHeader}
            </p>

            <fieldset>
              <legend className="text-sm font-medium text-zinc-200 mb-2">
                {INTENT_COPY.questionCash}
              </legend>

              {/* Yes — the value-bearing primary */}
              <label
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  intentChoice === "yes"
                    ? "border-emerald-500/50 bg-emerald-500/5"
                    : "border-zinc-800"
                }`}
              >
                <input
                  type="radio"
                  name={`${id}-cash-intent`}
                  checked={intentChoice === "yes"}
                  onChange={() => {
                    setIntentChoice("yes");
                    setGuardArmed(false);
                  }}
                  className="mt-0.5 accent-emerald-500"
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-100">{INTENT_COPY.yesCashLabel}</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                      {INTENT_COPY.chipCounts}
                    </span>
                  </span>
                  <span className="block text-[10px] text-zinc-400 mt-0.5">{INTENT_COPY.yesCashSub}</span>
                </span>
              </label>

              {/* No — the subordinate cosmetic escape */}
              <label
                className={`mt-2 flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2 cursor-pointer transition-colors ${
                  intentChoice === "cosmetic"
                    ? "border-zinc-500 bg-zinc-500/5"
                    : "border-zinc-800 opacity-60"
                }`}
              >
                <input
                  type="radio"
                  name={`${id}-cash-intent`}
                  checked={intentChoice === "cosmetic"}
                  onChange={() => {
                    // No disarm needed here — only the Yes path can leave an armed guard behind.
                    setIntentChoice("cosmetic");
                  }}
                  className="mt-0.5 accent-zinc-400"
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-xs text-zinc-300">{INTENT_COPY.noCashLabel}</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-400 border border-zinc-600/40">
                      {INTENT_COPY.chipOffBook}
                    </span>
                  </span>
                </span>
              </label>
            </fieldset>

            {intentChoice === "cosmetic" && guardArmed && (
              <CosmeticConfirm
                amountLabel={guardLabel}
                pending={loading}
                onReal={() => {
                  setIntentChoice("yes");
                  setGuardArmed(false);
                }}
                onProceed={() => void performSave(true)}
              />
            )}

            {error && (
              <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setStep("form")}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Back
              </button>
              {!guardArmed && (
                <button
                  type="button"
                  disabled={loading}
                  aria-busy={loading}
                  onClick={() => {
                    if (intentChoice === "yes") {
                      void performSave(false);
                      return;
                    }
                    if (needsCosmeticConfirm(approxEur)) {
                      setGuardArmed(true);
                      return;
                    }
                    void performSave(true);
                  }}
                  className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
                >
                  Continue
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ── Form step ──────────────────────────────────────────────── */
          <>
            {/* Transfer / Adjustment badge (edit mode only) */}
            {cashAccount?.last_was_transfer && (
              <div className="flex items-center gap-1.5 -mt-2 mb-1">
                <span className="text-[10px] text-teal-400 font-medium" title="Last change was a sell/buy/move transfer">Xfer</span>
                <span className="text-[10px] text-zinc-400">Last changed via transfer</span>
              </div>
            )}
            {!cashAccount?.last_was_transfer && cashAccount?.last_was_adjustment && (
              <div className="flex items-center gap-1.5 -mt-2 mb-1">
                <span className="text-[10px] text-amber-400 font-medium" title={IS_ADJUSTMENT_TOOLTIP_TEXT}>Adj.</span>
                <span className="text-[10px] text-zinc-400">Last saved as portfolio adjustment</span>
              </div>
            )}

            {/* Bank picker — shown when a bank-origin account has no parent bank:
                a context-free "Add Cash", or fixing an existing "Unknown Bank" orphan */}
            {showInstitutionPicker && (
              <div>
                <label htmlFor={`${id}-bank`} className="block text-xs text-zinc-400 mb-1">
                  Bank
                </label>
                <select
                  id={`${id}-bank`}
                  value={selectedInstitutionId}
                  onChange={(e) => setSelectedInstitutionId(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                >
                  <option value="">Select bank…</option>
                  {institutions.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name}
                    </option>
                  ))}
                  <option value={NEW_BANK}>+ New bank…</option>
                </select>
                {selectedInstitutionId === NEW_BANK && (
                  <input
                    type="text"
                    value={newBankName}
                    onChange={(e) => setNewBankName(e.target.value)}
                    placeholder="New bank name (e.g. Alpha Bank)"
                    required
                    className="w-full mt-2 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  />
                )}
              </div>
            )}

            {/* Name field — bank-origin only */}
            {isBankOrigin && (
              <div>
                <label htmlFor={`${id}-name`} className="block text-xs text-zinc-400 mb-1">
                  Account Name
                </label>
                <input
                  id={`${id}-name`}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Savings, Current"
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  required
                />
              </div>
            )}

            {/* Currency + Balance. The account currency is free-ISO (imports and
                transfers create GBP/CHF/... accounts), so the control is the shared
                any-ISO picker. Edit mode shows the stored code read-only with a
                "Change" affordance — the payload then omits `currency` unless it
                was deliberately changed, so a save can never rewrite it. */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                {isEditing && !changingCurrency ? (
                  <>
                    <span className="block text-xs text-zinc-400 mb-1">Currency</span>
                    <div className="flex items-baseline gap-2 py-2.5">
                      <span className="text-sm text-zinc-100">{currency}</span>
                      <button
                        type="button"
                        onClick={() => setChangingCurrency(true)}
                        // Visible text "Change" is contained in the accessible
                        // name (WCAG 2.5.3); the suffix disambiguates the target
                        // for screen-reader users scanning the form.
                        aria-label="Change currency"
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        Change
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label htmlFor={`${id}-currency`} className="block text-xs text-zinc-400 mb-1">
                      Currency
                    </label>
                    <CurrencyCodeSelect
                      id={`${id}-currency`}
                      labelBase="Account"
                      currency={currency}
                      onCurrencyChange={setCurrency}
                      defaultCurrency="EUR"
                    />
                  </>
                )}
              </div>
              <div>
                <label htmlFor={`${id}-balance`} className="block text-xs text-zinc-400 mb-1">
                  {isBankOrigin ? "Balance" : "Amount"}
                </label>
                <input
                  id={`${id}-balance`}
                  type="number"
                  step="0.01"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  required
                />
              </div>
            </div>

            {/* APY */}
            <div>
              <label htmlFor={`${id}-apy`} className="block text-xs text-zinc-400 mb-1">
                APY % <span className="text-zinc-400">(optional)</span>
              </label>
              <input
                id={`${id}-apy`}
                type="number"
                step="0.01"
                value={apy}
                onChange={(e) => setApy(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
            </div>

            {/* Effective date (optional) */}
            <div>
              <label htmlFor={`${id}-effective-date`} className="block text-xs text-zinc-400 mb-1">
                Effective date (optional)
              </label>
              <input
                id={`${id}-effective-date`}
                type="date"
                max={new Date().toISOString().split("T")[0]}
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 text-sm"
              />
              <p className="text-xs text-zinc-400 mt-1">Leave empty to use today&apos;s date</p>
            </div>

            {/* Error display */}
            {error && (
              <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            {/* Adjustment checkbox — CREATE mode only (the opening-balance fork,
                backlog #9, owns its future). Edit mode asks the C3 question. */}
            {!isEditing && (
              <div className="pt-2">
                <IsAdjustmentCheckbox checked={isAdjustment} onChange={setIsAdjustment} idSlug="cash" />
              </div>
            )}

            {/* Footer: action buttons */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
              >
                {loading
                  ? "Saving..."
                  : isEditing
                    ? "Save Changes"
                    : isBankOrigin
                      ? "Add Account"
                      : "Add Deposit"}
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
