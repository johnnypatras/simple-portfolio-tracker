"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  TransactionModal,
  type TransactionSubmit,
  type CashAccountOption,
} from "@/components/transactions/transaction-modal";
import { addNewAssetTransaction } from "@/lib/actions/transactions";
import { executeTransfer } from "@/lib/actions/transfers";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { extractBaseTicker, inferCategory } from "@/lib/asset-extract";
import type {
  PickedAsset,
  TransferSide,
  TransferInput,
  NewAssetBuyInput,
  CryptoAssetInput,
  StockAssetInput,
  YahooSearchResult,
  CoinGeckoSearchResult,
} from "@/lib/types";

interface ToolbarBuyManagerProps {
  assetClass: "crypto" | "stock";
  open: boolean;
  onClose: () => void;
  /** All wallets (crypto) / brokers (stock) — `Wallet[]`/`Broker[]` are structurally
   *  assignable, so the tables pass their full lists directly. */
  wallets: { id: string; name: string }[];
  brokers: { id: string; name: string }[];
  /** Uppercased tickers already held — drives the picker's "Owned" badge. */
  ownedTickers: Set<string>;
  onMutated: () => void;
}

/**
 * Toolbar "Buy" orchestrator — the asset-less half of the one Buy machine. Opens
 * the shared modal in picker mode; on submit, routes EXTERNAL (new money) →
 * addNewAssetTransaction (S&P contribution) or TRACKED (from a tracked cash
 * account) → executeTransfer (S&P-neutral). The asset is always passed as a
 * new-asset spec — createCryptoAsset/createStockAsset dedup server-side, so the
 * write path needs no new-vs-existing branch.
 */
export function ToolbarBuyManager({
  assetClass,
  open,
  onClose,
  wallets,
  brokers,
  ownedTickers,
  onMutated,
}: ToolbarBuyManagerProps) {
  const [picked, setPicked] = useState<PickedAsset | null>(null);
  const [cashAccounts, setCashAccounts] = useState<CashAccountOption[]>([]);
  const [chain, setChain] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const detailGenRef = useRef(0);

  // Cash accounts for the money-flow "tracked account" option (graceful-degrade
  // to [] → external-only). The amount is in the chosen account's currency, so the
  // manager needs no display-currency of its own.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getCashAccounts()
      .then((accounts) => {
        if (cancelled) return;
        setCashAccounts(
          accounts.map((a) => ({
            id: a.id,
            name:
              a.name ??
              a.wallet_name ??
              a.broker_name ??
              a.institution_name ??
              `${a.currency} account`,
            balance: a.balance,
            currency: a.currency,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setCashAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // On pick: store the asset, then (crypto only) detect chain/subcategory. A
  // generation ref drops a stale /detail response if the user re-picks quickly.
  const handlePick = useCallback((a: PickedAsset) => {
    setPicked(a);
    setChain(null);
    setSubcategory(null);
    if (a.assetClass === "crypto") {
      const gen = ++detailGenRef.current;
      const id = (a.raw as CoinGeckoSearchResult).id;
      fetch(`/api/crypto/detail?id=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((detail) => {
          if (detailGenRef.current !== gen || !detail) return;
          setChain(detail.chain ?? null);
          setSubcategory(detail.subcategory ?? null);
        })
        .catch(() => {});
    }
  }, []);

  const handleClose = useCallback(() => {
    setPicked(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (submit: TransactionSubmit) => {
      if (!picked) return;

      const newCryptoAsset: CryptoAssetInput | undefined =
        assetClass === "crypto"
          ? {
              ticker: picked.raw.symbol.toUpperCase(),
              name: (picked.raw as CoinGeckoSearchResult).name,
              coingecko_id: (picked.raw as CoinGeckoSearchResult).id,
              chain,
              subcategory,
              image_url:
                (picked.raw as CoinGeckoSearchResult).large ??
                (picked.raw as CoinGeckoSearchResult).thumb ??
                null,
            }
          : undefined;
      const newStockAsset: StockAssetInput | undefined =
        assetClass === "stock"
          ? (() => {
              const r = picked.raw as YahooSearchResult;
              return {
                ticker: extractBaseTicker(r.symbol),
                name: r.longname || r.shortname,
                yahoo_ticker: r.symbol,
                currency: r.currency ?? "USD",
                category: inferCategory(r.quoteType),
              };
            })()
          : undefined;
      const cost = submit.cashflowOverride
        ? { amount: submit.cashflowOverride.amount, currency: submit.cashflowOverride.currency }
        : undefined;

      try {
        let res: { success: boolean; error?: string };
        if (submit.moneyFlow?.route === "tracked") {
          const destLocId = submit.newLocationName ? "PENDING" : (submit.walletId ?? submit.brokerId)!;
          const destination: TransferSide =
            assetClass === "crypto"
              ? { type: "crypto_position", assetId: "PENDING", walletId: destLocId, quantity: submit.quantity }
              : { type: "stock_position", assetId: "PENDING", brokerId: destLocId, quantity: submit.quantity };
          const input: TransferInput = {
            mode: "buy",
            source: {
              type: "cash_account",
              accountId: submit.moneyFlow.accountId,
              amount: submit.cashflowOverride!.amount,
            },
            destination,
            newCryptoAsset,
            newStockAsset,
            newWallet:
              assetClass === "crypto" && submit.newLocationName
                ? { name: submit.newLocationName, wallet_type: submit.walletType ?? "custodial" }
                : undefined,
            newBroker:
              assetClass === "stock" && submit.newLocationName
                ? { name: submit.newLocationName }
                : undefined,
            effectiveDate: submit.date || undefined,
          };
          res = await executeTransfer(input);
        } else {
          const input: NewAssetBuyInput = {
            assetClass,
            newCryptoAsset,
            newStockAsset,
            locationId: submit.newLocationName ? undefined : (submit.walletId ?? submit.brokerId),
            newLocationName: submit.newLocationName,
            // Custody is crypto-only (brokers have none) — don't send it for stocks.
            walletType: assetClass === "crypto" ? submit.walletType : undefined,
            quantity: submit.quantity,
            cost,
            effectiveDate: submit.date || undefined,
          };
          res = await addNewAssetTransaction(input);
        }
        if (res.success) {
          toast.success("Buy recorded");
          onMutated();
          handleClose();
        } else {
          toast.error(res.error ?? "Buy failed");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Buy failed");
      }
    },
    [picked, assetClass, chain, subcategory, onMutated, handleClose],
  );

  return (
    <TransactionModal
      isOpen={open}
      onClose={handleClose}
      assetClass={assetClass}
      assetName={picked?.ticker}
      initialType="buy"
      allowedTypes={["buy"]}
      pickerMode={{ picked, onAssetPicked: handlePick, ownedTickers }}
      walletOptions={assetClass === "crypto" ? wallets : undefined}
      brokerOptions={assetClass === "stock" ? brokers : undefined}
      cashAccountOptions={cashAccounts}
      onSubmit={handleSubmit}
    />
  );
}
