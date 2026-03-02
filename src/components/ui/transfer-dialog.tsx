"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { executeTransfer } from "@/lib/actions/transfers";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import type {
  TransferMode,
  TransferSide,
  TransferInput,
  Wallet,
  Broker,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
} from "@/lib/types";

// ─── Destination type tabs ──────────────────────────────────

type DestType =
  | "broker_deposit"
  | "exchange_deposit"
  | "bank_account"
  | "crypto_position"
  | "stock_position";

const DEST_TABS: { value: DestType; label: string }[] = [
  { value: "broker_deposit", label: "Broker Cash" },
  { value: "exchange_deposit", label: "Exchange Cash" },
  { value: "bank_account", label: "Bank" },
  { value: "crypto_position", label: "Crypto" },
  { value: "stock_position", label: "Stock" },
];

// ─── Props ──────────────────────────────────────────────────

interface InitialSide {
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
  initialDestination?: InitialSide;
}

// ─── Component ──────────────────────────────────────────────

export function TransferDialog({
  open,
  onClose,
  onSuccess,
  mode,
  initialSource,
  initialDestination,
}: TransferDialogProps) {
  // ── Data state ──
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [exchangeDeposits, setExchangeDeposits] = useState<ExchangeDeposit[]>([]);
  const [brokerDeposits, setBrokerDeposits] = useState<BrokerDeposit[]>([]);
  const [cryptoAssets, setCryptoAssets] = useState<CryptoAssetWithPositions[]>([]);
  const [stockAssets, setStockAssets] = useState<StockAssetWithPositions[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // ── Form state ──
  const [sourceQty, setSourceQty] = useState("");
  const [destType, setDestType] = useState<DestType>("broker_deposit");
  const [destLocationId, setDestLocationId] = useState("");
  const [destCurrency, setDestCurrency] = useState("EUR");
  const [destAmount, setDestAmount] = useState("");
  const [destAmountManual, setDestAmountManual] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For move mode: pick destination location (same asset)
  const [moveLocationId, setMoveLocationId] = useState("");

  // ── Pre-filled side ──
  const prefilled = mode === "buy" ? initialDestination : initialSource;
  const prefilledLabel = prefilled
    ? `${prefilled.assetTicker} on ${prefilled.locationName}`
    : "";

  // ── Load data on mount ──
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDataLoading(true);
    Promise.all([
      getWallets(),
      getBrokers(),
      getBankAccounts(),
      getExchangeDeposits(),
      getBrokerDeposits(),
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
    ]).then(([w, b, ba, ed, bd, ca, sa]) => {
      if (cancelled) return;
      setWallets(w ?? []);
      setBrokers(b ?? []);
      setBankAccounts(ba ?? []);
      setExchangeDeposits(ed ?? []);
      setBrokerDeposits(bd ?? []);
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
    setSourceQty(prefilled?.currentQty?.toString() ?? "");
    setDestType("broker_deposit");
    setDestLocationId("");
    setDestCurrency("EUR");
    setDestAmount("");
    setDestAmountManual(false);
    setMoveLocationId("");
    setError(null);
  }, [open, prefilled?.assetId, prefilled?.locationId]);

  // ── Title ──
  const title = useMemo(() => {
    const name = prefilled?.assetTicker ?? "Asset";
    switch (mode) {
      case "sell": return `Sell ${name}`;
      case "buy": return `Buy ${name}`;
      case "move": return `Move ${name}`;
    }
  }, [mode, prefilled?.assetTicker]);

  // ── Auto-calculate destination amount ──
  const autoCalcValue = useMemo(() => {
    if (!prefilled?.currentPrice) return null;
    const qty = parseFloat(sourceQty);
    if (isNaN(qty) || qty <= 0) return null;

    if (mode === "move") return qty;

    // Asset -> Cash: pick price matching destination currency
    if (
      mode === "sell" &&
      (destType === "broker_deposit" || destType === "exchange_deposit" || destType === "bank_account")
    ) {
      const priceForDest =
        destCurrency === "USD" ? (prefilled.currentPriceUsd ?? prefilled.currentPrice) :
        destCurrency === "EUR" ? (prefilled.currentPriceEur ?? prefilled.currentPrice) :
        prefilled.currentPrice;
      return qty * (priceForDest ?? 0);
    }

    return null;
  }, [sourceQty, prefilled?.currentPrice, prefilled?.currentPriceUsd, prefilled?.currentPriceEur, mode, destType, destCurrency]);

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
  }, [prefilled, sourceQty]);

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
      case "broker_deposit": {
        if (!destLocationId) return null;
        return {
          type: "broker_deposit",
          brokerId: destLocationId,
          currency: destCurrency,
          amount: amt,
        };
      }
      case "exchange_deposit": {
        if (!destLocationId) return null;
        return {
          type: "exchange_deposit",
          walletId: destLocationId,
          currency: destCurrency,
          amount: amt,
        };
      }
      case "bank_account": {
        if (!destLocationId) return null;
        return {
          type: "bank_account",
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
    mode, prefilled, destType, destLocationId, destCurrency, destAmount,
    sourceQty, moveLocationId,
  ]);

  // ── Location options for move mode ──
  const moveLocations = useMemo(() => {
    if (mode !== "move" || !prefilled) return [];
    if (prefilled.type === "crypto_position") {
      return wallets
        .filter((w) => w.id !== prefilled.locationId)
        .map((w) => ({ id: w.id, name: w.name }));
    }
    return brokers
      .filter((b) => b.id !== prefilled.locationId)
      .map((b) => ({ id: b.id, name: b.name }));
  }, [mode, prefilled, wallets, brokers]);

  // ── Destination location options ──
  const destLocationOptions = useMemo(() => {
    switch (destType) {
      case "broker_deposit":
        return brokers.map((b) => ({ id: b.id, name: b.name }));
      case "exchange_deposit":
        return wallets
          .filter((w) => w.wallet_type === "custodial")
          .map((w) => ({ id: w.id, name: w.name }));
      case "bank_account":
        return bankAccounts.map((ba) => ({
          id: ba.id,
          name: `${ba.name} (${ba.bank_name}) - ${ba.currency}`,
        }));
      case "crypto_position": {
        const opts: { id: string; name: string }[] = [];
        for (const ca of cryptoAssets) {
          for (const p of ca.positions) {
            opts.push({
              id: `${ca.id}|${p.wallet_id}`,
              name: `${ca.ticker} on ${p.wallet_name}`,
            });
          }
          // Also show wallets without positions for this asset
          for (const w of wallets) {
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
  }, [destType, brokers, wallets, bankAccounts, cryptoAssets, stockAssets]);

  // ── Execute ──
  async function handleExecute() {
    setError(null);
    const source = mode === "sell" || mode === "move" ? buildSource() : null;
    const dest = buildDest();

    // For buy mode, source comes from destination section (the cash side)
    // For now, only sell and move are fully supported
    if (mode === "buy") {
      setError("Buy mode is not yet fully implemented");
      return;
    }

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
    if (executing || mode === "buy") return false;
    return buildSource() !== null && buildDest() !== null;
  }, [executing, mode, buildSource, buildDest]);

  // ── Render ──
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {dataLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
          <span className="ml-2 text-sm text-zinc-500">Loading...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── FROM section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
              From
            </span>
            {(mode === "sell" || mode === "move") && prefilled && (
              <>
                <div className="text-sm text-zinc-200">{prefilledLabel}</div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    Quantity
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    max={prefilled.currentQty}
                    value={sourceQty}
                    onChange={(e) => {
                      setSourceQty(e.target.value);
                      setDestAmountManual(false);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  />
                  <div className="text-xs text-zinc-600 mt-1">
                    Available: {prefilled.currentQty} {prefilled.assetTicker}
                    {prefilled.currentPrice
                      ? ` (~${prefilled.currency} ${(prefilled.currentQty * prefilled.currentPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })})`
                      : ""}
                  </div>
                </div>
              </>
            )}
            {mode === "buy" && (
              <p className="text-sm text-zinc-400">
                Select the source of funds in the destination section below.
              </p>
            )}
          </div>

          {/* ── Arrow divider ── */}
          <div className="flex items-center justify-center gap-2">
            <div className="h-px flex-1 bg-zinc-800" />
            <ArrowDown className="w-4 h-4 text-zinc-500" />
            {autoCalcValue !== null && mode !== "move" && (
              <span className="text-xs text-zinc-400">
                ~{parseFloat(destAmount || "0").toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {" "}{destType === "bank_account" ? "" : destCurrency}
              </span>
            )}
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          {/* ── TO section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
              To
            </span>

            {mode === "move" ? (
              <>
                <div className="text-sm text-zinc-300">
                  {prefilled?.assetTicker} (same asset, different location)
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    New {prefilled?.type === "crypto_position" ? "Wallet" : "Broker"}
                  </label>
                  <select
                    value={moveLocationId}
                    onChange={(e) => setMoveLocationId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
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
                  <label className="block text-xs text-zinc-500 mb-1">
                    {destType === "bank_account" ? "Account" : "Location"}
                  </label>
                  <select
                    value={destLocationId}
                    onChange={(e) => setDestLocationId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
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
                {(destType === "broker_deposit" || destType === "exchange_deposit") && (
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">
                      Currency
                    </label>
                    <select
                      value={destCurrency}
                      onChange={(e) => setDestCurrency(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    >
                      {["EUR", "USD", "GBP", "CHF"].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Amount / quantity */}
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    {destType === "crypto_position" || destType === "stock_position"
                      ? "Quantity"
                      : "Amount"}
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={destAmount}
                    onChange={(e) => {
                      setDestAmount(e.target.value);
                      setDestAmountManual(true);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  />
                </div>
              </>
            )}
          </div>

          {/* ── Fee indicator ── */}
          {feeAmount !== null && (
            <p className="text-xs text-amber-400">
              Fee / difference: {feeAmount > 0 ? "+" : ""}
              {feeAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {" "}{destType === "bank_account" ? "" : destCurrency}
            </p>
          )}

          {/* ── Error ── */}
          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={!canSubmit}
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
