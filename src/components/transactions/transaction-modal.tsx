"use client";

import { useState, useEffect, useId } from "react";
import { Modal } from "@/components/ui/modal";
import { TYPE_GUIDANCE, COST_COPY } from "@/lib/cost-basis-copy";
import type { TransactionKind } from "@/lib/transaction-kind";
import {
  validateQuantity,
  validateAmount,
  validatePastOrTodayDate,
} from "@/lib/validation";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TransactionType =
  | "buy"
  | "sell"
  | "yield"
  | "deposit"
  | "withdrawal"
  | "transfer";

/** What the modal emits. The amount is SINGLE-currency here; the {usd,eur}
 *  derivation is Task 2.5. */
export interface TransactionSubmit {
  type: TransactionType;
  quantity: number;
  date: string; // "" means "today" — the caller (Task 2.5) defaults it
  /** Present ONLY when the user actually typed/edited the amount →
   *  provenance gate for cashflow_user_set. */
  cashflowOverride?: { amount: number; currency: "EUR" | "USD" };
  amountUserSet: boolean; // === (cashflowOverride !== undefined)
  /** Chosen destination wallet (crypto add-mode only — `addTransaction` needs it). */
  walletId?: string;
  /** Chosen destination broker (stock add-mode only — `addTransaction` needs it). */
  brokerId?: string;
}

/** Edit-mode seed + lockdown flags. Omit/null = Add mode. */
export interface TransactionEditState {
  type: TransactionType;
  quantity: number;
  amount?: number; // prefilled market or prior user amount
  amountCurrency?: "EUR" | "USD";
  date: string; // YYYY-MM-DD
  isTransferLeg?: boolean; // → transferLegLocked
  isSplitChild?: boolean; // → splitChildLocked
  isUndone?: boolean; // → splitChildLocked (undone entries are not editable)
}

/**
 * Map a drawer row's classified kind → the modal's `TransactionType` when
 * seeding EDIT mode. buy/sell/yield/deposit/withdrawal/transfer pass through;
 * an `adjustment` (which the modal has no type for) is rendered by SIGN +
 * asset class — purely informational, since the type select is disabled in
 * edit mode anyway. `signedQuantity` is the drawer row's signed quantity.
 */
export function kindToModalType(
  kind: TransactionKind,
  signedQuantity: number,
  isCash: boolean,
): TransactionType {
  if (kind === "adjustment") {
    if (signedQuantity > 0) return isCash ? "deposit" : "buy";
    return isCash ? "withdrawal" : "sell";
  }
  return kind;
}

export interface TransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  assetClass: "crypto" | "stock" | "cash";
  assetName?: string; // for the title, e.g. "Add transaction — BTC"
  isManualNav?: boolean; // manual-NAV stock asset: amount = subscription
  edit?: TransactionEditState | null;
  /** Crypto add-mode: the wallets this asset can be added to (defaults to the
   *  first). Rendered as a "Wallet" select; the choice is emitted as walletId. */
  walletOptions?: { id: string; name: string }[];
  /** Stock add-mode: the brokers this asset can be added to (defaults to the
   *  first). Rendered as a "Broker" select; the choice is emitted as brokerId. */
  brokerOptions?: { id: string; name: string }[];
  onSubmit: (value: TransactionSubmit) => Promise<void> | void;
  onContinueToTransfer?: () => void;
  onUnsplit?: () => void;
}

// ── Type options by asset class ────────────────────────────────────────────────

const CRYPTO_STOCK_TYPES: TransactionType[] = ["buy", "sell", "yield", "transfer"];
const CASH_TYPES: TransactionType[] = ["deposit", "withdrawal", "yield", "transfer"];

function getTypeOptions(assetClass: "crypto" | "stock" | "cash"): TransactionType[] {
  return assetClass === "cash" ? CASH_TYPES : CRYPTO_STOCK_TYPES;
}

function typeLabel(t: TransactionType): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Validation helpers ─────────────────────────────────────────────────────────

interface ValidationResult {
  quantityError: string | null;
  amountError: string | null;
  dateError: string | null;
}

