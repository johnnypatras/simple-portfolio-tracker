"use client";

import { useState, useEffect, useId, useRef } from "react";
import { Modal } from "@/components/ui/modal";
import { TYPE_GUIDANCE, COST_COPY, MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";
import { fmtCurrency } from "@/lib/format";
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

/**
 * Buy/Sell money-flow routing (C2a). Present ONLY when the modal showed the
 * "Paid with?" / "Proceeds went to?" question (crypto/stock add-mode buy/sell,
 * not manual-NAV). The manager reads this to decide the write path:
 *   - `external` → plain `addTransaction` (S&P contribution/withdrawal)
 *   - `tracked`  → `executeTransfer` against `accountId` (S&P-neutral)
 * Absent → today's behavior (always external for buy, proceeds-exit for sell).
 */
export type MoneyFlow =
  | { route: "external" }
  | { route: "tracked"; accountId: string };

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
  /** Buy/Sell money-flow routing (C2a) — present only when the question showed. */
  moneyFlow?: MoneyFlow;
}

/** A user cash account the Buy/Sell "tracked account" option can route into. */
export interface CashAccountOption {
  id: string;
  name: string;
  balance: number;
  /** ISO 4217 — EUR/USD snap the mini-select; others render a static code. */
  currency: string;
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
  /** The user's tracked cash accounts — feeds the Buy/Sell "tracked account"
   *  routing option (C2a). Empty/undefined → the tracked option is disabled and
   *  the question auto-falls-back to external-only. */
  cashAccountOptions?: CashAccountOption[];
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
  cashAccountOptions,
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

  // ── Money-flow question (C2a) ────────────────────────────────────────────
  // Buy: "Paid with?" · Sell: "Proceeds went to?". `moneyFlowTracked` is the
  // chosen radio (true = route through the transfer machinery against a tracked
  // account; false = plain addTransaction). Defaults to tracked when the user
  // has ≥1 cash account (per the C2a contract); the reset effect re-seeds it.
  // `moneyFlowAccountId` is the chosen account for the tracked path (required —
  // no silent default). The question's VISIBILITY is derived below.
  const hasCashAccounts = (cashAccountOptions?.length ?? 0) > 0;
  const [moneyFlowTracked, setMoneyFlowTracked] = useState(hasCashAccounts);
  const [moneyFlowAccountId, setMoneyFlowAccountId] = useState("");

