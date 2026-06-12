import { convertToBase, type FXRates } from "@/lib/prices/fx";
import { COSMETIC_GUARD_THRESHOLD_EUR } from "@/lib/constants";

/** Inputs for the approximate EUR valuation of a quantity/balance delta. */
export type DeltaValueArgs =
  | { kind: "crypto"; absDelta: number; priceEur: number | undefined }
  | {
      kind: "stock";
      absDelta: number;
      priceNative: number | undefined;
      currency: string;
      fxRates: FXRates | undefined;
    }
  | { kind: "cash"; absDelta: number; currency: string; fxRates: FXRates | undefined };

/**
 * Approximate EUR value of a quantity/balance delta — feeds the editor intent
 * step's "≈ €X" header and the cosmetic guard. Returns null when no usable
 * price exists (unknown value → the gate warns, fail-safe).
 *
 * FX notes: `convertToBase` already returns the amount UNCONVERTED (with a
 * console warn) on a missing/zero rate — the 1:1 fallback is built in, so no
 * guard is added here. Callers pass display-base-keyed fxRates; a USD-display
 * conversion is off by ~the EUR/USD rate — acceptable for a warning threshold
 * (approximate by design; exact for the EUR-display case).
 */
export function approxDeltaValueEur(args: DeltaValueArgs): number | null {
  switch (args.kind) {
    case "crypto":
      return args.priceEur != null && Number.isFinite(args.priceEur)
        ? args.absDelta * args.priceEur
        : null;
    case "stock": {
      if (args.priceNative == null || !Number.isFinite(args.priceNative)) return null;
      const native = args.absDelta * args.priceNative;
      return convertToBase(native, args.currency, "EUR", args.fxRates ?? {});
    }
    case "cash":
      return convertToBase(args.absDelta, args.currency, "EUR", args.fxRates ?? {});
  }
}

/** The gate: null (unknown value) WARNS — over-warning is the safe direction. */
export function needsCosmeticConfirm(valueEur: number | null): boolean {
  return valueEur == null || valueEur >= COSMETIC_GUARD_THRESHOLD_EUR;
}
