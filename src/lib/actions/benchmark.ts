"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchIndexHistory } from "@/lib/prices/yahoo";
import { fetchCoinHistory } from "@/lib/prices/coingecko";

// ─── Cash Flow Event ─────────────────────────────────────

export interface CashFlowEvent {
  date: string;       // YYYY-MM-DD
  amount_usd: number; // positive = deposit, negative = withdrawal
}

// ─── Price history helpers ───────────────────────────────

type PriceMap = Map<string, number>; // date → price

function buildPriceMap(
  history: { date: string; close?: number; price?: number }[]
): PriceMap {
  const map = new Map<string, number>();
  // Sort ascending so getPrice's break-on-first-future-date is correct
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of sorted) {
    const val = p.close ?? p.price;
    if (val != null) map.set(p.date, val);
  }
  return map;
}

function getPrice(map: PriceMap, date: string): number | undefined {
  const exact = map.get(date);
  if (exact != null) return exact;
  let best: number | undefined;
  for (const [d, p] of map) {
    if (d <= date) best = p;
    else break;
  }
  return best;
}

/**
 * Derive cash flow events from the activity log.
 *
 * The activity log contains "created", "updated", and "removed" events
 * for all asset types, with full before/after snapshots that include
 * exact quantities, amounts, and currencies.
 *
 * For cash assets (deposits, bank accounts): use amount/balance directly.
 * For positions (crypto, stocks): use quantity × historical market price.
 * EUR and other non-USD currencies: converted using actual FX rate on date.
 */
