"use client";

import { useMemo, useState } from "react";
import { MONEY_FLOW_COPY } from "@/lib/cost-basis-copy";

export interface CurrencyAmountValue {
  /** Raw input string (caller parses — matches the app's existing amountStr pattern). */
  amountStr: string;
  /** ISO-4217 code, uppercase. */
  currency: string;
}

export interface CurrencyAmountInputProps {
  id: string;
  label: string;
  value: CurrencyAmountValue;
  onChange: (v: CurrencyAmountValue) => void;
  /** Currency to show when value.currency is empty; also first in the shortlist. */
  defaultCurrency: string;
  /** Extra ISO codes for the shortlist (e.g. currencies already used in the portfolio). */
  contextCurrencies?: string[];
  /** When set, the currency is fixed (e.g. a tracked account's currency): render a static code, no selector. */
  lockedCurrency?: string;
  disabled?: boolean;
  /** Amount input placeholder. */
  placeholder?: string;
  /** Small text under the input. */
  hint?: string;
  /** Optional blur hook for touched-tracking in callers. */
  onBlur?: () => void;
}

/** Sentinel option value that swaps the select for the free-entry code input. */
const OTHER_SENTINEL = "__other__";

/**
 * Minimal majors fallback, used ONLY when `Intl.supportedValuesOf` is
 * unavailable (the API ships in Node 24 and all evergreen browsers, but an
 * exotic embedded runtime without it must not break currency entry — better
 * a reduced shortlist than a crash).
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
}: CurrencyAmountInputProps) {
  // "Other…" entry state. `extraCodes` keeps codes committed via Other…
  // visible in the shortlist for the rest of this mount.
  const [customMode, setCustomMode] = useState(false);
  const [customStr, setCustomStr] = useState("");
  const [customError, setCustomError] = useState(false);
  const [extraCodes, setExtraCodes] = useState<string[]>([]);

  // Currency to display: the controlled value, or the default while empty.
  const effectiveCurrency = (value.currency || defaultCurrency).toUpperCase();

  // Shortlist: defaultCurrency, EUR, USD, context codes — uppercased, deduped,
  // in that order. Codes committed via Other… append after; the effective
  // currency appends last if the caller hydrated one outside the shortlist
  // (a controlled <select> whose value has no matching <option> silently
  // shows the wrong selection).
  const shortlist = useMemo(() => {
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
  }, [defaultCurrency, contextCurrencies, extraCodes, effectiveCurrency]);

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
    onChange({ ...value, currency: code });
    revertCustom();
  }

  const compactControlClasses =
    "text-xs bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="block text-xs text-zinc-400">
          {label}
        </label>
        {lockedCurrency ? (
          <span
            className="text-xs text-zinc-400"
            title={MONEY_FLOW_COPY.currencyLockTooltip}
          >
            {lockedCurrency}
          </span>
        ) : customMode ? (
          <input
            id={`${id}-currency`}
            type="text"
            value={customStr}
            maxLength={3}
            autoFocus
            disabled={disabled}
            aria-label="Currency code"
            aria-invalid={customError}
            aria-describedby={customError ? `${id}-currency-error` : undefined}
            onChange={(e) => {
              setCustomStr(e.target.value.toUpperCase());
              setCustomError(false);
            }}
            onBlur={commitCustom}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // keep the enclosing form from submitting
                commitCustom();
              } else if (e.key === "Escape") {
                revertCustom();
              }
            }}
            className={`w-14 uppercase text-zinc-100 placeholder:text-zinc-600 ${compactControlClasses}`}
          />
        ) : (
          <select
            id={`${id}-currency`}
            value={effectiveCurrency}
            disabled={disabled}
            aria-label="Amount currency"
            onChange={(e) => {
              if (e.target.value === OTHER_SENTINEL) {
                setCustomMode(true);
              } else {
                onChange({ ...value, currency: e.target.value });
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
        )}
      </div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value.amountStr}
        onChange={(e) => onChange({ ...value, amountStr: e.target.value })}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {customError && (
        <p
          id={`${id}-currency-error`}
          role="alert"
          className="text-xs text-red-400 mt-1"
        >
          Unknown currency code
        </p>
      )}
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}
