import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getPrices } from "@/lib/prices/coingecko";
import { getStockAndIndexPrices } from "@/lib/prices/yahoo";
import { getFXRatesSafe } from "@/lib/prices/fx";
import { getProfile } from "@/lib/actions/profile";
import type { HoldingItem } from "@/lib/types";

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json([], { status: 401 });
  }

  const [profile, cryptoAssets, stockAssets, bankAccounts, exchangeDeposits, brokerDeposits] =
    await Promise.all([
      getProfile(),
      getCryptoAssetsWithPositions(),
      getStockAssetsWithPositions(),
      getBankAccounts(),
      getExchangeDeposits(),
      getBrokerDeposits(),
    ]);

  const primaryCurrency = profile.primary_currency;

  const coinIds = [...new Set(cryptoAssets.map((a) => a.coingecko_id))];
  const yahooTickers = stockAssets.map((a) => a.yahoo_ticker || a.ticker).filter(Boolean);
  const allCurrencies = [
    ...new Set([
      "EUR",
      "USD",
      ...stockAssets.map((a) => a.currency),
      ...bankAccounts.map((a) => a.currency),
      ...exchangeDeposits.map((a) => a.currency),
      ...brokerDeposits.map((a) => a.currency),
    ]),
  ];

  const [cryptoPrices, { stockPrices }, fxRates] = await Promise.all([
    getPrices(coinIds),
    getStockAndIndexPrices(yahooTickers),
    getFXRatesSafe(primaryCurrency, allCurrencies),
  ]);

  const holdings: HoldingItem[] = [
    ...cryptoAssets.map((a) => {
      const price = cryptoPrices[a.coingecko_id];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const valueUsd = (price?.usd ?? 0) * totalQty;
      return {
        id: a.id,
        type: "crypto" as const,
        name: a.name,
        ticker: a.ticker.toUpperCase(),
        value: valueUsd * (fxRates["USD"] ?? 1),
        change24h: price?.usd_24h_change,
        icon: a.image_url,
        detailPath: "/dashboard/crypto",
      };
    }),
    ...stockAssets.map((a) => {
      const tick = a.yahoo_ticker || a.ticker;
      const price = stockPrices[tick];
      const totalQty = a.positions.reduce((s, p) => s + p.quantity, 0);
      const valueNative = (price?.price ?? 0) * totalQty;
      return {
        id: a.id,
        type: "stock" as const,
        name: a.name,
        ticker: a.ticker,
        value: valueNative * (fxRates[price?.currency ?? a.currency] ?? 1),
        change24h: price?.change24h,
        detailPath: "/dashboard/stocks",
      };
    }),
    ...bankAccounts.map((a) => ({
      id: a.id,
      type: "bank" as const,
      name: `${a.name} (${a.currency})`,
      value: a.balance * (fxRates[a.currency] ?? 1),
      detailPath: "/dashboard/cash",
    })),
    ...exchangeDeposits.map((d) => ({
      id: d.id,
      type: "exchange_deposit" as const,
      name: `${d.wallet_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: "/dashboard/cash",
    })),
    ...brokerDeposits.map((d) => ({
      id: d.id,
      type: "broker_deposit" as const,
      name: `${d.broker_name} ${d.currency}`,
      value: d.amount * (fxRates[d.currency] ?? 1),
      detailPath: "/dashboard/cash",
    })),
  ];

  return NextResponse.json(holdings);
}