export async function deriveCashFlows(userId?: string): Promise<CashFlowEvent[]> {
  // When userId is provided (share page), use admin client to bypass RLS
  const supabase = userId ? createAdminClient() : await createServerSupabaseClient();

  // ── Step 1: Fetch activity log entries with non-null snapshots ──
  let query = supabase
    .from("activity_log")
    .select("action, entity_type, before_snapshot, after_snapshot, created_at")
    .in("entity_type", [
      "exchange_deposit", "broker_deposit", "bank_account",
      "crypto_position", "stock_position",
    ])
    .in("action", ["created", "updated", "removed"]);
  if (userId) query = query.eq("user_id", userId);
  const { data: allLogs, error } = await query.order("created_at", { ascending: true });

  if (error || !allLogs || allLogs.length === 0) return [];

  // Filter to entries that have at least one non-null snapshot
  const logs = allLogs.filter(
    (r) => r.before_snapshot != null || r.after_snapshot != null
  );

  if (logs.length === 0) return [];

  // ── Step 2: Collect unique parent asset IDs and currencies from snapshots ──
  const cryptoAssetIds = new Set<string>();
  const stockAssetIds = new Set<string>();
  const cashCurrencies = new Set<string>(); // non-USD currencies from deposits/bank accounts

  for (const row of logs) {
    if (row.entity_type === "crypto_position") {
      const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
      const id = snap?.crypto_asset_id as string | undefined;
      if (id) cryptoAssetIds.add(id);
    } else if (row.entity_type === "stock_position") {
      const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
      const id = snap?.stock_asset_id as string | undefined;
      if (id) stockAssetIds.add(id);
    } else {
      // Collect currencies from deposit/bank account snapshots
      const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
      const cur = snap?.currency as string | undefined;
      if (cur && cur !== "USD") cashCurrencies.add(cur);
    }
  }

  // ── Step 3: Look up parent assets for price identifiers ──
  const needsEurUsd = cashCurrencies.has("EUR");
  const [cryptoAssetsResult, stockAssetsResult, eurUsdHistory] = await Promise.all([
    cryptoAssetIds.size > 0
      ? supabase.from("crypto_assets").select("id, coingecko_id").in("id", [...cryptoAssetIds])
      : Promise.resolve({ data: [] as { id: string; coingecko_id: string }[] }),
    stockAssetIds.size > 0
      ? supabase.from("stock_assets").select("id, yahoo_ticker, ticker, currency").in("id", [...stockAssetIds])
      : Promise.resolve({ data: [] as { id: string; yahoo_ticker: string | null; ticker: string; currency: string }[] }),
    needsEurUsd
      ? fetchIndexHistory("EURUSD=X", 365)
      : Promise.resolve([] as { date: string; close: number }[]),
  ]);

  const cryptoAssetMap = new Map<string, string>();
  for (const a of cryptoAssetsResult.data ?? []) {
    if (a.coingecko_id) cryptoAssetMap.set(a.id, a.coingecko_id);
  }

  const stockAssetMap = new Map<string, { ticker: string; currency: string }>();
  for (const a of stockAssetsResult.data ?? []) {
    const ticker = a.yahoo_ticker || a.ticker;
    if (ticker) stockAssetMap.set(a.id, { ticker, currency: a.currency });
  }

  // Check if any stock asset is EUR-denominated (wasn't known before Step 3)
  const hasEurStocks = [...stockAssetMap.values()].some((s) => s.currency === "EUR");

  // ── Step 4: Fetch historical prices ──
  const uniqueCoinIds = [...new Set(cryptoAssetMap.values())];
  const uniqueStockTickers = [...new Set([...stockAssetMap.values()].map((s) => s.ticker))];
  // Collect non-USD/non-EUR currencies from both stock assets AND cash entity snapshots
  const allFxCurrencies = new Set<string>();
  for (const s of stockAssetMap.values()) {
    if (s.currency && s.currency !== "USD" && s.currency !== "EUR") allFxCurrencies.add(s.currency);
  }
  for (const c of cashCurrencies) {
    if (c !== "EUR") allFxCurrencies.add(c); // EUR handled separately via eurUsdMap
  }
  const stockCurrencies = [...allFxCurrencies];

  // If EUR stocks exist but EUR/USD wasn't fetched in Step 3, fetch it now
  const needsEurUsdLate = hasEurStocks && !needsEurUsd;
  const [cryptoHistories, stockHistories, lateEurUsd, ...fxHistories] = await Promise.all([
    Promise.all(uniqueCoinIds.map(async (coinId) => {
      const history = await fetchCoinHistory(coinId, 365);
      return [coinId, buildPriceMap(history)] as const;
    })),
    Promise.all(uniqueStockTickers.map(async (ticker) => {
      const history = await fetchIndexHistory(ticker, 365);
      return [ticker, buildPriceMap(history)] as const;
    })),
    needsEurUsdLate
      ? fetchIndexHistory("EURUSD=X", 365)
      : Promise.resolve([] as { date: string; close: number }[]),
    ...stockCurrencies.map(async (currency) => {
      const history = await fetchIndexHistory(`${currency}USD=X`, 365);
      return [currency, buildPriceMap(history)] as const;
    }),
  ]);

  const cryptoPrices = new Map<string, PriceMap>(cryptoHistories);
  const stockPrices = new Map<string, PriceMap>(stockHistories);
  const fxPrices = new Map<string, PriceMap>(fxHistories);
  // Merge both possible EUR/USD sources
  const eurUsdMap = buildPriceMap([...eurUsdHistory, ...lateEurUsd]);

  // ── Helper: convert any currency to USD ──
  function toUsd(amount: number, currency: string | undefined, date: string): number {
    if (!currency || currency === "USD") return amount;
    if (currency === "EUR") {
      const rate = getPrice(eurUsdMap, date) ?? (fxPrices.get("EUR") ? getPrice(fxPrices.get("EUR")!, date) : undefined);
      return rate != null ? amount * rate : amount * 1.08;
    }
    const fxMap = fxPrices.get(currency);
    if (fxMap) {
      const rate = getPrice(fxMap, date);
      if (rate != null) return amount * rate;
    }
    return amount;
  }

  // ── Step 5: Process all activity log events ──
  const events: CashFlowEvent[] = [];

  for (const row of logs) {
    const date = row.created_at.split("T")[0];
    const before = row.before_snapshot as Record<string, unknown> | null;
    const after = row.after_snapshot as Record<string, unknown> | null;
    let deltaUsd = 0;

    if (row.entity_type === "exchange_deposit" || row.entity_type === "broker_deposit") {
      const bAmt = (before?.amount as number) ?? 0;
      const aAmt = (after?.amount as number) ?? 0;
      const bCur = before?.currency as string | undefined;
      const aCur = after?.currency as string | undefined;
      if (row.action === "created") deltaUsd = toUsd(aAmt, aCur, date);
      else if (row.action === "updated") deltaUsd = toUsd(aAmt, aCur, date) - toUsd(bAmt, bCur, date);
      else if (row.action === "removed") deltaUsd = -toUsd(bAmt, bCur, date);
    } else if (row.entity_type === "bank_account") {
      const bBal = (before?.balance as number) ?? 0;
      const aBal = (after?.balance as number) ?? 0;
      const bCur = before?.currency as string | undefined;
      const aCur = after?.currency as string | undefined;
      if (row.action === "created") deltaUsd = toUsd(aBal, aCur, date);
      else if (row.action === "updated") deltaUsd = toUsd(aBal, aCur, date) - toUsd(bBal, bCur, date);
      else if (row.action === "removed") deltaUsd = -toUsd(bBal, bCur, date);
    } else if (row.entity_type === "crypto_position") {
      const bQty = (before?.quantity as number) ?? 0;
      const aQty = (after?.quantity as number) ?? 0;
      const assetId = (after?.crypto_asset_id ?? before?.crypto_asset_id) as string | undefined;
      const coinId = assetId ? cryptoAssetMap.get(assetId) : undefined;
      const priceMap = coinId ? cryptoPrices.get(coinId) : undefined;
      const price = priceMap ? getPrice(priceMap, date) : undefined;
      if (price != null) {
        if (row.action === "created") deltaUsd = aQty * price;
        else if (row.action === "updated") deltaUsd = (aQty - bQty) * price;
        else if (row.action === "removed") deltaUsd = -(bQty * price);
      }
    } else if (row.entity_type === "stock_position") {
      const bQty = (before?.quantity as number) ?? 0;
      const aQty = (after?.quantity as number) ?? 0;
      const assetId = (after?.stock_asset_id ?? before?.stock_asset_id) as string | undefined;
      const stockInfo = assetId ? stockAssetMap.get(assetId) : undefined;
      const priceMap = stockInfo ? stockPrices.get(stockInfo.ticker) : undefined;
      const price = priceMap ? getPrice(priceMap, date) : undefined;
      if (price != null && stockInfo) {
        let deltaLocal = 0;
        if (row.action === "created") deltaLocal = aQty * price;
        else if (row.action === "updated") deltaLocal = (aQty - bQty) * price;
        else if (row.action === "removed") deltaLocal = -(bQty * price);
        deltaUsd = toUsd(deltaLocal, stockInfo.currency, date);
      }
    }

    if (Math.abs(deltaUsd) > 0.01) {
      events.push({ date, amount_usd: deltaUsd });
    }
  }

  return events;
}
