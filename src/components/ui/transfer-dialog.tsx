"use client";

import { useState, useEffect, useCallback, useMemo, useId } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { CurrencyCodeSelect } from "@/components/ui/currency-amount-input";
import { toast } from "sonner";
import { executeTransfer } from "@/lib/actions/transfers";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import type {
  TransferMode,
  TransferSide,
  TransferInput,
  Wallet,
  Broker,
  CashAccount,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
} from "@/lib/types";
import { parseWalletChains } from "@/lib/types";

// ─── Destination type tabs ──────────────────────────────────

type DestType =
  | "cash_account"
  | "crypto_position"
  | "stock_position";

const DEST_TABS: { value: DestType; label: string }[] = [
  { value: "cash_account", label: "Cash" },
  { value: "crypto_position", label: "Crypto" },
  { value: "stock_position", label: "Stock" },
];

// ─── Props ──────────────────────────────────────────────────

/** Prefilled source for a Sell/Move launched from a position editor or the
 *  transactions drawer (C2a move-only). Exported so callers can construct it
 *  without re-declaring the shape. */
export interface InitialSide {
  type: "crypto_position" | "stock_position";
  assetId: string;
  assetName: string;
  assetTicker: string;
  locationId: string;
  locationName: string;
  currentQty: number;
  currency: string;
  currentPrice?: number;
  currentPriceUsd?: number;
  currentPriceEur?: number;
}

interface TransferDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  mode: TransferMode;
  initialSource?: InitialSide;
  /** When set, the generic source picker filters to this institution's assets */
  initialInstitutionId?: string;
  /** Pre-select a cash account as destination (sell mode from institution page) */
  initialDestCashId?: string;
}

// ─── Component ──────────────────────────────────────────────

