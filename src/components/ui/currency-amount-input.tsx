"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";

export interface CurrencyAmountValue {
  /** Raw input string (caller parses — matches the app's existing amountStr pattern). */
  amountStr: string;
  /**
   * ISO-4217 code, uppercase. May be "" only pre-initialization: the UI then
   * displays `defaultCurrency` as a fallback, but typing an amount never
   * backfills it — callers must seed `currency` (typically `defaultCurrency`
   * or `lockedCurrency`) before submit; the server's `validateCurrency`
   * rejects "" loudly.
   */
  currency: string;
}

export interface CurrencyAmountInputProps {
  id: string;
  label: string;
  value: CurrencyAmountValue;
  onChange: (v: CurrencyAmountValue) => void;
  /**
   * Currency to show when value.currency is empty; also first in the shortlist.
   * Display-only fallback — it is never emitted on its own: callers must seed
   * `value.currency` before submit (see CurrencyAmountValue.currency).
   */
  defaultCurrency: string;
  /** Extra ISO codes for the shortlist (e.g. currencies already used in the portfolio). */
  contextCurrencies?: string[];
  /**
   * When set, the currency is fixed (e.g. a tracked account's currency):
   * render a static code, no selector; also forced into every onChange
   * emission, so the emitted value is always self-consistent with what the
   * user sees.
   */
  lockedCurrency?: string;
  disabled?: boolean;
  /** Amount input placeholder. */
  placeholder?: string;
  /** Small text under the input. */
  hint?: string;
  /** Optional blur hook for touched-tracking in callers. */
  onBlur?: () => void;
  /**
   * Mirrored onto the AMOUNT input's aria-invalid — for hosts with
   * touched-gated validation (the transaction modal). Omitted → no attribute,
   * matching plain cost inputs that carry no validation state.
   */
  amountAriaInvalid?: boolean;
}

/** Sentinel option value that swaps the select for the free-entry code input. */
const OTHER_SENTINEL = "__other__";

/**
 * Minimal majors fallback, used ONLY when `Intl.supportedValuesOf` is
 * unavailable (the API ships in Node 24 and all evergreen browsers, but an
 * exotic embedded runtime without it must not break currency entry — better
 * a reduced accept set, where codes outside these majors are rejected as
 * unknown, than a crash).
 */
const FALLBACK_MAJORS = [
  "EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "SEK", "NOK", "DKK",
  "PLN", "CZK", "HUF", "RON", "BGN", "TRY", "CNY", "HKD", "SGD", "INR",
  "KRW", "BRL", "MXN", "ZAR",
];

let isoCurrencies: ReadonlySet<string> | null = null;

/** Module-level memoized ISO-4217 set (computed once per runtime). */
function getIsoCurrencies(): ReadonlySet<string> {
  if (isoCurrencies === null) {
    try {
      isoCurrencies = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      isoCurrencies = new Set(FALLBACK_MAJORS);
    }
  }
  return isoCurrencies;
}

const compactControlClasses =
  "text-xs bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Shared state + behavior for the currency-code control: "Other…" free entry
 * with ISO validation, committed-code shortlist memory, lock-arrival draft
 * revert, and select focus restore when the free-entry input unmounts. Used
 * by CurrencyAmountInput and the standalone CurrencyCodeSelect.
 *
 * Returns `{ entry, selectRef }` — the ref is deliberately NOT bundled into
 * `entry`: a ref inside a data object flowing through render would taint every
 * member access for the react-hooks/refs rule; kept separate, its only render
 * use is the blessed `ref={selectRef}` attachment.
 */
function useCurrencyEntry({
  lockedCurrency,
  onCommit,
}: {
  lockedCurrency?: string;
  /** Receives a VALID, uppercased ISO code committed via Other…. */
  onCommit: (code: string) => void;
}) {
  // "Other…" entry state. `extraCodes` keeps codes committed via Other…
  // visible in the shortlist for the rest of this mount.
  const [customMode, setCustomMode] = useState(false);
  const [customStr, setCustomStr] = useState("");
  const [customError, setCustomError] = useState(false);
  const [extraCodes, setExtraCodes] = useState<string[]>([]);
  const selectRef = useRef<HTMLSelectElement>(null);

  function revertCustom() {
    setCustomMode(false);
    setCustomStr("");
    setCustomError(false);
  }

  function commitCustom() {
    const code = customStr.trim().toUpperCase();
    if (code === "") {
      revertCustom();
      return;
    }
    if (!getIsoCurrencies().has(code)) {
      setCustomError(true);
      return;
    }
    setExtraCodes((prev) => (prev.includes(code) ? prev : [...prev, code]));
    onCommit(code);
    revertCustom();
  }

  // A lock arriving while Other… entry is open unmounts the selector UI —
  // drop the draft/error so they can't resurface stale after a later unlock.
  // Render-time "adjust state when a prop changes" (same prev-tracking shape
  // as crypto-table's prevPending).
  const [prevLocked, setPrevLocked] = useState(lockedCurrency);
  if (lockedCurrency !== prevLocked) {
    setPrevLocked(lockedCurrency);
    if (lockedCurrency && (customMode || customError)) revertCustom();
  }

  // Focus restore: when the Other… code input unmounts (Enter-commit, Escape,
  // blank-blur revert) focus would drop to <body>; put it on the currency
  // select instead. Fires only on the customMode true→false transition —
  // never on initial mount — and the DOM focus call is the only side effect
  // (no setState here).
  const prevCustomModeRef = useRef(customMode);
  useEffect(() => {
    const wasCustom = prevCustomModeRef.current;
    prevCustomModeRef.current = customMode;
    if (wasCustom && !customMode) selectRef.current?.focus();
  }, [customMode]);

  return {
    entry: {
      customMode,
      setCustomMode,
      customStr,
      setCustomStr,
      customError,
      setCustomError,
      extraCodes,
      revertCustom,
      commitCustom,
    },
    selectRef,
  };
}

