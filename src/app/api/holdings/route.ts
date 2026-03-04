import { NextRequest, NextResponse } from "next/server";
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
import { buildPaletteHoldings } from "@/lib/portfolio/holdings";
import { rateLimit } from "@/lib/rate-limit";

const limiter = rateLimit({ windowMs: 60_000, max: 30 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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
    const yahooTickers = stockAssets.map((a) => a.yahoo_ticker || a.ticker);
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

    const holdings = buildPaletteHoldings({
      cryptoAssets, cryptoPrices, stockAssets, stockPrices,
      bankAccounts, exchangeDeposits, brokerDeposits, fxRates,
      pathPrefix: "/dashboard",
    });

    return NextResponse.json(holdings);
  } catch (e) {
    console.error("[holdings] Failed to build palette holdings:", e);
    return NextResponse.json([], { status: 500 });
  }
}