function validate(
  type: TransactionType,
  quantityStr: string,
  amountStr: string,
  dateStr: string,
): ValidationResult {
  let quantityError: string | null = null;
  let amountError: string | null = null;
  let dateError: string | null = null;

  // Quantity — always required (except Transfer, which has no qty field)
  if (type !== "transfer") {
    const qty = parseFloat(quantityStr);
    try {
      validateQuantity(qty);
    } catch (err) {
      quantityError = err instanceof Error ? err.message : "Invalid quantity";
    }
  }

  // Amount — only if non-empty (blank is allowed)
  if (type !== "yield" && type !== "transfer" && amountStr.trim() !== "") {
    const amt = parseFloat(amountStr);
    try {
      validateAmount(amt);
    } catch (err) {
      amountError = err instanceof Error ? err.message : "Invalid amount";
    }
  }

  // Date — only validate if a date string is present
  if (dateStr.trim() !== "") {
    try {
      validatePastOrTodayDate(dateStr);
    } catch (err) {
      dateError = err instanceof Error ? err.message : "Invalid date";
    }
  }

  return { quantityError, amountError, dateError };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TransactionModal({
  isOpen,
  onClose,
  assetClass,
  assetName,
  isManualNav = false,
  edit,
  walletOptions,
  brokerOptions,
  onSubmit,
  onContinueToTransfer,
  onUnsplit,
}: TransactionModalProps) {
  const id = useId();
  const typeOptions = getTypeOptions(assetClass);
  const defaultType = edit ? edit.type : typeOptions[0];

  const [type, setType] = useState<TransactionType>(defaultType);
  const [quantityStr, setQuantityStr] = useState(edit ? String(edit.quantity) : "");
  const [amountStr, setAmountStr] = useState(
    edit?.amount != null ? String(edit.amount) : "",
  );
  const [amountDirty, setAmountDirty] = useState(false);
  const [dateStr, setDateStr] = useState(edit?.date ?? "");
  const [amountCurrency, setAmountCurrency] = useState<"EUR" | "USD">(
    edit?.amountCurrency ?? "EUR",
  );
  // Destination selection (add-mode only). Defaults to the first option the
  // caller passed (the asset's existing position wallets/brokers).
  const [walletId, setWalletId] = useState<string>(walletOptions?.[0]?.id ?? "");
  const [brokerId, setBrokerId] = useState<string>(brokerOptions?.[0]?.id ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset state when modal re-opens
  useEffect(() => {
    if (isOpen) {
      const opts = getTypeOptions(assetClass);
      setType(edit ? edit.type : opts[0]);
      setQuantityStr(edit ? String(edit.quantity) : "");
      setAmountStr(edit?.amount != null ? String(edit.amount) : "");
      setAmountDirty(false);
      setDateStr(edit?.date ?? "");
      setAmountCurrency(edit?.amountCurrency ?? "EUR");
      setWalletId(walletOptions?.[0]?.id ?? "");
      setBrokerId(brokerOptions?.[0]?.id ?? "");
      setIsSubmitting(false);
    }
  }, [isOpen, edit, assetClass, walletOptions, brokerOptions]);

  // Lockdown flags
  const isTransferLeg = edit?.isTransferLeg === true;
  const isSplitLocked = edit?.isSplitChild === true || edit?.isUndone === true;

  // Destination selector visibility: add-mode only (never edit — `editTransaction`
  // can't move a row between positions), non-transfer, and only when the matching
  // options prop is provided for this asset class.
  const isEditing = !!edit;
  const showWalletSelect =
    !isEditing &&
    assetClass === "crypto" &&
    type !== "transfer" &&
    (walletOptions?.length ?? 0) > 0;
  const showBrokerSelect =
    !isEditing &&
    assetClass === "stock" &&
    type !== "transfer" &&
    (brokerOptions?.length ?? 0) > 0;

  // Computed validation
  const { quantityError, amountError, dateError } = validate(
    type,
    quantityStr,
    amountStr,
    dateStr,
  );

  const visibleError = quantityError ?? amountError ?? dateError;
  const isSaveBlocked =
    visibleError !== null || type === "transfer" || isTransferLeg || isSplitLocked || isSubmitting;

  // Amount hint: blank vs typed
  const amountIsBlank = amountStr.trim() === "";
  const showOptionalHint = amountIsBlank;
  const showUserSetHint = !amountIsBlank && amountDirty;

  // Title
  const verb = isEditing ? "Edit transaction" : "Add transaction";
  const title = assetName ? `${verb} — ${assetName}` : verb;

  // Today's max date string for the date input
  const todayStr = new Date().toISOString().split("T")[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSaveBlocked || isSubmitting) return;

    const quantity = parseFloat(quantityStr);
    const payload: TransactionSubmit = {
      type,
      quantity,
      date: dateStr,
      amountUserSet: false,
    };

    // Destination choice (add-mode only). When the selector is shown, a value is
    // always present (it defaults to the first option), so the caller's
    // addTransaction always gets the wallet/broker it requires.
    if (showWalletSelect) payload.walletId = walletId;
    if (showBrokerSelect) payload.brokerId = brokerId;

    // Provenance gate: only emit cashflowOverride when the user actually
    // typed/edited the amount (amountDirty=true) and it's a finite number.
    if (amountDirty && !amountIsBlank) {
      const amt = parseFloat(amountStr);
      if (Number.isFinite(amt)) {
        payload.cashflowOverride = { amount: amt, currency: amountCurrency };
        payload.amountUserSet = true;
      }
    }

    setIsSubmitting(true);
    try {
      await onSubmit(payload);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* ── Split-child / undone lockdown ──────────────────────── */}
        {isSplitLocked && (
          <div className="space-y-2">
            <p
              role="alert"
              className="text-sm text-amber-400 bg-amber-400/10 px-3 py-2 rounded-lg"
            >
              {COST_COPY.splitChildLocked}
            </p>
            {onUnsplit && (
              <button
                type="button"
                onClick={onUnsplit}
                className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors"
              >
                Unsplit
              </button>
            )}
          </div>
        )}

        {/* ── Transfer-leg lockdown ──────────────────────────────── */}
        {isTransferLeg && (
          <div className="space-y-2">
            <p
              role="alert"
              className="text-sm text-teal-400 bg-teal-400/10 px-3 py-2 rounded-lg"
            >
              {COST_COPY.transferLegLocked}
            </p>
            {onContinueToTransfer && (
              <button
                type="button"
                onClick={onContinueToTransfer}
                className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors"
              >
                Continue in Transfer →
              </button>
            )}
          </div>
        )}

        {/* ── Type selector ─────────────────────────────────────── */}
        <div>
          <label
            htmlFor={`${id}-type`}
            className="block text-xs text-zinc-400 mb-1"
          >
            Type
          </label>
          <select
            id={`${id}-type`}
            value={type}
            onChange={(e) => setType(e.target.value as TransactionType)}
            disabled={isTransferLeg || isSplitLocked || isEditing}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
          {/* Per-type guidance copy */}
          <p className="text-xs text-zinc-400 mt-1.5">{TYPE_GUIDANCE[type]}</p>
        </div>

        {/* ── Transfer: route-out, no qty/amount fields ─────────── */}
        {type === "transfer" && !isTransferLeg && onContinueToTransfer && (
          <div>
            <button
              type="button"
              onClick={onContinueToTransfer}
              className="w-full px-4 py-2.5 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors"
            >
              Continue in Transfer →
            </button>
          </div>
        )}

        {/* ── Non-transfer fields ───────────────────────────────── */}
        {type !== "transfer" && !isSplitLocked && (
          <>
            {/* Destination wallet (crypto add-mode) */}
            {showWalletSelect && (
              <div>
                <label
                  htmlFor={`${id}-wallet`}
                  className="block text-xs text-zinc-400 mb-1"
                >
                  Wallet
                </label>
                <select
                  id={`${id}-wallet`}
                  value={walletId}
                  onChange={(e) => setWalletId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                >
                  {walletOptions!.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Destination broker (stock add-mode) */}
            {showBrokerSelect && (
              <div>
                <label
                  htmlFor={`${id}-broker`}
                  className="block text-xs text-zinc-400 mb-1"
                >
                  Broker
                </label>
                <select
                  id={`${id}-broker`}
                  value={brokerId}
                  onChange={(e) => setBrokerId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                >
                  {brokerOptions!.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Quantity */}
            <div>
              <label
                htmlFor={`${id}-quantity`}
                className="block text-xs text-zinc-400 mb-1"
              >
                {isManualNav ? "Shares / Units" : "Quantity"}
              </label>
              <input
                id={`${id}-quantity`}
                type="number"
                step="any"
                min="0"
                value={quantityStr}
                onChange={(e) => setQuantityStr(e.target.value)}
                placeholder="0"
                disabled={isTransferLeg}
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>

            {/* Amount — hidden for yield (cost 0 by definition) */}
            {type !== "yield" && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor={`${id}-amount`}
                    className="block text-xs text-zinc-400"
                  >
                    {isManualNav ? "Subscription Amount" : "Amount"}
                  </label>
                  <select
                    id={`${id}-amount-currency`}
                    value={amountCurrency}
                    onChange={(e) =>
                      setAmountCurrency(e.target.value as "EUR" | "USD")
                    }
                    disabled={isTransferLeg}
                    className="text-xs bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Amount currency"
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                <input
                  id={`${id}-amount`}
                  type="text"
                  inputMode="decimal"
                  value={amountStr}
                  onChange={(e) => {
                    setAmountStr(e.target.value);
                    setAmountDirty(true);
                  }}
                  placeholder="Leave blank to use market value"
                  disabled={isTransferLeg}
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {/* Amount hint */}
                {showOptionalHint && (
                  <p className="text-xs text-zinc-400 mt-1">
                    {COST_COPY.amountOptionalHint}
                  </p>
                )}
                {showUserSetHint && (
                  <p className="text-xs text-zinc-400 mt-1">
                    {COST_COPY.amountUserSetHint}
                  </p>
                )}
              </div>
            )}

            {/* Date */}
            <div>
              <label
                htmlFor={`${id}-date`}
                className="block text-xs text-zinc-400 mb-1"
              >
                Date
              </label>
              <input
                id={`${id}-date`}
                type="date"
                max={todayStr}
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                disabled={isTransferLeg}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-zinc-400 mt-1">
                Leave empty to use today&apos;s date
              </p>
            </div>
          </>
        )}

        {/* ── Error / lockdown reason ──────────────────────────── */}
        {visibleError && (
          <p
            role="alert"
            className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg"
          >
            {visibleError}
          </p>
        )}

        {/* ── Footer ──────────────────────────────────────────── */}
        {!isSplitLocked && !isTransferLeg && type !== "transfer" && (
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
              disabled={isSaveBlocked}
              aria-busy={isSubmitting}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
            >
              {isEditing ? "Save Changes" : "Save"}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
