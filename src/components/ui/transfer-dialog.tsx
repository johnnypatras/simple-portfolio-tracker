"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useId } from "react";
import { ArrowDown, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/modal";
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
  YahooSearchResult,
  CoinGeckoSearchResult,
  StockAssetInput,
  CryptoAssetInput,
  AssetCategory,
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
  initialDestination,
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
  // Editable cost: defaults to qty × market price, user can override to record
  // actual fills incl. slippage/fees. effectiveBuyAmount (computed below)
  // drives the cash deduction and S&P benchmark cashflow.
  const [buyAmountEdit, setBuyAmountEdit] = useState("");
  const [buyAmountManual, setBuyAmountManual] = useState(false);
  const [buyDetectingChain, setBuyDetectingChain] = useState(false);
  const [buyDetectedChain, setBuyDetectedChain] = useState<string | null>(null);
  const [buyDetectedSubcategory, setBuyDetectedSubcategory] = useState<string | null>(null);

  // ── Cash tracking state ──
  type CashState = "auto" | "prompt" | "skipped";
  const [cashState, setCashState] = useState<CashState>("prompt");
  const [cashBalance, setCashBalance] = useState("");
  const [cashIsAdjustment, setCashIsAdjustment] = useState(true);
  const [existingCashAmount, setExistingCashAmount] = useState<number | null>(null);
  // C7: when multiple cash accounts match (location, currency), user picks one
  const [selectedMatchingCashId, setSelectedMatchingCashId] = useState<string>("");

  // For move mode: pick destination location (same asset)
  const [moveLocationId, setMoveLocationId] = useState("");

  // ── Pre-filled side ──
  const prefilled = mode === "buy" ? initialDestination : initialSource;
  // Ref for currentQty: read during form reset without subscribing to changes
  const currentQtyRef = useRef(prefilled?.currentQty);
  currentQtyRef.current = prefilled?.currentQty;
  const prefilledLabel = prefilled
    ? `${prefilled.assetTicker} on ${prefilled.locationName}`
    : "";
  const needsPicker = mode === "sell" && !prefilled;

  // ── Buy-mode prefilled-asset lock ──
  // When launched from a position editor's Buy button, `prefilled.assetId` points
  // at an existing asset. If we find a match in the loaded data, the modal renders
  // a locked asset card (no search, no "Change" button) and routes handleExecute
  // through the existing-asset path. Falls back to the search UI if no match (e.g.,
  // stale data or asset was deleted between modal open and data load).
  const prefilledMatchedExistingAsset = useMemo(() => {
    if (mode !== "buy" || !prefilled) return false;
    if (prefilled.type === "stock_position") {
      return stockAssets.some((a) => a.id === prefilled.assetId);
    }
    if (prefilled.type === "crypto_position") {
      return cryptoAssets.some((a) => a.id === prefilled.assetId);
    }
    return false;
  }, [mode, prefilled, stockAssets, cryptoAssets]);

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
    // Buy mode reset — seed asset type / broker / currency from prefilled when launched
    // from a position editor (e.g., "Buy more of IDTL" from the IDTL positions modal).
    // The data arrays may not be loaded yet here; prefilledMatchedExistingAsset resolves
    // post-load and gates the locked-asset render, but seeding broker/currency now lets
    // the cash auto-detection useEffect find existing matching cash immediately on render.
    setBuyAssetType(prefilled?.type === "crypto_position" ? "crypto" : "stock");
    setBuySearchQuery("");
    setBuySearchResults([]);
    setBuySelectedAsset(null);
    setBuyAssetCurrency(prefilled?.currency ?? "USD");
    setBuyLocationId(prefilled?.locationId ?? "");
    setBuyNewLocationName("");
    setBuyCreatingNew(false);
    setBuyQuantity("");
    setBuyAmountEdit("");
    setBuyAmountManual(false);
    setBuyDetectingChain(false);
    setBuyDetectedChain(null);
    setBuyDetectedSubcategory(null);
    setCashState("prompt");
    setCashBalance("");
    setCashIsAdjustment(true);
    setExistingCashAmount(null);
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
    if (mode === "buy") {
      if (prefilled?.assetTicker) return `Buy ${prefilled.assetTicker}`;
      if (buySelectedAsset) {
        const sym = buySelectedAsset.symbol;
        return `Buy ${sym.toUpperCase()}`;
      }
      return "Record Buy";
    }
    if (!prefilled) return "Transfer";
    switch (mode) {
      case "sell": return `Sell ${prefilled.assetTicker}`;
      case "move": return `Move ${prefilled.assetTicker}`;
    }
  }, [mode, prefilled, buySelectedAsset]);

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
        if (!res.ok) return;
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

  // ── Buy mode: matching cash accounts at this location/currency ──
  // Multiple matches are possible (e.g., taxable + IRA at same broker, or two
  // sub-accounts at one exchange). When >1 match exists, the user picks which
  // to deduct from via a dropdown in the "Paying With" section. When 1 match,
  // it's auto-selected. When 0, falls into prompt mode for seed-cash entry.
  const matchingCashAccounts = useMemo(() => {
    if (mode !== "buy" || !buyLocationId || buyCreatingNew) return [];
    return cashAccounts.filter((ca) => {
      if (buyAssetType === "stock") return ca.broker_id === buyLocationId && ca.currency === buyAssetCurrency;
      return ca.wallet_id === buyLocationId && ca.currency === buyAssetCurrency;
    });
  }, [mode, buyLocationId, buyAssetCurrency, buyAssetType, cashAccounts, buyCreatingNew]);

  // ── Buy mode: cash auto-detection (drives cashState + default selection) ──
  useEffect(() => {
    if (mode !== "buy" || !buyLocationId || buyCreatingNew) {
      setExistingCashAmount(null);
      setSelectedMatchingCashId("");
      if (mode === "buy") setCashState("prompt");
      return;
    }
    if (matchingCashAccounts.length > 0) {
      // Preserve the user's selection if it's still valid; else default to first match.
      setSelectedMatchingCashId((prev) =>
        prev && matchingCashAccounts.some((m) => m.id === prev) ? prev : matchingCashAccounts[0].id
      );
      const selected = matchingCashAccounts.find((m) => m.id === selectedMatchingCashId) ?? matchingCashAccounts[0];
      setExistingCashAmount(selected.balance);
      setCashState("auto");
    } else {
      setExistingCashAmount(null);
      setSelectedMatchingCashId("");
      setCashState("prompt");
    }
  }, [matchingCashAccounts, buyLocationId, buyCreatingNew, mode, selectedMatchingCashId]);

  // ── Buy mode: auto-calculated value ──
  const buyValue = useMemo(() => {
    if (mode !== "buy") return null;
    const qty = parseFloat(buyQuantity);
    if (isNaN(qty) || qty <= 0) return null;
    // Prefilled-locked path: use the live price the position editor passed in.
    // Stock editor passes `currentPrice` (native trading currency, matches buyAssetCurrency).
    // Crypto editor passes `currentPriceUsd`/`currentPriceEur` for sell-mode dual-currency display;
    // for buy, currentPriceUsd matches buyAssetCurrency (crypto buy is always USD-priced).
    if (prefilledMatchedExistingAsset) {
      const price = prefilled?.currentPrice ?? prefilled?.currentPriceUsd;
      if (price) return qty * price;
    }
    if (!buySelectedAsset) return null;
    if (buyAssetType === "stock") {
      const r = buySelectedAsset as YahooSearchResult;
      if (r.price) return qty * r.price;
    }
    return null;
  }, [mode, buySelectedAsset, buyQuantity, buyAssetType, prefilledMatchedExistingAsset, prefilled?.currentPrice, prefilled?.currentPriceUsd]);

  // ── Editable buy amount: defaults to qty × market, overrideable for actual fills ──
  // Sync the editable field from buyValue while user hasn't manually edited.
  useEffect(() => {
    if (buyAmountManual) return;
    if (buyValue !== null) setBuyAmountEdit(buyValue.toFixed(2));
    else setBuyAmountEdit("");
  }, [buyValue, buyAmountManual]);

  // Effective amount that drives the cash deduction (override wins; falls back to estimate).
  const effectiveBuyAmount = useMemo<number | null>(() => {
    if (buyAmountEdit) {
      const parsed = parseFloat(buyAmountEdit);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return buyValue;
  }, [buyAmountEdit, buyValue]);

  // Surfaces the difference between user-entered cost and market estimate
  // (slippage, fees, off-market price). Null when no override or no estimate.
  const buyFeeDiff = useMemo<number | null>(() => {
    if (!buyAmountManual || buyValue === null) return null;
    const manual = parseFloat(buyAmountEdit);
    if (isNaN(manual)) return null;
    const diff = manual - buyValue;
    return Math.abs(diff) < 0.01 ? null : diff;
  }, [buyAmountManual, buyValue, buyAmountEdit]);

  // ── Buy mode: location options ──
  // Both custodial (exchanges) AND non-custodial (self-custody) wallets are valid
  // crypto buy destinations. Non-custodial wallets support DEX swaps, on-chain
  // stablecoin→crypto purchases, on-ramps that deliver direct to self-custody,
  // and staking/mining rewards. Filtering to custodial-only would silently block
  // any DeFi-native flow.
  const buyLocationOptions = useMemo(() => {
    if (mode !== "buy") return [];
    if (buyAssetType === "stock") {
      return brokers.map((b) => ({ id: b.id, name: b.name }));
    }
    return wallets.map((w) => ({ id: w.id, name: w.name }));
  }, [mode, buyAssetType, brokers, wallets]);

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

    if (mode === "buy") {
      if (!buySelectedAsset && !prefilledMatchedExistingAsset) {
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

      if (prefilledMatchedExistingAsset && prefilled) {
        // Asset is locked to the one the user clicked Buy on (e.g., IDTL from its
        // positions modal). Bypass the search-based new-vs-existing branching.
        existingAssetId = prefilled.assetId;
      } else if (buyAssetType === "stock") {
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
        // Match chain too: prefer exact chain match, fall back to any if no chain specified
        const existing = cryptoAssets.find((a) =>
          a.coingecko_id === r.id &&
          (buyDetectedChain == null || a.chain === buyDetectedChain || a.chain == null)
        );
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
      // cashAmount uses effectiveBuyAmount (user override if any, else market estimate),
      // so the cash deduction reflects what the user actually paid — not just the auto-estimate.
      const cashAmount = cashState === "auto" && existingCashAmount !== null
        ? effectiveBuyAmount ?? 0
        : cashState === "prompt" && cashBalance
          ? effectiveBuyAmount ?? 0
          : 0;

      // Defensive: if prompt mode with cashBalance but no effective amount (no price data
      // AND no manual override), the cash account would land disconnected from any source
      // leg. Surface this rather than silently creating an orphaned seed deposit.
      if (cashState === "prompt" && cashBalance && effectiveBuyAmount === null) {
        setError("Cannot determine purchase cost — enter the Amount paid manually, or click “Skip cash tracking” to record the position without cash impact.");
        return;
      }

      if (cashState !== "skipped" && cashAmount > 0) {
        // Use the user-selected matching cash account (C7: respects the picked one
        // when multiple matches exist; falls back to first match for backwards compat).
        const matchingCash =
          matchingCashAccounts.find((ca) => ca.id === selectedMatchingCashId) ??
          matchingCashAccounts[0];
        if (matchingCash) {
          source = { type: "cash_account", accountId: matchingCash.id, amount: cashAmount };
        } else if (cashState === "prompt" && cashBalance) {
          // No matching cash → newCashDeposit will create one. Source points to it
          // via the PENDING placeholder; the server patches accountId after creation.
          // Without this source, the seed cash account would be created but the buy
          // would land as a single-legged adjustment, silently dropping the cashflow.
          const seedBalance = parseFloat(cashBalance);
          if (!isNaN(seedBalance) && seedBalance >= cashAmount) {
            source = { type: "cash_account", accountId: "PENDING", amount: cashAmount };
          } else {
            setError(
              `Seed balance ${buyAssetCurrency} ${isNaN(seedBalance) ? "0" : seedBalance.toFixed(2)} ` +
              `is less than the purchase cost ${buyAssetCurrency} ${cashAmount.toFixed(2)}. ` +
              `Increase the balance or reduce the quantity.`
            );
            return;
          }
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
          const sym = prefilledMatchedExistingAsset && prefilled
            ? prefilled.assetTicker
            : (buySelectedAsset as YahooSearchResult | CoinGeckoSearchResult).symbol.toUpperCase();
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
      if (!buySelectedAsset && !prefilledMatchedExistingAsset) return false;
      const qty = parseFloat(buyQuantity);
      if (isNaN(qty) || qty <= 0) return false;
      if (!buyLocationId && !buyCreatingNew) return false;
      if (buyCreatingNew && !buyNewLocationName.trim()) return false;
      if (cashState === "prompt" && !cashBalance && existingCashAmount === null) return false;
      // Seed-cash flow: balance must cover the effective amount (user override or estimate).
      // Without this, the server would create the cash account then immediately fail the
      // source-leg balance check and rollback — wasted work + confusing error.
      if (cashState === "prompt" && cashBalance && effectiveBuyAmount !== null) {
        const seedBalance = parseFloat(cashBalance);
        if (isNaN(seedBalance) || seedBalance < effectiveBuyAmount) return false;
      }
      // Seed-cash flow with no effective amount (no price data AND no manual override):
      // can't compute the source amount, would land disconnected from position. Block.
      if (cashState === "prompt" && cashBalance && effectiveBuyAmount === null) return false;
      return true;
    }
    return buildSource() !== null && buildDest() !== null;
  }, [executing, mode, buySelectedAsset, prefilledMatchedExistingAsset, buyQuantity, buyLocationId,
      buyCreatingNew, buyNewLocationName, cashState, cashBalance, existingCashAmount, effectiveBuyAmount,
      buildSource, buildDest]);

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
          {/* ── FROM / BUYING section ── */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 space-y-3">
            <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
              {mode === "buy" ? "Buying" : "From"}
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
            {mode === "buy" && (
              <>
                {/* Asset type tabs — hidden when the asset is locked from prefilled */}
                {!prefilledMatchedExistingAsset && (
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
                )}

                {/* Asset display: locked card (prefilled) / selected card (search) / search input */}
                {prefilledMatchedExistingAsset && prefilled ? (
                  <div className="flex items-center bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm text-zinc-100 font-medium">
                        {prefilled.assetTicker}
                      </span>
                      <span className="text-xs text-zinc-400 ml-2">
                        {prefilled.assetName}
                      </span>
                      {prefilled.currency && (
                        <span className="text-xs text-zinc-400 ml-2">{prefilled.currency}</span>
                      )}
                    </div>
                  </div>
                ) : buySelectedAsset ? (
                  <div className="flex items-center justify-between bg-zinc-800/50 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm text-zinc-100 font-medium">
                        {buySelectedAsset.symbol.toUpperCase()}
                      </span>
                      <span className="text-xs text-zinc-400 ml-2">
                        {"shortname" in buySelectedAsset ? buySelectedAsset.shortname : buySelectedAsset.name}
                      </span>
                      {buyAssetCurrency && (
                        <span className="text-xs text-zinc-400 ml-2">{buyAssetCurrency}</span>
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
                      className="text-xs text-zinc-400 hover:text-zinc-300"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                      <Search className="w-3.5 h-3.5 text-zinc-400 mr-2 flex-shrink-0" />
                      <input
                        type="text"
                        value={buySearchQuery}
                        onChange={(e) => setBuySearchQuery(e.target.value)}
                        aria-label={buyAssetType === "stock" ? "Search stocks or ETFs" : "Search crypto"}
                        placeholder={buyAssetType === "stock" ? "Search stocks or ETFs..." : "Search crypto..."}
                        className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
                      />
                      {buySearching && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />}
                    </div>
                    {buySearchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {buySearchResults.map((r) => (
                          <button
                            key={r.symbol}
                            type="button"
                            onClick={() => handleBuyAssetSelect(r)}
                            className="w-full text-left px-3 py-2 hover:bg-zinc-800 transition-colors"
                          >
                            <span className="text-sm text-zinc-100">
                              {r.symbol.toUpperCase()}
                            </span>
                            <span className="text-xs text-zinc-400 ml-2">
                              {"shortname" in r ? r.shortname : r.name}
                            </span>
                            {"exchDisp" in r && (
                              <span className="text-xs text-zinc-400 ml-1">({(r as YahooSearchResult).exchDisp})</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {buyDetectingChain && (
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Detecting chain...
                  </div>
                )}

                {/* Location picker (broker/wallet) + Quantity — shown once we have an asset */}
                {(buySelectedAsset || prefilledMatchedExistingAsset) && (
                  <>
                    <div>
                      <label htmlFor={`${id}-buy-location`} className="block text-xs text-zinc-400 mb-1">
                        {buyAssetType === "stock" ? "Broker" : "Exchange / Wallet"}
                      </label>
                      {buyCreatingNew ? (
                        <div className="flex items-center gap-2">
                          <input
                            id={`${id}-buy-location`}
                            type="text"
                            value={buyNewLocationName}
                            onChange={(e) => setBuyNewLocationName(e.target.value)}
                            placeholder={buyAssetType === "stock" ? "New broker name" : "New exchange name"}
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setBuyCreatingNew(false);
                              setBuyNewLocationName("");
                            }}
                            className="text-xs text-zinc-400 hover:text-zinc-300"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <select
                            id={`${id}-buy-location`}
                            value={buyLocationId}
                            onChange={(e) => setBuyLocationId(e.target.value)}
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
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
                      <label htmlFor={`${id}-buy-qty`} className="block text-xs text-zinc-400 mb-1">Quantity</label>
                      <input
                        id={`${id}-buy-qty`}
                        type="number"
                        step="any"
                        min="0"
                        value={buyQuantity}
                        onChange={(e) => setBuyQuantity(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                      />
                    </div>

                    {/* Editable amount paid — defaults to qty × market, override for actual fill */}
                    <div>
                      <label htmlFor={`${id}-buy-amount`} className="block text-xs text-zinc-400 mb-1">
                        Amount paid ({buyAssetCurrency})
                      </label>
                      <input
                        id={`${id}-buy-amount`}
                        type="number"
                        step="any"
                        min="0"
                        value={buyAmountEdit}
                        placeholder={buyValue !== null ? buyValue.toFixed(2) : "0.00"}
                        onChange={(e) => {
                          setBuyAmountEdit(e.target.value);
                          setBuyAmountManual(true);
                        }}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                      />
                      {buyValue !== null && (
                        <div className="text-[10px] text-zinc-400 mt-1 flex items-center gap-2">
                          <span>
                            Market: {buyAssetCurrency} {buyValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                          {buyFeeDiff !== null && (
                            <span className={buyFeeDiff > 0 ? "text-amber-400" : "text-emerald-400"}>
                              {buyFeeDiff > 0 ? "+" : ""}{buyFeeDiff.toFixed(2)} {buyFeeDiff > 0 ? "(fee / slippage)" : "(discount)"}
                            </span>
                          )}
                          {buyAmountManual && (
                            <button
                              type="button"
                              onClick={() => { setBuyAmountManual(false); }}
                              className="text-zinc-400 hover:text-zinc-300 underline"
                            >
                              reset
                            </button>
                          )}
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
            <ArrowDown className="w-4 h-4 text-zinc-400" />
            {autoCalcValue !== null && mode !== "move" && (
              <span className="text-xs text-zinc-400">
                ~{parseFloat(destAmount || "0").toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {" "}{destCurrency}
              </span>
            )}
            <div className="h-px flex-1 bg-zinc-800" />
          </div>

          {/* ── TO / PAYING WITH section ── */}
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
            ) : mode === "buy" ? (
              <>
                <span className="text-xs text-zinc-400 uppercase tracking-wider font-medium">
                  Paying With
                </span>

                {cashState === "skipped" ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Cash not tracked for this trade</span>
                    <button
                      type="button"
                      onClick={() => setCashState("prompt")}
                      className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                    >
                      Track cash
                    </button>
                  </div>
                ) : cashState === "auto" && existingCashAmount !== null ? (
                  <div className="space-y-2">
                    {matchingCashAccounts.length > 1 ? (
                      // C7: multiple cash accounts at same broker/currency \u2014 let user pick which
                      <div>
                        <label htmlFor={`${id}-cash-pick`} className="block text-xs text-zinc-400 mb-1">
                          Deduct from ({matchingCashAccounts.length} {buyAssetCurrency} accounts at {buyLocationOptions.find((l) => l.id === buyLocationId)?.name ?? "this institution"})
                        </label>
                        <select
                          id={`${id}-cash-pick`}
                          value={selectedMatchingCashId}
                          onChange={(e) => setSelectedMatchingCashId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                        >
                          {matchingCashAccounts.map((ca) => (
                            <option key={ca.id} value={ca.id}>
                              {ca.name ?? "Account"} \u2014 {buyAssetCurrency} {ca.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="text-sm text-zinc-300">
                        {buyAssetCurrency} at {buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name ?? "\u2014"}
                      </div>
                    )}
                    <div className="text-xs text-zinc-400">
                      Balance: {buyAssetCurrency} {existingCashAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      {effectiveBuyAmount !== null && (
                        <span> → {buyAssetCurrency} {(existingCashAmount - effectiveBuyAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-amber-400">
                      No {buyAssetCurrency} cash tracked at {buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name ?? "this institution"} yet — enter a starting balance below, or skip to record the trade without cash.
                    </p>
                    <div>
                      <label htmlFor={`${id}-cash-balance`} className="block text-xs text-zinc-400 mb-1">
                        Starting {buyAssetCurrency} balance
                      </label>
                      <input
                        id={`${id}-cash-balance`}
                        type="number"
                        step="any"
                        min="0"
                        value={cashBalance}
                        onChange={(e) => setCashBalance(e.target.value)}
                        placeholder="e.g. 5000"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                      />
                    </div>
                    <fieldset className="space-y-1.5">
                      <legend className="text-xs text-zinc-400 mb-1">This balance is</legend>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`${id}-cash-kind`}
                          checked={cashIsAdjustment}
                          onChange={() => setCashIsAdjustment(true)}
                          className="accent-amber-500 mt-0.5"
                        />
                        <span className="text-xs text-zinc-300 leading-tight">
                          Existing money already in the account
                          <span className="block text-[10px] text-zinc-400">Won&apos;t count as a new deposit (S&amp;P benchmark ignores it)</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name={`${id}-cash-kind`}
                          checked={!cashIsAdjustment}
                          onChange={() => setCashIsAdjustment(false)}
                          className="accent-blue-500 mt-0.5"
                        />
                        <span className="text-xs text-zinc-300 leading-tight">
                          A new deposit I&apos;m making now
                          <span className="block text-[10px] text-zinc-400">Counts toward portfolio cashflow (S&amp;P benchmark adds it)</span>
                        </span>
                      </label>
                    </fieldset>
                    <button
                      type="button"
                      onClick={() => setCashState("skipped")}
                      className="px-2.5 py-1 rounded-md text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                    >
                      Skip cash tracking
                    </button>
                  </div>
                )}
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
                    <select
                      id={`${id}-dest-currency`}
                      value={destCurrency}
                      onChange={(e) => setDestCurrency(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    >
                      {["EUR", "USD", "GBP", "CHF"].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
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

          {/* ── Buy Summary ── */}
          {mode === "buy" && buySelectedAsset && parseFloat(buyQuantity) > 0 && (buyLocationId || buyCreatingNew) && (
            <div className="bg-zinc-900/80 border border-zinc-700 rounded-lg p-3 space-y-1 text-xs">
              <div className="text-zinc-400 uppercase tracking-wider font-medium text-[10px] mb-1">Summary</div>
              <div className="text-zinc-200">
                Buy {buyQuantity} × {buySelectedAsset.symbol.toUpperCase()}
                {" at "}{buyCreatingNew ? buyNewLocationName : buyLocationOptions.find((l) => l.id === buyLocationId)?.name}
                {effectiveBuyAmount !== null && (
                  <span className="text-zinc-400">
                    {" ("}{buyAssetCurrency} {effectiveBuyAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    {buyFeeDiff !== null && (
                      <span className={buyFeeDiff > 0 ? "text-amber-400" : "text-emerald-400"}>
                        {" "}{buyFeeDiff > 0 ? "+" : ""}{buyFeeDiff.toFixed(2)} vs market
                      </span>
                    )}
                    {")"}
                  </span>
                )}
              </div>
              {cashState === "auto" && existingCashAmount !== null && effectiveBuyAmount !== null && (
                <div className="text-zinc-400">
                  Cash: {buyAssetCurrency} {existingCashAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} → {buyAssetCurrency} {(existingCashAmount - effectiveBuyAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              )}
              {cashState === "prompt" && cashBalance && (
                <div className="text-zinc-400">
                  Cash: {buyAssetCurrency} {parseFloat(cashBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} → {buyAssetCurrency} {(parseFloat(cashBalance) - (effectiveBuyAmount ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  {cashIsAdjustment && <span className="text-amber-400 ml-1">(Adj.)</span>}
                </div>
              )}
              {cashState === "skipped" && (
                <div className="text-zinc-400">Cash: not tracked</div>
              )}
              {(() => {
                const creating: string[] = [];
                if (buyCreatingNew) creating.push(buyAssetType === "stock" ? `${buyNewLocationName} (broker)` : `${buyNewLocationName} (exchange)`);
                if (buyAssetType === "stock" && !stockAssets.find((a) => a.yahoo_ticker === (buySelectedAsset as YahooSearchResult).symbol)) {
                  creating.push(`${(buySelectedAsset as YahooSearchResult).symbol} (asset)`);
                }
                if (buyAssetType === "crypto" && !cryptoAssets.find((a) =>
                  a.coingecko_id === (buySelectedAsset as CoinGeckoSearchResult).id &&
                  (buyDetectedChain == null || a.chain === buyDetectedChain || a.chain == null)
                )) {
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
            <label htmlFor={`${id}-date`} className="block text-xs text-zinc-400 mb-1">Date</label>
            <input
              id={`${id}-date`}
              type="date"
              value={effectiveDate}
              max={new Date().toISOString().split("T")[0]}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
            {mode === "buy" && cashState === "prompt" && cashBalance && (
              <p className="text-[10px] text-zinc-400 mt-1">
                Both the cash seed and the trade are recorded on this date. To use different dates, record the cash account first via the Banks &amp; Deposits page, then come back to record the trade.
              </p>
            )}
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