export function TransferDialog({
  open,
  onClose,
  onSuccess,
  mode,
  initialSource,
  initialInstitutionId,
  initialDestCashId,
}: TransferDialogProps) {
  // ── Data state ──
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [cryptoAssets, setCryptoAssets] = useState<CryptoAssetWithPositions[]>([]);
  const [stockAssets, setStockAssets] = useState<StockAssetWithPositions[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // ── Form state ──
  const [sourceQty, setSourceQty] = useState("");
  const [destType, setDestType] = useState<DestType>("cash_account");
  const [destLocationId, setDestLocationId] = useState("");
  const [destCurrency, setDestCurrency] = useState("EUR");
  const [destAmount, setDestAmount] = useState("");
  const [destAmountManual, setDestAmountManual] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  // ── Source picker state (generic transfer — no initialSource) ──
  const [srcLocationId, setSrcLocationId] = useState("");
  const [srcAmount, setSrcAmount] = useState("");

  // For move mode: pick destination location (same asset)
  const [moveLocationId, setMoveLocationId] = useState("");

  // ── Pre-filled side ──
  const prefilled = initialSource;
  const prefilledLabel = prefilled
    ? `${prefilled.assetTicker} on ${prefilled.locationName}`
    : "";
  const needsPicker = mode === "sell" && !prefilled;

  // ── Institution filter (for accounts page transfer button) ──
  const instWalletIds = useMemo(() => {
    if (!initialInstitutionId) return null;
    if (initialInstitutionId.startsWith("__wallet__")) {
      return new Set([initialInstitutionId.replace("__wallet__", "")]);
    }
    return new Set(wallets.filter((w) => w.institution_id === initialInstitutionId).map((w) => w.id));
  }, [initialInstitutionId, wallets]);

  const instBrokerIds = useMemo(() => {
    if (!initialInstitutionId) return null;
    if (initialInstitutionId.startsWith("__wallet__")) return new Set<string>();
    return new Set(brokers.filter((b) => b.institution_id === initialInstitutionId).map((b) => b.id));
  }, [initialInstitutionId, brokers]);

  // ── Load data on mount ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDataLoading(true);
    Promise.all([
      getWallets(),
      getBrokers(),
      getCashAccounts(),
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
    ]).then(([w, b, cash, ca, sa]) => {
      if (cancelled) return;
      setWallets(w ?? []);
      setBrokers(b ?? []);
      setCashAccounts(cash ?? []);
      setCryptoAssets(ca ?? []);
      setStockAssets(sa ?? []);
      setDataLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setDataLoading(false);
        setError("Failed to load data. Please close and try again.");
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  // ── Reset form when dialog opens ──
  useEffect(() => {
    if (!open) return;
    setSourceQty("");
    setDestType("cash_account");
    setDestLocationId("");
    setDestCurrency("EUR");
    setDestAmount("");
    setDestAmountManual(false);
    setMoveLocationId("");
    setEffectiveDate(new Date().toISOString().split("T")[0]);
    setError(null);
    // Source picker reset
    setSrcLocationId("");
    setSrcAmount("");
  }, [open, prefilled?.assetId, prefilled?.locationId, prefilled?.type, prefilled?.currency]);

  // ── Pre-select institution cash as destination (sell mode from accounts page) ──
  useEffect(() => {
    if (!open || !initialDestCashId || dataLoading) return;
    const match = cashAccounts.find((ca) => ca.id === initialDestCashId);
    if (match) {
      setDestType("cash_account");
      setDestLocationId(match.id);
      setDestCurrency(match.currency);
    }
  }, [open, initialDestCashId, dataLoading, cashAccounts]);

  // ── Title ──
  const title = useMemo(() => {
    if (!prefilled) return "Transfer";
    return mode === "sell"
      ? `Sell ${prefilled.assetTicker}`
      : `Move ${prefilled.assetTicker}`;
  }, [mode, prefilled]);

  // ── Source location options (generic picker — flat grouped list) ──
  type SrcOption = { id: string; name: string; available: number; unit: string; group: string };
  const srcGroupedOptions = useMemo(() => {
    if (!needsPicker) return new Map<string, SrcOption[]>();
    const groups = new Map<string, SrcOption[]>();
    const push = (group: string, opt: Omit<SrcOption, "group">) => {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push({ ...opt, group });
    };

    // Crypto positions
    for (const ca of cryptoAssets) {
      for (const p of ca.positions) {
        if (p.quantity <= 0) continue;
        if (instWalletIds && !instWalletIds.has(p.wallet_id)) continue;
        push("Crypto", {
          id: `crypto|${ca.id}|${p.wallet_id}`,
          name: `${ca.ticker} on ${p.wallet_name}`,
          available: p.quantity,
          unit: ca.ticker,
        });
      }
    }

    // Stock positions
    for (const sa of stockAssets) {
      for (const p of sa.positions) {
        if (p.quantity <= 0) continue;
        if (instBrokerIds && !instBrokerIds.has(p.broker_id)) continue;
        push("Stock / ETF", {
          id: `stock|${sa.id}|${p.broker_id}`,
          name: `${sa.ticker} on ${p.broker_name}`,
          available: p.quantity,
          unit: sa.ticker,
        });
      }
    }

    // Cash accounts (unified)
    for (const ca of cashAccounts) {
      if (ca.balance <= 0) continue;
      // Filter by institution for scoped transfers
      if (initialInstitutionId && ca.institution_id !== initialInstitutionId) {
        // Also match via wallet/broker indirection
        if (instWalletIds && ca.wallet_id && !instWalletIds.has(ca.wallet_id)) continue;
        if (instBrokerIds && ca.broker_id && !instBrokerIds.has(ca.broker_id)) continue;
        if (!ca.wallet_id && !ca.broker_id) continue;
      }
      const displayName = ca.wallet_name
        ? `${ca.wallet_name} - ${ca.currency}`
        : ca.broker_name
          ? `${ca.broker_name} - ${ca.currency}`
          : `${ca.name ?? "Account"} (${ca.currency})`;
      push("Cash", {
        id: `cash|${ca.id}`,
        name: displayName,
        available: ca.balance,
        unit: ca.currency,
      });
    }

    return groups;
  }, [needsPicker, cryptoAssets, stockAssets, cashAccounts, instWalletIds, instBrokerIds, initialInstitutionId]);

  const srcSelected = useMemo(() => {
    for (const opts of srcGroupedOptions.values()) {
      const found = opts.find((o) => o.id === srcLocationId);
      if (found) return found;
    }
    return undefined;
  }, [srcGroupedOptions, srcLocationId]);

  // ── Auto-calculate destination amount ──
  const srcIsCash = srcLocationId.startsWith("cash|");
  const autoCalcValue = useMemo(() => {
    // Generic picker: cash→cash mirrors amount directly
    if (needsPicker && srcIsCash) {
      const amt = parseFloat(srcAmount);
      if (!isNaN(amt) && amt > 0 && (destType === "cash_account")) {
        return amt;
      }
    }
    if (!prefilled?.currentPrice) return null;
    const qty = parseFloat(sourceQty);
    if (isNaN(qty) || qty <= 0) return null;

    if (mode === "move") return qty;

    // Asset -> Cash: pick price matching destination currency
    if (
      mode === "sell" &&
      (destType === "cash_account")
    ) {
      const priceForDest =
        destCurrency === "USD" ? (prefilled.currentPriceUsd ?? prefilled.currentPrice) :
        destCurrency === "EUR" ? (prefilled.currentPriceEur ?? prefilled.currentPrice) :
        prefilled.currentPrice;
      return qty * (priceForDest ?? 0);
    }

    return null;
  }, [sourceQty, prefilled?.currentPrice, prefilled?.currentPriceUsd, prefilled?.currentPriceEur, mode, destType, destCurrency, needsPicker, srcIsCash, srcAmount]);

  // Update destination amount when auto-calc changes (only if not manually edited)
  useEffect(() => {
    if (destAmountManual) return;
    if (autoCalcValue !== null) {
      setDestAmount(autoCalcValue.toFixed(2));
    }
  }, [autoCalcValue, destAmountManual]);

  // ── Fee indicator ──
  const feeAmount = useMemo(() => {
    if (!destAmountManual) return null;
    if (autoCalcValue === null) return null;
    const manual = parseFloat(destAmount);
    if (isNaN(manual)) return null;
    const diff = manual - autoCalcValue;
    if (Math.abs(diff) < 0.01) return null;
    return diff;
  }, [destAmountManual, autoCalcValue, destAmount]);

  // ── Build TransferSide for source ──
  const buildSource = useCallback((): TransferSide | null => {
    // ── Generic picker path (type prefix encoded in srcLocationId) ──
    if (needsPicker) {
      if (!srcLocationId) return null;
      const amt = parseFloat(srcAmount);
      if (isNaN(amt) || amt <= 0) return null;
      const parts = srcLocationId.split("|");
      const prefix = parts[0];
      switch (prefix) {
        case "crypto": {
          const [, assetId, walletId] = parts;
          if (!assetId || !walletId) return null;
          return { type: "crypto_position", assetId, walletId, quantity: amt };
        }
        case "stock": {
          const [, assetId, brokerId] = parts;
          if (!assetId || !brokerId) return null;
          return { type: "stock_position", assetId, brokerId, quantity: amt };
        }
        case "cash": {
          const [, accountId] = parts;
          if (!accountId) return null;
          return { type: "cash_account", accountId, amount: amt };
        }
        default:
          return null;
      }
    }
    if (!prefilled) return null;
    const qty = parseFloat(sourceQty);
    if (isNaN(qty) || qty <= 0) return null;

    if (prefilled.type === "crypto_position") {
      return {
        type: "crypto_position",
        assetId: prefilled.assetId,
        walletId: prefilled.locationId,
        quantity: qty,
      };
    }
    return {
      type: "stock_position",
      assetId: prefilled.assetId,
      brokerId: prefilled.locationId,
      quantity: qty,
    };
  }, [prefilled, sourceQty, needsPicker, srcLocationId, srcAmount]);

  // ── Build TransferSide for destination ──
  const buildDest = useCallback((): TransferSide | null => {
    const amt = parseFloat(destAmount);

    if (mode === "move" && prefilled) {
      if (!moveLocationId) return null;
      const qty = parseFloat(sourceQty);
      if (isNaN(qty) || qty <= 0) return null;

      if (prefilled.type === "crypto_position") {
        return {
          type: "crypto_position",
          assetId: prefilled.assetId,
          walletId: moveLocationId,
          quantity: qty,
        };
      }
      return {
        type: "stock_position",
        assetId: prefilled.assetId,
        brokerId: moveLocationId,
        quantity: qty,
      };
    }

    if (isNaN(amt) || amt <= 0) return null;

    switch (destType) {
      case "cash_account": {
        if (!destLocationId) return null;
        return {
          type: "cash_account",
          accountId: destLocationId,
          amount: amt,
        };
      }
      case "crypto_position": {
        if (!destLocationId) return null;
        const [assetId, locId] = destLocationId.split("|");
        if (!assetId || !locId) return null;
        return {
          type: "crypto_position",
          assetId,
          walletId: locId,
          quantity: amt,
        };
      }
      case "stock_position": {
        if (!destLocationId) return null;
        const [assetId, locId] = destLocationId.split("|");
        if (!assetId || !locId) return null;
        return {
          type: "stock_position",
          assetId,
          brokerId: locId,
          quantity: amt,
        };
      }
    }
  }, [
    mode, prefilled, destType, destLocationId, destAmount,
    sourceQty, moveLocationId,
  ]);

  // ── Location options for move mode ──
  const moveLocations = useMemo(() => {
    if (mode !== "move" || !prefilled) return [];
    if (prefilled.type === "crypto_position") {
      // Look up the source asset's chain for compatibility filtering
      const sourceAsset = cryptoAssets.find((a) => a.id === prefilled.assetId);
      const assetChain = sourceAsset?.chain ?? null;

      const others = wallets.filter((w) => w.id !== prefilled.locationId);
      // Filter by chain compatibility: wallets with no chain (multi-chain/exchange)
      // always pass; wallets with a chain must match the asset's chain
      const compatible = assetChain
        ? others.filter((w) => !w.chain || parseWalletChains(w.chain).includes(assetChain))
        : others;

      // Fall back to all wallets if no compatible ones exist
      const result = compatible.length > 0 ? compatible : others;
      return result.map((w) => ({ id: w.id, name: w.name }));
    }
    // Brokers have no chain concept — all are valid destinations for stocks
    return brokers
      .filter((b) => b.id !== prefilled.locationId)
      .map((b) => ({ id: b.id, name: b.name }));
  }, [mode, prefilled, wallets, brokers, cryptoAssets]);

  // ── Destination location options ──
  const destLocationOptions = useMemo(() => {
    switch (destType) {
      case "cash_account":
        return cashAccounts.map((ca) => {
          const displayName = ca.wallet_name
            ? `${ca.wallet_name} - ${ca.currency}`
            : ca.broker_name
              ? `${ca.broker_name} - ${ca.currency}`
              : `${ca.name ?? "Account"} (${ca.institution_name ?? ""}) - ${ca.currency}`;
          return { id: ca.id, name: displayName };
        });
      case "crypto_position": {
        const opts: { id: string; name: string }[] = [];
        for (const ca of cryptoAssets) {
          for (const p of ca.positions) {
            opts.push({
              id: `${ca.id}|${p.wallet_id}`,
              name: `${ca.ticker} on ${p.wallet_name}`,
            });
          }
          // Also show chain-compatible wallets without positions for this asset
          const compatibleWallets = ca.chain
            ? wallets.filter((w) => !w.chain || parseWalletChains(w.chain).includes(ca.chain!))
            : wallets;
          for (const w of compatibleWallets) {
            const hasPos = ca.positions.some((p) => p.wallet_id === w.id);
            if (!hasPos) {
              opts.push({
                id: `${ca.id}|${w.id}`,
                name: `${ca.ticker} on ${w.name} (new)`,
              });
            }
          }
        }
        return opts;
      }
      case "stock_position": {
        const opts: { id: string; name: string }[] = [];
        for (const sa of stockAssets) {
          for (const p of sa.positions) {
            opts.push({
              id: `${sa.id}|${p.broker_id}`,
              name: `${sa.ticker} on ${p.broker_name}`,
            });
          }
          for (const b of brokers) {
            const hasPos = sa.positions.some((p) => p.broker_id === b.id);
            if (!hasPos) {
              opts.push({
                id: `${sa.id}|${b.id}`,
                name: `${sa.ticker} on ${b.name} (new)`,
              });
            }
          }
        }
        return opts;
      }
    }
  }, [destType, brokers, wallets, cashAccounts, cryptoAssets, stockAssets]);

  // ── Execute ──
  async function handleExecute() {
    setError(null);

    const source = mode === "sell" || mode === "move" ? buildSource() : null;
    const dest = buildDest();

    if (!source) {
      setError("Invalid source configuration");
      return;
    }
    if (!dest) {
      setError("Invalid destination configuration");
      return;
    }

    setExecuting(true);
    try {
      const input: TransferInput = {
        mode,
        source,
        destination: dest,
        effectiveDate: effectiveDate || undefined,
      };
      const result = await executeTransfer(input);
      if (result.success) {
        toast.success(
          mode === "move"
            ? `Moved ${prefilled?.assetTicker ?? "asset"} successfully`
            : `Transfer completed successfully`
        );
        onSuccess?.();
        onClose();
      } else {
        setError(result.error);
        if (result.partialFailure) {
          toast.error("Partial failure - check your positions");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setExecuting(false);
    }
  }

  // ── Can submit? ──
  const canSubmit = useMemo(() => {
    if (executing) return false;
    return buildSource() !== null && buildDest() !== null;
  }, [executing, buildSource, buildDest]);

  // ── Render ──
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {dataLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          <span className="ml-2 text-sm text-zinc-400">Loading...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── FROM section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
              From
            </span>
            {(mode === "sell" || mode === "move") && prefilled && (
              <>
                <div className="text-sm text-zinc-200">{prefilledLabel}</div>
                <div>
                  <label htmlFor={`${id}-src-qty`} className="block text-xs text-zinc-400 mb-1">
                    Quantity
                  </label>
                  <input
                    id={`${id}-src-qty`}
                    type="number"
                    step="any"
                    min="0"
                    max={prefilled.currentQty}
                    value={sourceQty}
                    onChange={(e) => {
                      setSourceQty(e.target.value);
                      setDestAmountManual(false);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  />
                  <div className="text-xs text-zinc-400 mt-1">
                    Available: {prefilled.currentQty} {prefilled.assetTicker}
                    {prefilled.currentPrice
                      ? ` (~${prefilled.currency} ${(prefilled.currentQty * prefilled.currentPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})`
                      : ""}
                  </div>
                </div>
              </>
            )}
            {needsPicker && (
              <>
                {/* Single grouped source dropdown */}
                <div>
                  <label htmlFor={`${id}-src-location`} className="block text-xs text-zinc-400 mb-1">
                    Position / Account
                  </label>
                  <select
                    id={`${id}-src-location`}
                    value={srcLocationId}
                    onChange={(e) => {
                      setSrcLocationId(e.target.value);
                      setSrcAmount("");
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  >
                    <option value="">Select source...</option>
                    {Array.from(srcGroupedOptions.entries()).map(([group, opts]) => (
                      <optgroup key={group} label={group}>
                        {opts.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.name} ({opt.available.toLocaleString(undefined, { maximumFractionDigits: 18 })} {opt.unit})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {srcGroupedOptions.size === 0 && (
                    <p className="text-xs text-zinc-400 mt-1">No positions with balance found</p>
                  )}
                </div>

                {/* Amount / Quantity input — only shown after selection */}
                {srcSelected && (
                  <div>
                    <label htmlFor={`${id}-src-amount`} className="block text-xs text-zinc-400 mb-1">
                      {srcIsCash ? "Amount" : "Quantity"}
                    </label>
                    <input
                      id={`${id}-src-amount`}
                      type="number"
                      step="any"
                      min="0"
                      max={srcSelected.available}
                      value={srcAmount}
                      onChange={(e) => {
                        setSrcAmount(e.target.value);
                        setDestAmountManual(false);
                      }}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    />
                    <div className="text-xs text-zinc-400 mt-1">
                      Available: {srcSelected.available.toLocaleString(undefined, { maximumFractionDigits: 18 })} {srcSelected.unit}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Arrow divider ── */}
          <div className="flex items-center justify-center gap-2">
            <div className="h-px flex-1 bg-zinc-800" />
            <ArrowDown className="w-4 h-4 text-zinc-400" />
            {autoCalcValue !== null && mode !== "move" && (
              <span className="text-xs text-zinc-400">
                ~{parseFloat(destAmount || "0").toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {" "}{destCurrency}
              </span>
            )}
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          {/* ── TO section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            {mode === "move" ? (
              <>
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
                  To
                </span>
                <div className="text-sm text-zinc-300">
                  {prefilled?.assetTicker} (same asset, different location)
                </div>
                <div>
                  <label htmlFor={`${id}-move-location`} className="block text-xs text-zinc-400 mb-1">
                    New {prefilled?.type === "crypto_position" ? "Wallet" : "Broker"}
                  </label>
                  <select
                    id={`${id}-move-location`}
                    value={moveLocationId}
                    onChange={(e) => setMoveLocationId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  >
                    <option value="">Select...</option>
                    {moveLocations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <>
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
                  To
                </span>

                {/* Destination type tabs */}
                <div className="flex flex-wrap gap-1">
                  {DEST_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      onClick={() => {
                        setDestType(tab.value);
                        setDestLocationId("");
                        setDestAmountManual(false);
                      }}
                      className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                        destType === tab.value
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Location picker */}
                <div>
                  <label htmlFor={`${id}-dest-location`} className="block text-xs text-zinc-400 mb-1">
                    {"Location"}
                  </label>
                  <select
                    id={`${id}-dest-location`}
                    value={destLocationId}
                    onChange={(e) => setDestLocationId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  >
                    <option value="">Select...</option>
                    {destLocationOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Currency for cash destinations */}
                {destType === "cash_account" && (
                  <div>
                    <label htmlFor={`${id}-dest-currency`} className="block text-xs text-zinc-400 mb-1">
                      Currency
                    </label>
                    {/* Cash proceeds are free-ISO — shared any-ISO picker
                        (announces as "Destination currency"), replacing the
                        old hardcoded EUR/USD/GBP/CHF list. */}
                    <CurrencyCodeSelect
                      id={`${id}-dest-currency`}
                      labelBase="Destination"
                      currency={destCurrency}
                      onCurrencyChange={setDestCurrency}
                      defaultCurrency="EUR"
                    />
                  </div>
                )}

                {/* Amount / quantity */}
                <div>
                  <label htmlFor={`${id}-dest-amount`} className="block text-xs text-zinc-400 mb-1">
                    {destType === "crypto_position" || destType === "stock_position"
                      ? "Quantity"
                      : "Amount"}
                  </label>
                  <input
                    id={`${id}-dest-amount`}
                    type="number"
                    step="any"
                    min="0"
                    value={destAmount}
                    onChange={(e) => {
                      setDestAmount(e.target.value);
                      setDestAmountManual(true);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  />
                </div>
              </>
            )}
          </div>

          {/* ── Date picker ── */}
          <div>
            <label htmlFor={`${id}-date`} className="block text-xs text-zinc-400 mb-1">Date</label>
            <input
              id={`${id}-date`}
              type="date"
              value={effectiveDate}
              max={new Date().toISOString().split("T")[0]}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
          </div>

          {/* ── Fee indicator ── */}
          {feeAmount !== null && (
            <p className="text-xs text-amber-400">
              Fee / difference: {feeAmount > 0 ? "+" : ""}
              {feeAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {" "}{destCurrency}
            </p>
          )}

          {/* ── Error ── */}
          {error && (
            <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={!canSubmit}
              aria-busy={executing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {executing && <Loader2 className="w-4 h-4 animate-spin" />}
              Execute Transfer
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
