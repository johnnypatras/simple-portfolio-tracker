"use client";

import { useState, useEffect, useId, useRef } from "react";
import { Modal } from "@/components/ui/modal";
import { CurrencyAmountInput } from "@/components/ui/currency-amount-input";
import { TYPE_GUIDANCE, COST_COPY, MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";
import { fmtCurrency } from "@/lib/format";
import { AssetPicker } from "@/components/transactions/asset-picker";
import {
  AssetIdentityStep,
  type AssetIdentityValue,
} from "@/components/transactions/asset-identity-step";
import type { TransactionKind } from "@/lib/transaction-kind";
import type { PickedAsset, WalletType } from "@/lib/types";
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
// Module-local — only referenced by TransactionSubmit.moneyFlow below; no
// external consumer.
type MoneyFlow =
  | { route: "external" }
  | { route: "tracked"; accountId: string };

/** What the modal emits. The amount is SINGLE-currency here; the {usd,eur}
 *  derivation is Task 2.5. */
export interface TransactionSubmit {
  type: TransactionType;
  quantity: number;
  date: string; // "" means "today" — the caller (Task 2.5) defaults it
  /** Present ONLY when the user actually typed/edited the amount →
   *  provenance gate for cashflow_user_set. Its PRESENCE is the provenance
   *  signal: a previously-redundant `amountUserSet` boolean (always
   *  `=== (cashflowOverride !== undefined)`) was removed — consumers test
   *  `cashflowOverride` presence directly. `currency` is any ISO-4217 code
   *  (the server cost boundaries validate + derive both stored legs). */
  cashflowOverride?: { amount: number; currency: string };
  /** Chosen destination wallet (crypto add-mode only — `addTransaction` needs it). */
  walletId?: string;
  /** Chosen destination broker (stock add-mode only — `addTransaction` needs it). */
  brokerId?: string;
  /** Picker-Buy only: user chose "+ New" location instead of an existing one. The
   *  manager creates the wallet/broker. Mutually exclusive with walletId/brokerId. */
  newLocationName?: string;
  /** Picker-Buy crypto only: custody for the new wallet (Exchange|Self-custody).
   *  Omitted → custodial default downstream. */
  walletType?: WalletType;
  /** Buy/Sell money-flow routing (C2a) — present only when the question showed. */
  moneyFlow?: MoneyFlow;
}

/** A user cash account the Buy/Sell "tracked account" option can route into. */
export interface CashAccountOption {
  id: string;
  name: string;
  balance: number;
  /** ISO 4217 — locks the Amount's currency control to the account currency. */
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
  /** Add-mode only: pre-select this transaction type (e.g. "sell" from the
   *  position editor's Sell button). Ignored in edit mode. Falls back to the
   *  first type option when absent. */
  initialType?: TransactionType;
  /** Add-mode only: restrict the Type selector to this subset (toolbar Buy passes
   *  ["buy"]). Absent → all class-appropriate types. */
  allowedTypes?: TransactionType[];
  /** Toolbar-Buy picker mode: when set, the modal renders an asset SEARCH first and
   *  hides the buy fields until `picked` is non-null. The PARENT owns the picked
   *  state (it builds the submit payload). Absent → existing asset-scoped behavior. */
  pickerMode?: {
    picked: PickedAsset | null;
    onAssetPicked: (a: PickedAsset) => void;
    ownedTickers: Set<string>;
    /** New asset that needs an identity-confirm step (1.5) between the pick and
     *  the trade form. Falsy (owned / single-chain) → straight to the form. */
    needsIdentity?: boolean;
    /** Controlled identity value + change handler for the AssetIdentityStep. */
    identityValue?: AssetIdentityValue;
    onIdentityChange?: (v: AssetIdentityValue) => void;
    /** Identity-step datalist seeds (suggested chains, already-used metadata). */
    availableChains?: string[];
    existingChains?: string[];
    existingSubcategories?: string[];
    existingTags?: string[];
    existingAssets?: { coingecko_id: string; chain: string | null }[];
    /** Optional "Not listed?" escape, rendered in the pre-pick search step below
     *  the AssetPicker. When set, a subtle button offers a hand-off (e.g. to the
     *  manual-NAV / illiquid-fund flow). Absent → no link (byte-identical for
     *  existing callers). */
    onNotListed?: () => void;
  };
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
  initialType,
  allowedTypes,
  pickerMode,
  onSubmit,
  onContinueToTransfer,
  onUnsplit,
}: TransactionModalProps) {
  const id = useId();
  // `allowedTypes` filters the RENDERED options only (toolbar Buy passes ["buy"]).
  // It deliberately never enters the reset effect — it'd be a new inline array each
  // render → form-wipe. The effect's default already resolves via `initialType`.
  const allOptions = getTypeOptions(assetClass);
  const typeOptions = allowedTypes
    ? allOptions.filter((t) => allowedTypes.includes(t))
    : allOptions;
  const defaultType = edit ? edit.type : (initialType ?? typeOptions[0]);

  const [type, setType] = useState<TransactionType>(defaultType);
  const [quantityStr, setQuantityStr] = useState(edit ? String(edit.quantity) : "");
  const [amountStr, setAmountStr] = useState(
    edit?.amount != null ? String(edit.amount) : "",
  );
  const [amountDirty, setAmountDirty] = useState(false);
  const [dateStr, setDateStr] = useState(edit?.date ?? "");
  // Any ISO-4217 code (the shared control validates picks/free entry); "EUR"
  // seed matches the pre-any-ISO default.
  const [amountCurrency, setAmountCurrency] = useState<string>(
    edit?.amountCurrency ?? "EUR",
  );
  // Destination selection (add-mode only). Defaults to the first option the
  // caller passed (the asset's existing position wallets/brokers).
  const [walletId, setWalletId] = useState<string>(walletOptions?.[0]?.id ?? "");
  const [brokerId, setBrokerId] = useState<string>(brokerOptions?.[0]?.id ?? "");
  // Picker-Buy "+ New" location (local state — no async identity trap, safe in reset).
  const [creatingNewLocation, setCreatingNewLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState("");
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Per-field touched flags (set on blur). Validation always RUNS (Save stays
  // disabled while invalid) but error text only RENDERS for fields the user has
  // actually visited — a fresh modal must not open with a red "required" alert.
  const [touched, setTouched] = useState({
    quantity: false,
    amount: false,
    date: false,
  });

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
  // Guard: flips true once the user touches the money-flow radios. The
  // settle-effect (below) only seeds the "tracked" default while this is false,
  // so a manual choice is never overridden by late-arriving cash accounts.
  const moneyFlowTouchedRef = useRef(false);

  // ── Identity-confirm step (1.5) ──────────────────────────────────────────
  // For a NEW picker-Buy asset, an identity-confirm step renders BETWEEN the
  // asset pick and the trade form. `identityConfirmed` gates that transition;
  // it's reset only on the pick transition (effect below) — never here, so the
  // money-flow settle-effect is left untouched (see f4365b0).
  const [identityConfirmed, setIdentityConfirmed] = useState(false);

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
      setType(edit ? edit.type : (initialType ?? opts[0]));
      setQuantityStr(edit ? String(edit.quantity) : "");
      setAmountStr(edit?.amount != null ? String(edit.amount) : "");
      setAmountDirty(false);
      setDateStr(edit?.date ?? "");
      setAmountCurrency(edit?.amountCurrency ?? "EUR");
      setWalletId(walletOptions?.[0]?.id ?? "");
      setBrokerId(brokerOptions?.[0]?.id ?? "");
      setCreatingNewLocation(false);
      setNewLocationName("");
      setWalletType("custodial");
      setIsSubmitting(false);
      setTouched({ quantity: false, amount: false, date: false });
      // Money-flow defaults: tracked when accounts exist (contract), no account
      // pre-selected (the user must choose — no silent default). Reads the
      // accounts list AT OPEN TIME via a ref — see below.
      setMoneyFlowTracked((cashAccountOptionsRef.current?.length ?? 0) > 0);
      setMoneyFlowAccountId("");
      moneyFlowTouchedRef.current = false;
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
  }, [isOpen, edit, assetClass, walletOptions, brokerOptions, initialType]);

  // Group C #3: settle the money-flow default to "tracked" once the async cash
  // accounts arrive on the FIRST open (the toolbar Buy path loads them after the
  // modal opens). Narrow + idempotent — it only sets the default, never a form
  // field — so depending on `cashAccountOptions` directly is safe here (unlike the
  // full-reset effect above). The touched guard ensures a manual choice is never
  // overridden, and the money-flow question stays hidden until the user picks an
  // asset, so this settles before it is ever visible (no flicker).
  useEffect(() => {
    if (!isOpen) return;
    if (moneyFlowTouchedRef.current) return;
    if ((cashAccountOptions?.length ?? 0) > 0) setMoneyFlowTracked(true);
  }, [isOpen, cashAccountOptions]);

  // Re-arm the identity gate on the PICK transition AND on every open/close.
  // Keyed on the picked asset's STABLE RAW identity — `ticker` is NOT unique
  // across the asset universe (duplicate crypto symbols; crypto↔stock
  // collisions), so it can't tell two distinct picks apart. We narrow the
  // `PickedAsset.raw` union by presence (mirrors asset-identity-step.tsx):
  // CoinGeckoSearchResult carries `id`, YahooSearchResult carries `symbol`;
  // fall back to `ticker` only if neither exists. The assetClass prefix
  // disambiguates a coin `id` that happens to equal a stock `symbol`. `isOpen`
  // is also a dep so the gate re-arms on close→reopen (TransactionModal never
  // unmounts, so identityConfirmed would otherwise survive) — this does NOT
  // depend on the caller nulling `picked`. Deliberately scoped to picked
  // identity + open state: it does NOT reset `moneyFlowTouchedRef` (re-arming
  // the settle-effect would silently flip a user's deliberate "New money"
  // choice back to tracked — see f4365b0).
  const picked = pickerMode?.picked;
  const pickedKey = picked
    ? `${picked.assetClass}:${
        "id" in picked.raw
          ? picked.raw.id
          : "symbol" in picked.raw
            ? picked.raw.symbol
            : picked.ticker
      }`
    : undefined;
  useEffect(() => {
    setIdentityConfirmed(false);
  }, [pickedKey, isOpen]);

  // Lockdown flags
  const isTransferLeg = edit?.isTransferLeg === true;
  const isSplitLocked = edit?.isSplitChild === true || edit?.isUndone === true;

  // Destination selector visibility: add-mode only (never edit — `editTransaction`
  // can't move a row between positions), non-transfer, and only when the matching
  // options prop is provided for this asset class.
  const isEditing = !!edit;
  // True when an asset has been picked (or there is no picker mode at all).
  const assetPicked = !pickerMode || pickerMode.picked != null;
  // A new asset that still needs its identity confirmed gates the trade form
  // behind the identity step (1.5). Falsy `needsIdentity` (owned / single-chain)
  // → straight to the form, byte-identical to the prior behavior.
  const showIdentityStep =
    !!pickerMode &&
    pickerMode.picked != null &&
    !!pickerMode.needsIdentity &&
    !identityConfirmed;
  // True when the buy/edit form body should show: asset picked AND the identity
  // step is either not needed or already confirmed.
  const pickerReady = assetPicked && !showIdentityStep;
  const showWalletSelect =
    !isEditing &&
    assetClass === "crypto" &&
    type !== "transfer" &&
    ((walletOptions?.length ?? 0) > 0 || !!pickerMode);
  const showBrokerSelect =
    !isEditing &&
    assetClass === "stock" &&
    type !== "transfer" &&
    ((brokerOptions?.length ?? 0) > 0 || !!pickerMode);
  // Picker-Buy with NO existing wallets/brokers → there's nothing to select, so
  // force the "+ New" form open (and hide its Cancel — nothing to go back to).
  const hasLocationOptions =
    assetClass === "crypto"
      ? (walletOptions?.length ?? 0) > 0
      : (brokerOptions?.length ?? 0) > 0;
  const forceNewLocation = !!pickerMode && !hasLocationOptions;
  const isCreatingLocation = creatingNewLocation || forceNewLocation;

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
  // account's currency — the shared control renders it as a locked static code
  // (any ISO, EUR/USD included). lockedCurrency drives both the displayed code
  // and the effective currency emitted on submit.
  const lockedCurrency = selectedAccount?.currency;
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
  // Display is touched-gated; BLOCKING below uses the raw errors so an untouched
  // invalid field still disables Save (correctness and display stay independent).
  const visibleError =
    (touched.quantity ? quantityError : null) ??
    (touched.amount ? amountError : null) ??
    (touched.date ? dateError : null);
  // Picker-Buy: creating a new location but the name is still blank → block Save.
  const newLocationBlocked =
    !!pickerMode && isCreatingLocation && newLocationName.trim() === "";
  const isSaveBlocked =
    quantityError !== null ||
    amountError !== null ||
    dateError !== null ||
    type === "transfer" ||
    isTransferLeg ||
    isSplitLocked ||
    isSubmitting ||
    // Tracked-routing dead-ends: no account chosen, no usable amount, overdrawn.
    trackedNeedsAccount ||
    trackedNeedsAmount ||
    overdraftError !== null ||
    newLocationBlocked;

  // Amount hint: blank vs typed
  const amountIsBlank = amountStr.trim() === "";
  const showOptionalHint = amountIsBlank;
  const showUserSetHint = !amountIsBlank && amountDirty;

  // Title
  const verb = isEditing ? "Edit transaction" : "Add transaction";
  const pickerTitle = pickerMode
    ? pickerMode.picked
      ? `Buy — ${pickerMode.picked.ticker}`
      : `Buy ${assetClass === "crypto" ? "crypto" : "stock"}`
    : null;
  const title = pickerTitle ?? (assetName ? `${verb} — ${assetName}` : verb);

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
    };

    // Destination choice (add-mode only). When the selector is shown, a value is
    // always present (it defaults to the first option), so the caller's
    // addTransaction always gets the wallet/broker it requires.
    if (showWalletSelect) {
      if (pickerMode && isCreatingLocation) {
        payload.newLocationName = newLocationName.trim();
        payload.walletType = walletType;
      } else {
        payload.walletId = walletId;
      }
    }
    if (showBrokerSelect) {
      if (pickerMode && isCreatingLocation) {
        payload.newLocationName = newLocationName.trim();
      } else {
        payload.brokerId = brokerId;
      }
    }

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
    // does not apply here.
    if (payload.moneyFlow?.route === "tracked") {
      const amt = parseFloat(amountStr);
      if (Number.isFinite(amt)) {
        payload.cashflowOverride = {
          amount: amt,
          // Advisory on this route — the manager consumes only `.amount`; the
          // tracked cash leg's currency is resolved server-side from the account row.
          currency: effectiveCurrency,
        };
      }
    } else if (amountDirty && !amountIsBlank) {
      // External route: provenance gate unchanged — only emit cashflowOverride
      // when the user actually typed/edited the amount and it's a finite number.
      const amt = parseFloat(amountStr);
      if (Number.isFinite(amt)) {
        payload.cashflowOverride = { amount: amt, currency: amountCurrency };
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
        {/* ── Toolbar-Buy picker: search step (pre-pick) ── */}
        {pickerMode && !pickerMode.picked && (
          <div className="space-y-3">
            {/* assetClass is "crypto" | "stock" in picker mode — the toolbar Buy
                never opens the picker for cash (cash has no asset to search). */}
            <AssetPicker
              assetClass={assetClass as "crypto" | "stock"}
              ownedTickers={pickerMode.ownedTickers}
              onPick={pickerMode.onAssetPicked}
            />
            {/* "Not listed?" escape (optional) — for an asset the picker can't
                find (e.g. an ELTIF/SICAV/illiquid fund), hand off to the
                manual-NAV flow. Rendered ONLY when the caller wires onNotListed,
                so existing callers stay byte-identical. */}
            {pickerMode.onNotListed && (
              <button
                type="button"
                onClick={pickerMode.onNotListed}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2 transition-colors"
              >
                Not listed? Add a manual-NAV / illiquid fund
              </button>
            )}
            {/* In-body Cancel for parity with every other modal mode. */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {/* ── Selected-asset card (post-pick) ── */}
        {pickerMode && pickerMode.picked && (
          <div className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2">
            <span className="text-sm text-zinc-100 font-medium">
              {pickerMode.picked.ticker}
              <span className="text-xs text-zinc-400 ml-2 font-normal">{pickerMode.picked.name}</span>
            </span>
          </div>
        )}

        {/* ── Identity-confirm step (1.5) ──────────────────────────
             A NEW asset that needs identity confirmation renders here, between
             the pick and the trade form. Continue sets identityConfirmed → the
             form body (below) takes over. assetClass is "crypto" | "stock" in
             picker mode (the toolbar Buy never picks cash). */}
        {showIdentityStep && pickerMode.picked && (
          <div className="space-y-3" role="group" aria-label="Confirm asset details">
            <AssetIdentityStep
              assetClass={assetClass as "crypto" | "stock"}
              picked={pickerMode.picked}
              availableChains={pickerMode.availableChains}
              existingChains={pickerMode.existingChains}
              existingSubcategories={pickerMode.existingSubcategories}
              existingTags={pickerMode.existingTags}
              existingAssets={pickerMode.existingAssets}
              value={pickerMode.identityValue ?? {}}
              onChange={pickerMode.onIdentityChange ?? (() => {})}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setIdentityConfirmed(true)}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* The full buy/edit form — shown only once an asset is chosen (picker mode)
            and its identity confirmed when required, or always (every existing
            caller, where pickerReady defaults true). */}
        {pickerReady && (
          <>
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
            onTrackedChange={(t) => {
              // Both radio onChange handlers route through here — record the
              // manual touch FIRST so the settle-effect never overrides this.
              moneyFlowTouchedRef.current = true;
              setMoneyFlowTracked(t);
            }}
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

        {/* ── Transfer selected with no route-out (e.g. the Accounts-page
            editor's modal has no onContinueToTransfer): not a dead end —
            explain and offer Cancel. ──────────────────────────── */}
        {type === "transfer" && !isTransferLeg && !onContinueToTransfer && (
          <div className="space-y-2">
            <p
              role="alert"
              className="text-sm text-teal-400 bg-teal-400/10 px-3 py-2 rounded-lg"
            >
              {COST_COPY.transferUnavailableHere}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Non-transfer fields ───────────────────────────────── */}
        {type !== "transfer" && !isSplitLocked && (
          <>
            {/* Destination wallet (crypto add-mode). Picker-Buy adds a "+ New"
                affordance with an Exchange | Self-custody toggle. */}
            {showWalletSelect && (
              <div>
                <label
                  htmlFor={`${id}-wallet`}
                  className="block text-xs text-zinc-400 mb-1"
                >
                  Wallet
                </label>
                {pickerMode && isCreatingLocation ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        id={`${id}-wallet`}
                        type="text"
                        value={newLocationName}
                        onChange={(e) => setNewLocationName(e.target.value)}
                        placeholder="New wallet name"
                        className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                      />
                      {!forceNewLocation && (
                        <button
                          type="button"
                          onClick={() => {
                            setCreatingNewLocation(false);
                            setNewLocationName("");
                          }}
                          className="text-xs text-zinc-400 hover:text-zinc-300"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    {/* Exchange | Self-custody toggle (crypto new-wallet only) */}
                    <div className="flex gap-2">
                      {(["custodial", "non_custodial"] as const).map((wt) => {
                        const selected = walletType === wt;
                        const label = wt === "custodial" ? "Exchange" : "Self-custody";
                        const tone = wt === "custodial" ? "text-sky-400" : "text-violet-400";
                        return (
                          <button
                            key={wt}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setWalletType(wt)}
                            className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors ${
                              selected
                                ? "border-blue-500/70 bg-blue-500/5"
                                : "border-zinc-800 bg-zinc-950"
                            } ${selected ? tone : "text-zinc-400"}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <select
                      id={`${id}-wallet`}
                      value={walletId}
                      onChange={(e) => setWalletId(e.target.value)}
                      className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    >
                      {walletOptions!.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    {pickerMode && (
                      <button
                        type="button"
                        onClick={() => setCreatingNewLocation(true)}
                        className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
                      >
                        + New
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Destination broker (stock add-mode). Picker-Buy adds "+ New" — no
                custody toggle (brokers have no custody). */}
            {showBrokerSelect && (
              <div>
                <label
                  htmlFor={`${id}-broker`}
                  className="block text-xs text-zinc-400 mb-1"
                >
                  Broker
                </label>
                {pickerMode && isCreatingLocation ? (
                  <div className="flex items-center gap-2">
                    <input
                      id={`${id}-broker`}
                      type="text"
                      value={newLocationName}
                      onChange={(e) => setNewLocationName(e.target.value)}
                      placeholder="New broker name"
                      className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    />
                    {!forceNewLocation && (
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingNewLocation(false);
                          setNewLocationName("");
                        }}
                        className="text-xs text-zinc-400 hover:text-zinc-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <select
                      id={`${id}-broker`}
                      value={brokerId}
                      onChange={(e) => setBrokerId(e.target.value)}
                      className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    >
                      {brokerOptions!.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                    {pickerMode && (
                      <button
                        type="button"
                        onClick={() => setCreatingNewLocation(true)}
                        className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
                      >
                        + New
                      </button>
                    )}
                  </div>
                )}
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
                onBlur={() => setTouched((t) => ({ ...t, quantity: true }))}
                aria-invalid={touched.quantity && quantityError !== null}
                placeholder="0"
                disabled={isTransferLeg}
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>

            {/* Amount — hidden for yield (cost 0 by definition) */}
            {type !== "yield" && (
              <div>
                {/* Shared any-ISO amount+currency control. When a tracked
                    account is chosen (C2a) the amount is in THAT account's
                    currency: lockedCurrency (already undefined unless the
                    tracked route is active with an account picked) renders a
                    locked static code — any ISO, EUR/USD included. */}
                <CurrencyAmountInput
                  id={`${id}-amount`}
                  label={isManualNav ? "Subscription Amount" : "Amount"}
                  value={{ amountStr, currency: amountCurrency }}
                  onChange={(v) => {
                    if (v.amountStr !== amountStr) {
                      setAmountStr(v.amountStr);
                      setAmountDirty(true);
                    }
                    // While locked, emissions echo the account currency — do
                    // NOT write it into amountCurrency, so the user's own pick
                    // survives a tracked → external switch (the lock never
                    // mutated the select's state before either).
                    if (!lockedCurrency && v.currency !== amountCurrency) {
                      setAmountCurrency(v.currency);
                    }
                  }}
                  defaultCurrency="EUR"
                  lockedCurrency={lockedCurrency}
                  disabled={isTransferLeg}
                  placeholder={
                    showMoneyFlow && moneyFlowTracked
                      ? "0.00"
                      : "Leave blank to use market value"
                  }
                  onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
                  amountAriaInvalid={touched.amount && amountError !== null}
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
                onBlur={() => setTouched((t) => ({ ...t, date: true }))}
                aria-invalid={touched.date && dateError !== null}
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
          </>
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
