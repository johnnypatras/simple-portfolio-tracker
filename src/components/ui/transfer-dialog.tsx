"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowDown, Loader2, Search } from "lucide-react";
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
  YahooSearchResult,
  CoinGeckoSearchResult,
  StockAssetInput,
  CryptoAssetInput,
  AssetCategory,
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

/** Strip exchange suffix: VWCE.DE → VWCE */
function extractBaseTicker(symbol: string): string {
  const dot = symbol.indexOf(".");
  return dot > 0 ? symbol.slice(0, dot) : symbol;
}

/** Infer asset category from Yahoo quoteType */
function inferCategory(quoteType: string): AssetCategory {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "EQUITY") return "individual_stock";
  return "other";
}

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
  const [effectiveDate, setEffectiveDate] = useState("");
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Buy mode state ──
  const [buyAssetType, setBuyAssetType] = useState<"stock" | "crypto">("stock");
  const [buySearchQuery, setBuySearchQuery] = useState("");
  const [buySearchResults, setBuySearchResults] = useState<(YahooSearchResult | CoinGeckoSearchResult)[]>([]);
  const [buySearching, setBuySearching] = useState(false);
  const buyDebounceRef = useRef<NodeJS.Timeout>(null);
  const [buySelectedAsset, setBuySelectedAsset] = useState<YahooSearchResult | CoinGeckoSearchResult | null>(null);
  const [buyAssetCurrency, setBuyAssetCurrency] = useState("USD");
  const [buyLocationId, setBuyLocationId] = useState("");
  const [buyNewLocationName, setBuyNewLocationName] = useState("");
  const [buyCreatingNew, setBuyCreatingNew] = useState(false);
  const [buyQuantity, setBuyQuantity] = useState("");
  const [buyDetectingChain, setBuyDetectingChain] = useState(false);
  const [buyDetectedChain, setBuyDetectedChain] = useState<string | null>(null);
  const [buyDetectedSubcategory, setBuyDetectedSubcategory] = useState<string | null>(null);

  // ── Cash tracking state ──
  type CashState = "auto" | "prompt" | "skipped";
  const [cashState, setCashState] = useState<CashState>("prompt");
  const [cashBalance, setCashBalance] = useState("");
  const [cashIsAdjustment, setCashIsAdjustment] = useState(true);
  const [existingCashAmount, setExistingCashAmount] = useState<number | null>(null);

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
    setEffectiveDate(new Date().toISOString().split("T")[0]);
    setError(null);
    // Buy mode reset
    setBuyAssetType("stock");
    setBuySearchQuery("");
    setBuySearchResults([]);
    setBuySelectedAsset(null);
    setBuyAssetCurrency("USD");
    setBuyLocationId("");
    setBuyNewLocationName("");
    setBuyCreatingNew(false);
    setBuyQuantity("");
    setBuyDetectingChain(false);
    setBuyDetectedChain(null);
    setBuyDetectedSubcategory(null);
    setCashState("prompt");
    setCashBalance("");
    setCashIsAdjustment(true);
    setExistingCashAmount(null);
  }, [open, prefilled?.assetId, prefilled?.locationId]);

  // ── Title ──
  const title = useMemo(() => {
    if (mode === "buy") {
      if (prefilled?.assetTicker) return `Buy ${prefilled.assetTicker}`;
      if (buySelectedAsset) {
        const sym = buySelectedAsset.symbol;
        return `Buy ${sym.toUpperCase()}`;
      }
      return "Record Buy";
    }
    const name = prefilled?.assetTicker ?? "Asset";
    switch (mode) {
      case "sell": return `Sell ${name}`;
      case "move": return `Move ${name}`;
    }
  }, [mode, prefilled?.assetTicker, buySelectedAsset]);

  // ── Buy mode: debounced asset search ──
  useEffect(() => {
    if (mode !== "buy" || buySearchQuery.length < 2) {
      setBuySearchResults([]);
      return;
    }
    setBuySearching(true);
    if (buyDebounceRef.current) clearTimeout(buyDebounceRef.current);

    buyDebounceRef.current = setTimeout(async () => {
      try {
        const endpoint = buyAssetType === "stock"
          ? `/api/stocks/search?q=${encodeURIComponent(buySearchQuery)}`
          : `/api/crypto/search?q=${encodeURIComponent(buySearchQuery)}`;
        const res = await fetch(endpoint);
        const data = await res.json();
        setBuySearchResults(data);
      } catch {
        setBuySearchResults([]);
      } finally {
        setBuySearching(false);
      }
    }, 350);

    return () => { if (buyDebounceRef.current) clearTimeout(buyDebounceRef.current); };
  }, [buySearchQuery, buyAssetType, mode]);

  // ── Buy mode: handle asset selection ──
  const handleBuyAssetSelect = useCallback(async (result: YahooSearchResult | CoinGeckoSearchResult) => {
    setBuySelectedAsset(result);
    setBuySearchQuery("");
    setBuySearchResults([]);

    if (buyAssetType === "stock") {
      const r = result as YahooSearchResult;
      setBuyAssetCurrency(r.currency ?? "USD");
    } else {
      setBuyAssetCurrency("USD");
      // Auto-detect chain/subcategory
      const r = result as CoinGeckoSearchResult;
      setBuyDetectingChain(true);
      try {
        const res = await fetch(`/api/crypto/detail?id=${encodeURIComponent(r.id)}`);
        if (res.ok) {
          const detail = await res.json();
          setBuyDetectedChain(detail.chain ?? null);
          setBuyDetectedSubcategory(detail.subcategory ?? null);
        }
      } catch { /* ignore */ }
      setBuyDetectingChain(false);
    }
  }, [buyAssetType]);

  // ── Buy mode: cash auto-detection ──
  useEffect(() => {
    if (mode !== "buy" || !buyLocationId || buyCreatingNew) {
      setExistingCashAmount(null);
      if (mode === "buy") setCashState("prompt");
      return;
    }
    if (buyAssetType === "stock") {
      const deposit = brokerDeposits.find(
        (d) => d.broker_id === buyLocationId && d.currency === buyAssetCurrency
      );
      if (deposit) {
        setExistingCashAmount(deposit.amount);
        setCashState("auto");
      } else {
        setExistingCashAmount(null);
        setCashState("prompt");
      }
    } else {
      const deposit = exchangeDeposits.find(
        (d) => d.wallet_id === buyLocationId && d.currency === buyAssetCurrency
      );
      if (deposit) {
        setExistingCashAmount(deposit.amount);
        setCashState("auto");
      } else {
        setExistingCashAmount(null);
        setCashState("prompt");
      }
    }
  }, [buyLocationId, buyAssetCurrency, buyAssetType, brokerDeposits, exchangeDeposits, mode, buyCreatingNew]);

  // ── Buy mode: auto-calculated value ──
  const buyValue = useMemo(() => {
    if (mode !== "buy" || !buySelectedAsset) return null;
    const qty = parseFloat(buyQuantity);
    if (isNaN(qty) || qty <= 0) return null;
    if (buyAssetType === "stock") {
      const r = buySelectedAsset as YahooSearchResult;
      if (r.price) return qty * r.price;
    }
    return null;
  }, [mode, buySelectedAsset, buyQuantity, buyAssetType]);

  // ── Buy mode: location options ──
  const buyLocationOptions = useMemo(() => {
    if (mode !== "buy") return [];
    if (buyAssetType === "stock") {
      return brokers.map((b) => ({ id: b.id, name: b.name }));
    }
    return wallets
      .filter((w) => w.wallet_type === "custodial")
      .map((w) => ({ id: w.id, name: w.name }));
  }, [mode, buyAssetType, brokers, wallets]);

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

    if (mode === "buy") {
      if (!buySelectedAsset) {
        setError("Select an asset to buy");
        return;
      }
      const qty = parseFloat(buyQuantity);
      if (isNaN(qty) || qty <= 0) {
        setError("Enter a valid quantity");
        return;
      }
      if (!buyLocationId && !buyCreatingNew) {
        setError("Select or create a location");
        return;
      }
      if (buyCreatingNew && !buyNewLocationName.trim()) {
        setError("Enter a name for the new institution");
        return;
      }

      // Determine if asset is new or existing
      let existingAssetId: string | undefined;
      let newStockAsset: StockAssetInput | undefined;
      let newCryptoAsset: CryptoAssetInput | undefined;

      if (buyAssetType === "stock") {
        const r = buySelectedAsset as YahooSearchResult;
        const existing = stockAssets.find((a) => a.yahoo_ticker === r.symbol);
        if (existing) {
          existingAssetId = existing.id;
        } else {
          newStockAsset = {
            ticker: extractBaseTicker(r.symbol),
            name: r.longname || r.shortname,
            yahoo_ticker: r.symbol,
            currency: r.currency ?? "USD",
            category: inferCategory(r.quoteType),
          };
        }
      } else {
        const r = buySelectedAsset as CoinGeckoSearchResult;
        const existing = cryptoAssets.find((a) => a.coingecko_id === r.id);
        if (existing) {
          existingAssetId = existing.id;
        } else {
          newCryptoAsset = {
            ticker: r.symbol.toUpperCase(),
            name: r.name,
            coingecko_id: r.id,
            chain: buyDetectedChain,
            subcategory: buyDetectedSubcategory,
            image_url: r.large ?? r.thumb ?? null,
          };
        }
      }

      // Build destination
      const destLocId = buyCreatingNew ? "PENDING" : buyLocationId;
      const destination: TransferSide = buyAssetType === "stock"
        ? { type: "stock_position", assetId: existingAssetId ?? "PENDING", brokerId: destLocId, quantity: qty }
        : { type: "crypto_position", assetId: existingAssetId ?? "PENDING", walletId: destLocId, quantity: qty };

      // Build source (cash side) — undefined if skipped
      let source: TransferSide | undefined;
      const cashAmount = cashState === "auto" && existingCashAmount !== null
        ? buyValue ?? 0
        : cashState === "prompt" && cashBalance
          ? buyValue ?? 0
          : 0;

      if (cashState !== "skipped") {
        if (buyAssetType === "stock") {
          source = { type: "broker_deposit", brokerId: destLocId, currency: buyAssetCurrency, amount: cashAmount };
        } else {
          source = { type: "exchange_deposit", walletId: destLocId, currency: buyAssetCurrency, amount: cashAmount };
        }
      }

      const transferInput: TransferInput = {
        mode: "buy",
        source,
        destination,
        newStockAsset,
        newCryptoAsset,
        newBroker: buyAssetType === "stock" && buyCreatingNew ? { name: buyNewLocationName.trim() } : undefined,
        newWallet: buyAssetType === "crypto" && buyCreatingNew ? { name: buyNewLocationName.trim() } : undefined,
        newCashDeposit: cashState === "prompt" && cashBalance
          ? { amount: parseFloat(cashBalance), currency: buyAssetCurrency, isAdjustment: cashIsAdjustment }
          : undefined,
        effectiveDate: effectiveDate || undefined,
      };

      setExecuting(true);
      try {
        const result = await executeTransfer(transferInput);
        if (result.success) {
          const sym = buySelectedAsset.symbol.toUpperCase();
          toast.success(`Recorded purchase of ${buyQuantity} ${sym}`);
          onSuccess?.();
          onClose();
        } else {
          setError(result.error);
          if (result.partialFailure) {
            toast.error("Partial failure - check your positions");
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Purchase failed");
      } finally {
        setExecuting(false);
      }
      return;
    }

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
    if (mode === "buy") {
      if (!buySelectedAsset) return false;
      const qty = parseFloat(buyQuantity);
      if (isNaN(qty) || qty <= 0) return false;
      if (!buyLocationId && !buyCreatingNew) return false;
      if (buyCreatingNew && !buyNewLocationName.trim()) return false;
      if (cashState === "prompt" && !cashBalance && existingCashAmount === null) return false;
      return true;
    }
    return buildSource() !== null && buildDest() !== null;
  }, [executing, mode, buySelectedAsset, buyQuantity, buyLocationId,
      buyCreatingNew, buyNewLocationName, cashState, cashBalance, existingCashAmount,
      buildSource, buildDest]);

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
          {/* ── FROM / BUYING section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
              {mode === "buy" ? "Buying" : "From"}
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
              <>
                {/* Asset type tabs */}
                <div className="flex gap-1 mb-2">
                  {(["stock", "crypto"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setBuyAssetType(t);
                        setBuySelectedAsset(null);
                        setBuySearchQuery("");
                        setBuySearchResults([]);
                        setBuyLocationId("");
                        setBuyCreatingNew(false);
                      }}
                      className={`px-3 py-1 rounded-md text-xs transition-colors ${
                        buyAssetType === t
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {t === "stock" ? "Stock / ETF" : "Crypto"}
                    </button>
                  ))}
                </div>

                {/* Asset search / selection */}
                {buySelectedAsset ? (
                  <div className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm text-zinc-100 font-medium">
                        {buySelectedAsset.symbol.toUpperCase()}
                      </span>
                      <span className="text-xs text-zinc-500 ml-2">
                        {"shortname" in buySelectedAsset ? buySelectedAsset.shortname : buySelectedAsset.name}
                      </span>
                      {buyAssetCurrency && (
                        <span className="text-xs text-zinc-600 ml-2">{buyAssetCurrency}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setBuySelectedAsset(null);
                        setBuySearchQuery("");
                        setBuyLocationId("");
                        setBuyCreatingNew(false);
                      }}
                      className="text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                      <Search className="w-3.5 h-3.5 text-zinc-500 mr-2 flex-shrink-0" />
                      <input
                        type="text"
                        value={buySearchQuery}
                        onChange={(e) => setBuySearchQuery(e.target.value)}
                        placeholder={buyAssetType === "stock" ? "Search stocks or ETFs..." : "Search crypto..."}
                        className="flex-1 bg-transparent text-sm text-white placeholder-zinc-600 focus:outline-none"
                      />
                      {buySearching && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                    </div>
                    {buySearchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {buySearchResults.map((r, i) => (
                          <button
                            key={r.symbol}
                            type="button"
                            onClick={() => handleBuyAssetSelect(r)}
                            className="w-full text-left px-3 py-2 hover:bg-zinc-800 transition-colors"
                          >
                            <span className="text-sm text-zinc-100">
                              {r.symbol.toUpperCase()}
                            </span>
                            <span className="text-xs text-zinc-500 ml-2">
                              {"shortname" in r ? r.shortname : r.name}
                            </span>
                            {"exchDisp" in r && (
                              <span className="text-xs text-zinc-600 ml-1">({(r as YahooSearchResult).exchDisp})</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {buyDetectingChain && (
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Detecting chain...
                  </div>
                )}

                {/* Location picker */}
                {buySelectedAsset && (
                  <>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">
                        {buyAssetType === "stock" ? "Broker" : "Exchange / Wallet"}
                      </label>
                      {buyCreatingNew ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={buyNewLocationName}
                            onChange={(e) => setBuyNewLocationName(e.target.value)}
                            placeholder={buyAssetType === "stock" ? "New broker name" : "New exchange name"}
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setBuyCreatingNew(false);
                              setBuyNewLocationName("");
                            }}
                            className="text-xs text-zinc-500 hover:text-zinc-300"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <select
                            value={buyLocationId}
                            onChange={(e) => setBuyLocationId(e.target.value)}
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                          >
                            <option value="">Select...</option>
                            {buyLocationOptions.map((loc) => (
                              <option key={loc.id} value={loc.id}>{loc.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => setBuyCreatingNew(true)}
                            className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
                          >
                            + New
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Quantity */}
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Quantity</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={buyQuantity}
                        onChange={(e) => setBuyQuantity(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                      {buyValue !== null && (
                        <div className="text-xs text-zinc-600 mt-1">
                          ~{buyAssetCurrency} {buyValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
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

          {/* ── TO / PAYING WITH section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            {mode === "move" ? (
              <>
                <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
                  To
                </span>
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
            ) : mode === "buy" ? (
              <>
                <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
                  Paying With
                </span>

                {cashState === "skipped" ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-600">Cash not tracked</span>
                    <button
                      type="button"
                      onClick={() => setCashState("prompt")}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      Track cash
                    </button>
                  </div>
                ) : cashState === "auto" && existingCashAmount !== null ? (
                  <div className="space-y-1">
                    <div className="text-sm text-zinc-300">
                      {buyAssetCurrency} at {buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name ?? "\u2014"}
                    </div>
                    <div className="text-xs text-zinc-500">
                      Balance: {buyAssetCurrency} {existingCashAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      {buyValue !== null && (
                        <span> → {buyAssetCurrency} {(existingCashAmount - buyValue).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-amber-400">
                      No {buyAssetCurrency} cash tracked at {buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name ?? "this institution"}.
                    </p>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">
                        Current {buyAssetCurrency} balance
                      </label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={cashBalance}
                        onChange={(e) => setCashBalance(e.target.value)}
                        placeholder="e.g. 5000"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={cashIsAdjustment}
                        onChange={(e) => setCashIsAdjustment(e.target.checked)}
                        className="accent-amber-500"
                      />
                      <label className="text-[10px] text-zinc-400" title="Not a real transaction — portfolio balance correction">
                        Portfolio adjustment (existing money, not a new deposit)
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCashState("skipped")}
                      className="text-xs text-zinc-500 hover:text-zinc-300"
                    >
                      Skip cash tracking
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">
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

          {/* ── Buy Summary ── */}
          {mode === "buy" && buySelectedAsset && parseFloat(buyQuantity) > 0 && (buyLocationId || buyCreatingNew) && (
            <div className="bg-zinc-900/80 border border-zinc-700 rounded-lg p-3 space-y-1 text-xs">
              <div className="text-zinc-500 uppercase tracking-wider font-medium text-[10px] mb-1">Summary</div>
              <div className="text-zinc-200">
                Buy {buyQuantity} × {buySelectedAsset.symbol.toUpperCase()}
                {" at "}{buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name}
                {buyValue !== null && <span className="text-zinc-400"> ({buyAssetCurrency} {buyValue.toLocaleString(undefined, { maximumFractionDigits: 2 })})</span>}
              </div>
              {cashState === "auto" && existingCashAmount !== null && buyValue !== null && (
                <div className="text-zinc-400">
                  Cash: {buyAssetCurrency} {existingCashAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} → {buyAssetCurrency} {(existingCashAmount - buyValue).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
              {cashState === "prompt" && cashBalance && (
                <div className="text-zinc-400">
                  Cash: {buyAssetCurrency} {parseFloat(cashBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} → {buyAssetCurrency} {(parseFloat(cashBalance) - (buyValue ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  {cashIsAdjustment && <span className="text-amber-400 ml-1">(Adj.)</span>}
                </div>
              )}
              {cashState === "skipped" && (
                <div className="text-zinc-600">Cash: not tracked</div>
              )}
              {(() => {
                const creating: string[] = [];
                if (buyCreatingNew) creating.push(buyAssetType === "stock" ? `${buyNewLocationName} (broker)` : `${buyNewLocationName} (exchange)`);
                if (buyAssetType === "stock" && !stockAssets.find((a) => a.yahoo_ticker === (buySelectedAsset as YahooSearchResult).symbol)) {
                  creating.push(`${(buySelectedAsset as YahooSearchResult).symbol} (asset)`);
                }
                if (buyAssetType === "crypto" && !cryptoAssets.find((a) => a.coingecko_id === (buySelectedAsset as CoinGeckoSearchResult).id)) {
                  creating.push(`${(buySelectedAsset as CoinGeckoSearchResult).symbol.toUpperCase()} (asset)`);
                }
                if (cashState === "prompt" && cashBalance) creating.push(`${buyAssetCurrency} deposit`);
                return creating.length > 0 ? (
                  <div className="text-blue-400">Creating: {creating.join(", ")}</div>
                ) : null;
              })()}
            </div>
          )}

          {/* ── Date picker ── */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Date</label>
            <input
              type="date"
              value={effectiveDate}
              max={new Date().toISOString().split("T")[0]}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
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
              {mode === "buy" ? "Record Purchase" : "Execute Transfer"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