type CurrencyEntry = ReturnType<typeof useCurrencyEntry>["entry"];

/**
 * Deduped uppercase shortlist: defaultCurrency, EUR, USD, context codes, codes
 * committed via Other…, and the effective currency last — so a caller-hydrated
 * code outside the shortlist still renders (a controlled <select> whose value
 * has no matching <option> silently shows the wrong selection).
 */
function buildShortlist(
  defaultCurrency: string,
  contextCurrencies: string[] | undefined,
  extraCodes: string[],
  effectiveCurrency: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [
    defaultCurrency,
    "EUR",
    "USD",
    ...(contextCurrencies ?? []),
    ...extraCodes,
    effectiveCurrency,
  ]) {
    const code = raw.trim().toUpperCase();
    if (code === "" || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * The three-way currency control: locked static code | Other… free-entry
 * input | shortlist select. Purely presentational — all state arrives via
 * `entry` (see useCurrencyEntry); the HOST renders the matching
 * "Unknown currency code" alert under `errorId`, choosing its placement.
 */
function CurrencyCodeControl({
  entry,
  selectRef,
  controlId,
  labelBase,
  effectiveCurrency,
  shortlist,
  lockedCurrency,
  disabled,
  errorId,
  onPick,
}: {
  entry: CurrencyEntry;
  /** Attached to the shortlist <select> for the Other…-unmount focus restore. */
  selectRef: React.RefObject<HTMLSelectElement | null>;
  controlId: string;
  /** Accessible-name base: "<labelBase> currency" / "<labelBase> currency code". */
  labelBase: string;
  effectiveCurrency: string;
  shortlist: string[];
  lockedCurrency?: string;
  disabled?: boolean;
  /** id of the host-rendered error paragraph (aria-describedby target). */
  errorId: string;
  /** A code picked directly from the shortlist (Other… commits route via entry.commitCustom). */
  onPick: (code: string) => void;
}) {
  if (lockedCurrency) {
    return (
      <span
        className="text-xs text-zinc-400"
        title={MONEY_FLOW_COPY.currencyLockTooltip}
      >
        {lockedCurrency}
      </span>
    );
  }
  if (entry.customMode) {
    return (
      <input
        id={controlId}
        type="text"
        value={entry.customStr}
        maxLength={3}
        autoFocus
        disabled={disabled}
        aria-label={`${labelBase} currency code`}
        aria-invalid={entry.customError}
        aria-describedby={entry.customError ? errorId : undefined}
        onChange={(e) => {
          entry.setCustomStr(e.target.value.toUpperCase());
          entry.setCustomError(false);
        }}
        onBlur={entry.commitCustom}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault(); // keep the enclosing form from submitting
            entry.commitCustom();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // React tree + non-document roots (jsdom tests)
            e.nativeEvent.stopImmediatePropagation(); // same-node document listeners under App Router (Modal close + focus-trap escapeDeactivates)
            entry.revertCustom();
          }
        }}
        className={`w-14 uppercase text-zinc-100 placeholder:text-zinc-600 ${compactControlClasses}`}
      />
    );
  }
  return (
    <select
      ref={selectRef}
      id={controlId}
      value={effectiveCurrency}
      disabled={disabled}
      aria-label={`${labelBase} currency`}
      onChange={(e) => {
        if (e.target.value === OTHER_SENTINEL) {
          entry.setCustomMode(true);
        } else {
          onPick(e.target.value);
        }
      }}
      className={`text-zinc-400 ${compactControlClasses}`}
    >
      {shortlist.map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
      <option value={OTHER_SENTINEL}>Other…</option>
    </select>
  );
}

