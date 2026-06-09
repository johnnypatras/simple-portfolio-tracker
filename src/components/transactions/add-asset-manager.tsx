"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import {
  TransactionModal,
  type TransactionSubmit,
  type CashAccountOption,
} from "@/components/transactions/transaction-modal";
import type { AssetIdentityValue } from "@/components/transactions/asset-identity-step";
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

interface AddAssetManagerProps {
  assetClass: "crypto" | "stock";
  open: boolean;
  onClose: () => void;
  /** All wallets (crypto) / brokers (stock) — `Wallet[]`/`Broker[]` are structurally
   *  assignable, so the tables pass their full lists directly. */
  wallets: { id: string; name: string }[];
  brokers: { id: string; name: string }[];
  /** Uppercased tickers already held — drives the picker's "Owned" badge. */
  ownedTickers: Set<string>;
  /** Identity-step datalist seeds (already-used metadata across the portfolio).
   *  OPTIONAL — the tables wire real values in a later task; absent → no seeds. */
  existingChains?: string[];
  existingSubcategories?: string[];
  existingTags?: string[];
  existingAssets?: { coingecko_id: string; chain: string | null }[];
  /** "Not listed?" escape (stock only) → opens the manual-NAV modal in the parent.
   *  OPTIONAL — the stock-table wires this in a later task (button-merge); absent →
   *  the escape is not rendered and the modal has no manual-NAV path. */
  onAddManualNav?: () => void;
  onMutated: () => void;
}

/**
 * "Add asset" orchestrator — the asset-less half of the one Buy machine. Opens
 * the shared modal in picker mode; on submit, routes EXTERNAL (new money) →
 * addNewAssetTransaction (S&P contribution) or TRACKED (from a tracked cash
 * account) → executeTransfer (S&P-neutral). The asset is always passed as a
 * new-asset spec — createCryptoAsset/createStockAsset dedup server-side, so the
 * write path needs no new-vs-existing branch. Between pick and trade form, the
 * modal renders an identity-confirm step whose value this manager owns and
 * threads into the write call.
 */