  // Latest-ref for the async-loaded accounts list. The reset effect reads this
  // (never the prop directly) so a late getCashAccounts resolution can't enter
  // its dep array and re-fire the full-form reset. Written in an effect, never
  // during render.
  const cashAccountOptionsRef = useRef(cashAccountOptions);
  useEffect(() => {
    cashAccountOptionsRef.current = cashAccountOptions;
  }, [cashAccountOptions]);

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
      // Money-flow defaults: tracked when accounts exist (contract), no account
      // pre-selected (the user must choose — no silent default). Reads the
      // accounts list AT OPEN TIME via a ref — see below.
      setMoneyFlowTracked((cashAccountOptionsRef.current?.length ?? 0) > 0);
      setMoneyFlowAccountId("");
    }
    // `cashAccountOptions` is intentionally NOT a dependency: it's an async-loaded
    // list (getCashAccounts resolves any time after the drawer opens) and a new
    // array identity must not re-fire this full-form reset mid-edit — that would
    // wipe quantity/amount/date/etc. The tracked-default above reads the list at
    // open time through cashAccountOptionsRef; accounts that load after the modal
    // is already open do NOT retroactively flip the default or touch any field.
    // (walletOptions/brokerOptions stay identity-stable in the caller, so they're
    // safe as direct deps. The ref is dep-exempt, so exhaustive-deps stays happy
    // without an eslint-disable.)
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

  // ── Money-flow question (C2a) — derived visibility + routing state ────────
  // Shown ONLY for add-mode crypto/stock Buy or Sell, never for cash, yield,
  // deposit/withdrawal, manual-NAV, or edit (editTransaction can't re-route).
  const showMoneyFlow =
    !isEditing &&
    !isManualNav &&
    (assetClass === "crypto" || assetClass === "stock") &&
    (type === "buy" || type === "sell");

  // The account chosen for the tracked route (undefined when none picked yet).
  const selectedAccount =
    showMoneyFlow && moneyFlowTracked
      ? cashAccountOptions?.find((a) => a.id === moneyFlowAccountId)
      : undefined;

  // When the tracked option is active, the cash leg's amount is in THAT
  // account's currency — the EUR/USD mini-select snaps + locks to it (EUR/USD)
  // or is replaced by a static code label (other ISO). lockedCurrency drives
  // both the displayed code and the effective currency emitted on submit.
  const lockedCurrency = selectedAccount?.currency;
  const lockIsEurUsd = lockedCurrency === "EUR" || lockedCurrency === "USD";
  // The currency the Amount actually represents right now.
  const effectiveCurrency: string =
    showMoneyFlow && moneyFlowTracked && lockedCurrency ? lockedCurrency : amountCurrency;

  // Tracked routing needs the cash side's value AND a chosen account — neither
  // the blank-amount market fallback nor a silent default applies here.
  const trackedNeedsAccount = showMoneyFlow && moneyFlowTracked && !selectedAccount;
  const amountNum = parseFloat(amountStr);
  const trackedNeedsAmount =
    showMoneyFlow &&
    moneyFlowTracked &&
    (amountStr.trim() === "" || !Number.isFinite(amountNum) || amountNum <= 0);

  // Overdraft (Buy + tracked): the cash leg can't exceed the account balance.
  // Recomputed from live state every render (never a stored flag) so switching
  // type/account never carries a stale error. Boundary amount == balance is OK.
  const overdraft =
    showMoneyFlow &&
    moneyFlowTracked &&
    type === "buy" &&
    !!selectedAccount &&
    Number.isFinite(amountNum) &&
    amountNum > selectedAccount.balance
      ? selectedAccount
      : null;

  // Computed validation
  const { quantityError, amountError, dateError } = validate(
    type,
    quantityStr,
    amountStr,
    dateStr,
  );

  // Overdraft renders as its OWN role="alert" next to the account select (inside
  // MoneyFlowQuestion) — not in the footer error line — so the user sees it where
  // the cause is. It still blocks Save via isSaveBlocked below.
  const overdraftError = overdraft
    ? MONEY_FLOW_COPY.overdraft(
        fmtCurrency(overdraft.balance, overdraft.currency),
        overdraft.name,
      )
    : null;

  // Footer error line — quantity/amount/date only (overdraft has its own alert).
  const visibleError = quantityError ?? amountError ?? dateError;
  const isSaveBlocked =
    visibleError !== null ||
    type === "transfer" ||
    isTransferLeg ||
    isSplitLocked ||
    isSubmitting ||
    // Tracked-routing dead-ends: no account chosen, no usable amount, overdrawn.
    trackedNeedsAccount ||
    trackedNeedsAmount ||
    overdraftError !== null;

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

    // Money-flow routing (C2a). Tracked → the manager builds a transfer against
    // the chosen account (S&P-neutral); external → today's addTransaction path.
    if (showMoneyFlow) {
      payload.moneyFlow =
        moneyFlowTracked && selectedAccount
          ? { route: "tracked", accountId: selectedAccount.id }
          : { route: "external" };
    }

    // Tracked route: the cash leg's amount is REQUIRED (guarded by isSaveBlocked)
    // and denominated in the account's currency. Emit it as the cashflowOverride
    // so the transfer carries the exact value — the blank-amount market fallback
    // does not apply here. EUR/USD accounts pass through directly; any other ISO
    // currency still flows as the account-currency cost (the transfer machinery
    // handles non-EUR/USD cash sides server-side).
    if (payload.moneyFlow?.route === "tracked") {
      const amt = parseFloat(amountStr);
      if (Number.isFinite(amt)) {
        payload.cashflowOverride = {
          amount: amt,
          // On the tracked route the manager consumes ONLY `.amount`. The
          // `currency` label below is intentionally unused/dead on this path —
          // the cash leg's true currency is resolved server-side by
          // executeTransfer from the account row, so the value here (a best-effort
          // EUR/USD narrowing of the account currency) never reaches the ledger.
          currency: (effectiveCurrency === "USD" ? "USD" : "EUR") as "EUR" | "USD",
        };
        payload.amountUserSet = true;
      }
    } else if (amountDirty && !amountIsBlank) {
      // External route: provenance gate unchanged — only emit cashflowOverride
      // when the user actually typed/edited the amount and it's a finite number.
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

        {/* ── Money-flow question (C2a) ─────────────────────────────
             Buy asks "Paid with?" and Sell asks "Proceeds went to?".
             Answering "tracked account" routes the submit through the transfer
             machinery (S&P-neutral); answering "new money / left portfolio"
             keeps the plain addTransaction path. Crypto/stock add-mode buy/sell
             only; never cash, yield, manual-NAV, or edit. */}
        {showMoneyFlow && (
          <MoneyFlowQuestion
            idBase={`${id}-mf`}
            type={type as "buy" | "sell"}
            tracked={moneyFlowTracked}
            onTrackedChange={setMoneyFlowTracked}
            accounts={cashAccountOptions ?? []}
            accountId={moneyFlowAccountId}
            onAccountChange={setMoneyFlowAccountId}
            amountNum={amountNum}
            currency={effectiveCurrency}
            overdraftError={overdraftError}
            needsAccount={trackedNeedsAccount}
            disabled={isSubmitting}
          />
        )}

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
                  {/* Currency control. Default: free EUR/USD select. When a
                      tracked account is chosen (C2a), the amount is in THAT
                      account's currency — snap+disable the select for EUR/USD,
                      or replace it with a static code label for any other ISO. */}
                  {showMoneyFlow && moneyFlowTracked && lockedCurrency && !lockIsEurUsd ? (
                    <span className="text-xs text-zinc-400" title={MONEY_FLOW_COPY.currencyLockTooltip}>
                      {lockedCurrency}
                    </span>
                  ) : (
                    <select
                      id={`${id}-amount-currency`}
                      value={
                        showMoneyFlow && moneyFlowTracked && lockIsEurUsd
                          ? lockedCurrency
                          : amountCurrency
                      }
                      onChange={(e) =>
                        setAmountCurrency(e.target.value as "EUR" | "USD")
                      }
                      disabled={
                        isTransferLeg ||
                        // Locked to the account currency while tracked is active.
                        (showMoneyFlow && moneyFlowTracked && lockIsEurUsd)
                      }
                      title={
                        showMoneyFlow && moneyFlowTracked && lockIsEurUsd
                          ? MONEY_FLOW_COPY.currencyLockTooltip
                          : undefined
                      }
                      className="text-xs bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Amount currency"
                    >
                      <option value="EUR">EUR</option>
                      <option value="USD">USD</option>
                    </select>
                  )}
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
                  placeholder={
                    showMoneyFlow && moneyFlowTracked
                      ? "0.00"
                      : "Leave blank to use market value"
                  }
                  disabled={isTransferLeg}
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {/* Amount hint. Tracked route REQUIRES the amount (it's the cash
                    leg's value — no market fallback); a blank amount surfaces the
                    required hint instead of the optional one. External route keeps
                    the byte-identical optional / user-set hints. */}
                {trackedNeedsAmount ? (
                  <p className="text-xs text-zinc-400 mt-1">
                    {MONEY_FLOW_COPY.amountRequiredHint(
                      type === "buy" ? "pays" : "receives",
                    )}
                  </p>
                ) : showMoneyFlow && moneyFlowTracked ? (
                  // Tracked + a valid amount: it's the real cost — reuse the
                  // user-set hint (gain/loss + S&P provenance copy).
                  <p className="text-xs text-zinc-400 mt-1">
                    {COST_COPY.amountUserSetHint}
                  </p>
                ) : (
                  <>
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
                  </>
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

// ── Money-flow question (C2a) ──────────────────────────────────────────────────

interface MoneyFlowQuestionProps {
  idBase: string;
  type: "buy" | "sell";
  /** true = "tracked account" radio selected; false = external (new money / left). */
  tracked: boolean;
  onTrackedChange: (tracked: boolean) => void;
  accounts: CashAccountOption[];
  accountId: string;
  onAccountChange: (id: string) => void;
  /** Parsed Amount (NaN when blank) — drives the live effect chip. */
  amountNum: number;
  /** Currency the Amount is in right now (account currency when tracked). */
  currency: string;
  /** Overdraft message (Buy + tracked + amount > balance), already formatted. */
  overdraftError: string | null;
  /** Tracked selected but no account chosen yet → inline required hint. */
  needsAccount: boolean;
  disabled: boolean;
}

/** Renders an S&P-effect chip: the given `text`, colored by `tone`
 *  (plus = emerald, minus = red, neutral = zinc). The wording per route is
 *  decided by each call site. */
function EffectChip({ text, tone }: { text: string; tone: "plus" | "minus" | "neutral" }) {
  const color =
    tone === "plus"
      ? "text-emerald-400"
      : tone === "minus"
        ? "text-red-400"
        : "text-zinc-400";
  return <span className={`text-[10px] ${color} whitespace-nowrap`}>{text}</span>;
}

/**
 * The "Paid with?" (Buy) / "Proceeds went to?" (Sell) radio group. The tracked
 * option routes the submission through the transfer machinery (S&P-neutral); the
 * external option keeps the plain contribution/withdrawal. Self-contained: owns
 * its layout, effect chips, account select, no-accounts fallback, and the
 * account-required + overdraft inline messages. All copy comes from MONEY_FLOW_COPY.
 */
function MoneyFlowQuestion({
  idBase,
  type,
  tracked,
  onTrackedChange,
  accounts,
  accountId,
  onAccountChange,
  amountNum,
  currency,
  overdraftError,
  needsAccount,
  disabled,
}: MoneyFlowQuestionProps) {
  const copy = MONEY_FLOW_COPY[type];
  const hasAccounts = accounts.length > 0;

  // Live external effect chip: `S&P +€X` / `S&P −€X` with a real amount, else
  // the `S&P +contribution` / `S&P −withdrawal` fallback when the Amount is blank.
  const hasAmount = Number.isFinite(amountNum) && amountNum > 0;
  const externalChip = hasAmount
    ? `${copy.externalChipPrefix}${fmtCurrency(amountNum, currency)}`
    : copy.externalChipBlank;
  const externalTone = type === "buy" ? "plus" : "minus";

  // Option ids → the two radios share a `name` so they're a single group.
  const groupName = `${idBase}-route`;
  const externalId = `${idBase}-external`;
  const trackedId = `${idBase}-tracked`;
  const labelId = `${idBase}-label`;

  // Shared row shell. `selected` drives the accent border; disabled rows dim.
  const rowClass = (selected: boolean, rowDisabled: boolean) =>
    `flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
      selected ? "border-blue-500/70 bg-blue-500/5" : "border-zinc-800 bg-zinc-950"
    } ${rowDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`;

  // The external radio row (new money / left the portfolio).
  const externalRow = (
    <label htmlFor={externalId} className={rowClass(!tracked, disabled)}>
      <input
        type="radio"
        id={externalId}
        name={groupName}
        checked={!tracked}
        onChange={() => onTrackedChange(false)}
        disabled={disabled}
        className="mt-0.5 accent-blue-500"
      />
      <span className="flex-1 min-w-0">
        <span className="flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-200">{copy.externalLabel}</span>
          <EffectChip text={externalChip} tone={externalTone} />
        </span>
        <span className="block text-[10px] text-zinc-400 mt-0.5">{copy.externalSub}</span>
      </span>
    </label>
  );

  // The tracked radio row (from / to a tracked account). Disabled with a sub-text
  // when the user has no cash accounts — the dead-end is explained, not silent.
  const trackedRow = (
    <div>
      <label htmlFor={trackedId} className={rowClass(tracked, disabled || !hasAccounts)}>
        <input
          type="radio"
          id={trackedId}
          name={groupName}
          checked={tracked}
          onChange={() => onTrackedChange(true)}
          disabled={disabled || !hasAccounts}
          className="mt-0.5 accent-blue-500"
        />
        <span className="flex-1 min-w-0">
          <span className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-200">{copy.trackedLabel}</span>
            <EffectChip text={copy.trackedChip} tone="neutral" />
          </span>
          {!hasAccounts && (
            <span className="block text-[10px] text-zinc-400 mt-0.5">
              {MONEY_FLOW_COPY.noAccounts}
            </span>
          )}
        </span>
      </label>

      {/* Account select — only while the tracked option is active. REQUIRED
          before save (placeholder, no silent default). */}
      {tracked && hasAccounts && (
        <div className="mt-2 pl-7">
          <select
            id={`${idBase}-account`}
            value={accountId}
            onChange={(e) => onAccountChange(e.target.value)}
            disabled={disabled}
            aria-label="Tracked account"
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">{MONEY_FLOW_COPY.accountPlaceholder}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {fmtCurrency(a.balance, a.currency)}
              </option>
            ))}
          </select>
          {needsAccount && (
            <p className="text-xs text-zinc-400 mt-1">{MONEY_FLOW_COPY.accountRequiredHint}</p>
          )}
          {overdraftError && (
            <p role="alert" className="text-xs text-red-400 mt-1">
              {overdraftError}
            </p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div role="radiogroup" aria-labelledby={labelId}>
      <p id={labelId} className="text-xs text-zinc-400 mb-1.5">
        {copy.question}
      </p>
      <div className="space-y-2">
        {/* Order per contract: Buy = external first, then tracked; Sell = tracked
            first, then external. The DEFAULT selection (tracked when accounts
            exist) is owned by the parent's state, not the row order. */}
        {type === "buy" ? (
          <>
            {externalRow}
            {trackedRow}
          </>
        ) : (
          <>
            {trackedRow}
            {externalRow}
          </>
        )}
      </div>
    </div>
  );
}