/**
 * Shared controlled amount + currency input — the single client surface for
 * any-ISO cost entry (the server boundaries already accept any currency and
 * stamp `original_*`). Pure presentational: the amount string is forwarded
 * raw (callers own parsing/validation, matching the house amountStr pattern);
 * the currency is either locked, picked from a deduped shortlist, or typed
 * as a free ISO code via "Other…".
 */
export function CurrencyAmountInput({
  id,
  label,
  value,
  onChange,
  defaultCurrency,
  contextCurrencies,
  lockedCurrency,
  disabled,
  placeholder,
  hint,
  onBlur,
  amountAriaInvalid,
}: CurrencyAmountInputProps) {
  const { entry, selectRef } = useCurrencyEntry({
    lockedCurrency,
    onCommit: (code) => onChange({ ...value, currency: code }),
  });

  // Currency to display: the controlled value, or the default while empty.
  const effectiveCurrency = (value.currency || defaultCurrency).toUpperCase();

  const shortlist = useMemo(
    () =>
      buildShortlist(
        defaultCurrency,
        contextCurrencies,
        entry.extraCodes,
        effectiveCurrency,
      ),
    [defaultCurrency, contextCurrencies, entry.extraCodes, effectiveCurrency],
  );

  // The amount input is described by the hint and, when present, the currency
  // error — composed so screen readers announce both.
  const amountDescribedBy =
    [hint ? `${id}-hint` : null, entry.customError ? `${id}-currency-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="block text-xs text-zinc-400">
          {label}
        </label>
        <CurrencyCodeControl
          entry={entry}
          selectRef={selectRef}
          controlId={`${id}-currency`}
          labelBase={label}
          effectiveCurrency={effectiveCurrency}
          shortlist={shortlist}
          lockedCurrency={lockedCurrency}
          disabled={disabled}
          errorId={`${id}-currency-error`}
          onPick={(code) => onChange({ ...value, currency: code })}
        />
      </div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value.amountStr}
        onChange={(e) =>
          onChange({
            ...value,
            amountStr: e.target.value,
            currency: lockedCurrency ?? value.currency,
          })
        }
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={amountAriaInvalid}
        aria-describedby={amountDescribedBy}
        className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {entry.customError && (
        <p
          id={`${id}-currency-error`}
          role="alert"
          className="text-xs text-red-400 mt-1"
        >
          Unknown currency code
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-zinc-400 mt-1">
          {hint}
        </p>
      )}
    </div>
  );
}

export interface CurrencyCodeSelectProps {
  /** id for the control element (select / free-entry code input). */
  id: string;
  /**
   * Accessible-name base — the control announces as "<labelBase> currency"
   * (select) / "<labelBase> currency code" (free entry), mirroring
   * CurrencyAmountInput's per-instance labels. Hosts own any visible label.
   */
  labelBase: string;
  /** Controlled ISO code; "" pre-initialization displays defaultCurrency (never emitted on its own). */
  currency: string;
  /** Receives a valid, uppercased ISO code (shortlist pick or Other… commit). */
  onCurrencyChange: (code: string) => void;
  defaultCurrency: string;
  contextCurrencies?: string[];
  lockedCurrency?: string;
  disabled?: boolean;
}

/**
 * Standalone any-ISO currency-code picker for amount-less hosts (the split
 * modal's shared per-leg cost currency; the transfer dialog's cash
 * destination). Same shortlist + "Other…" free-entry behavior as
 * CurrencyAmountInput's control; renders its own "Unknown currency code"
 * alert directly under the control (error id: `${id}-error`).
 */
export function CurrencyCodeSelect({
  id,
  labelBase,
  currency,
  onCurrencyChange,
  defaultCurrency,
  contextCurrencies,
  lockedCurrency,
  disabled,
}: CurrencyCodeSelectProps) {
  const { entry, selectRef } = useCurrencyEntry({ lockedCurrency, onCommit: onCurrencyChange });
  const effectiveCurrency = (currency || defaultCurrency).toUpperCase();
  const shortlist = useMemo(
    () =>
      buildShortlist(
        defaultCurrency,
        contextCurrencies,
        entry.extraCodes,
        effectiveCurrency,
      ),
    [defaultCurrency, contextCurrencies, entry.extraCodes, effectiveCurrency],
  );

  return (
    <div>
      <CurrencyCodeControl
        entry={entry}
        selectRef={selectRef}
        controlId={id}
        labelBase={labelBase}
        effectiveCurrency={effectiveCurrency}
        shortlist={shortlist}
        lockedCurrency={lockedCurrency}
        disabled={disabled}
        errorId={`${id}-error`}
        onPick={onCurrencyChange}
      />
      {entry.customError && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-400 mt-1">
          Unknown currency code
        </p>
      )}
    </div>
  );
}