export function AddAssetManager({
  assetClass,
  open,
  onClose,
  wallets,
  brokers,
  ownedTickers,
  existingChains,
  existingSubcategories,
  existingTags,
  existingAssets,
  onAddManualNav,
  onMutated,
}: AddAssetManagerProps) {
  const [picked, setPicked] = useState<PickedAsset | null>(null);
  const [cashAccounts, setCashAccounts] = useState<CashAccountOption[]>([]);
  // The detected chain/subcategory from /api/crypto/detail — seeds identityValue.
  const [chain, setChain] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  // All chains the picked coin trades on — drives both the chain datalist and
  // the needsIdentity decision (multi-chain → must disambiguate).
  const [availableChains, setAvailableChains] = useState<string[]>([]);
  // Authored identity (chain/subcategory/apy/method for crypto; currency/category/
  // tags/subcategory/isin for stock). Owned here, threaded into the write payload.
  const [identityValue, setIdentityValue] = useState<AssetIdentityValue>({});
  // True for crypto until the /detail response resolves — keeps the identity step
  // visible while pending so the user never skips it for a multi-chain coin.
  const [detailPending, setDetailPending] = useState(false);
  // True when the /detail fetch failed (or returned nothing) — force identity.
  const [detectionFailed, setDetectionFailed] = useState(false);
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

  // On pick: store the asset + seed the identity, then (crypto only) detect
  // chain/subcategory/availableChains. A generation ref drops a stale /detail
  // response if the user re-picks quickly.
  const handlePick = useCallback((a: PickedAsset) => {
    // Bump the generation immediately so any in-flight /detail fetch from a prior
    // pick (regardless of asset class) is invalidated before we branch.
    const gen = ++detailGenRef.current;
    setPicked(a);
    setChain(null);
    setSubcategory(null);
    setAvailableChains([]);
    setDetectionFailed(false);
    if (a.assetClass === "crypto") {
      // Seed empty (chain unknown until /detail resolves); pending forces the step.
      setIdentityValue({});
      setDetailPending(true);
      const id = (a.raw as CoinGeckoSearchResult).id;
      fetch(`/api/crypto/detail?id=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((detail) => {
          if (detailGenRef.current !== gen) return;
          if (!detail) {
            setDetectionFailed(true);
            setDetailPending(false);
            return;
          }
          const detectedChain: string | null = detail.chain || null;
          const detectedSubcategory: string | null = detail.subcategory || null;
          const chains: string[] = Array.isArray(detail.availableChains) ? detail.availableChains : [];
          setChain(detectedChain);
          setSubcategory(detectedSubcategory);
          setAvailableChains(chains);
          // Seed the editable identity from the detection.
          setIdentityValue({
            chain: detectedChain ?? undefined,
            subcategory: detectedSubcategory ?? undefined,
          });
          setDetailPending(false);
        })
        .catch(() => {
          if (detailGenRef.current !== gen) return;
          setDetectionFailed(true);
          setDetailPending(false);
        });
    } else {
      // Stock: seed what we can infer; the step lets the user confirm/edit.
      const r = a.raw as YahooSearchResult;
      setDetailPending(false);
      setIdentityValue({
        currency: r.currency ?? "USD",
        category: inferCategory(r.quoteType),
      });
    }
  }, []);

  const handleClose = useCallback(() => {
    setPicked(null);
    setIdentityValue({});
    setAvailableChains([]);
    setDetailPending(false);
    setDetectionFailed(false);
    onClose();
  }, [onClose]);

  // needsIdentity:
  //   crypto → while the /detail fetch is pending, force the step (never skip a
  //            multi-chain coin); once resolved, only multi-chain or detection
  //            failure needs disambiguation.
  //   stock  → always (the trading currency must be confirmed).
  const needsIdentity =
    assetClass === "crypto"
      ? detailPending || availableChains.length > 1 || detectionFailed
      : true;

  const handleSubmit = useCallback(
    async (submit: TransactionSubmit) => {
      if (!picked) return;

      const newCryptoAsset: CryptoAssetInput | undefined =
        assetClass === "crypto"
          ? {
              ticker: picked.raw.symbol.toUpperCase(),
              name: (picked.raw as CoinGeckoSearchResult).name,
              coingecko_id: (picked.raw as CoinGeckoSearchResult).id,
              chain: identityValue.chain ?? chain,
              subcategory: identityValue.subcategory ?? subcategory,
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
                // The EDITED currency wins over the raw Yahoo currency.
                currency: identityValue.currency ?? r.currency ?? "USD",
                category:
                  (identityValue.category as StockAssetInput["category"]) ??
                  inferCategory(r.quoteType),
                subcategory: identityValue.subcategory ?? null,
                tags: identityValue.tags,
                isin: identityValue.isin?.trim() || null,
              };
            })()
          : undefined;
      const cost = submit.cashflowOverride
        ? { amount: submit.cashflowOverride.amount, currency: submit.cashflowOverride.currency }
        : undefined;
      // Position metadata is crypto-only (stock/cash tables have no apy/method).
      const apy = assetClass === "crypto" ? identityValue.apy : undefined;
      const acquisitionMethod = assetClass === "crypto" ? identityValue.acquisitionMethod : undefined;

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
            // Crypto-only — ignored by the engine for stock destinations.
            apy,
            acquisitionMethod,
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
            // Crypto-only position metadata (first-buy only).
            apy,
            acquisitionMethod,
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
    [picked, assetClass, chain, subcategory, identityValue, onMutated, handleClose],
  );

  return (
    <TransactionModal
      isOpen={open}
      onClose={handleClose}
      assetClass={assetClass}
      assetName={picked?.ticker}
      initialType="buy"
      allowedTypes={["buy"]}
      pickerMode={{
        picked,
        onAssetPicked: handlePick,
        ownedTickers,
        needsIdentity,
        identityValue,
        onIdentityChange: setIdentityValue,
        availableChains,
        existingChains,
        existingSubcategories,
        existingTags,
        existingAssets,
        // "Not listed?" escape (stock only) — rendered inside the modal's
        // pre-pick search step. Closes this Buy modal, then hands off to the
        // parent's manual-NAV flow. Crypto has no manual-NAV path → undefined.
        onNotListed:
          assetClass === "stock" && onAddManualNav
            ? () => {
                handleClose();
                onAddManualNav();
              }
            : undefined,
      }}
      walletOptions={assetClass === "crypto" ? wallets : undefined}
      brokerOptions={assetClass === "stock" ? brokers : undefined}
      cashAccountOptions={cashAccounts}
      onSubmit={handleSubmit}
    />
  );
}
