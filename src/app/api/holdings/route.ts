import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
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
    const [profile, cryptoAssets, stockAssets, cashAccounts] =
      await Promise.all([
        getProfile(),
        getCryptoAssetsWithPositions(),
        getStockAssetsWithPositions(),
        getCashAccounts(),
      ]);

    const primaryCurrency = profile.primary_currency;

    const coinIds = [...new Set(cryptoAssets.map((a) => a.coingecko_id))];
    const yahooTickers = stockAssets.map((a) => a.yahoo_ticker || a.ticker);
    const allCurrencies = [
      ...new Set([
        "EUR",
        "USD",
        ...stockAssets.map((a) => a.currency),
        ...cashAccounts.map((a) => a.currency),
      ]),
    ];

    const [cryptoPrices, { stockPrices }, fxRates] = await Promise.all([
      getPrices(coinIds),
      getStockAndIndexPrices(yahooTickers),
      getFXRatesSafe(primaryCurrency, allCurrencies),
    ]);

    const holdings = buildPaletteHoldings({
      cryptoAssets, cryptoPrices, stockAssets, stockPrices,
      cashAccounts, fxRates,
      primaryCurrency, pathPrefix: "/dashboard",
    });

    return NextResponse.json(holdings);
  } catch (e) {
    console.error("[holdings] Failed to build palette holdings:", e);
    return NextResponse.json([], { status: 500 });
  }
}
