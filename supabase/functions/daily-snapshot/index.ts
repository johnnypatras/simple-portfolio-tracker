import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─── Config ────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const COINGECKO_API_KEY = Deno.env.get("COINGECKO_API_KEY") ?? "";

const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest";

// ─── Types ─────────────────────────────────────────────────

interface UserHoldings {
  userId: string;
  cryptoAssets: { coingecko_id: string; subcategory: string | null; quantity: number }[];
  stockAssets: { yahoo_ticker: string; ticker: string; currency: string; quantity: number }[];
  cashItems: { currency: string; amount: number }[];
}

interface YahooQuote {
  price: number;
  currency: string;
}

// ─── Main handler ──────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Auth check
  const authHeader = req.headers.get("Authorization") ?? "";
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1. Fetch all active users
    const { data: users, error: usersErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("status", "active");

    if (usersErr) throw new Error(`Failed to fetch users: ${usersErr.message}`);
    if (!users || users.length === 0) {
      return jsonResponse({ message: "No active users", snapshots: 0 });
    }

    const userIds = users.map((u: { id: string }) => u.id);

    // 2. Bulk-fetch all holdings across all users (service-role bypasses RLS)
    const [
      { data: cryptoAssets },
      { data: cryptoPositions },
      { data: stockAssets },
      { data: stockPositions },
      { data: bankAccounts },
      { data: exchangeDeposits },
      { data: brokerDeposits },
    ] = await Promise.all([
      supabase.from("crypto_assets").select("id, user_id, coingecko_id, subcategory").is("deleted_at", null).in("user_id", userIds),
      supabase.from("crypto_positions").select("id, crypto_asset_id, quantity").is("deleted_at", null),
      supabase.from("stock_assets").select("id, user_id, ticker, yahoo_ticker, currency").is("deleted_at", null).in("user_id", userIds),
      supabase.from("stock_positions").select("id, stock_asset_id, quantity").is("deleted_at", null),
      supabase.from("bank_accounts").select("user_id, currency, balance").is("deleted_at", null).in("user_id", userIds),
      supabase.from("exchange_deposits").select("user_id, currency, amount").is("deleted_at", null).in("user_id", userIds),
      supabase.from("broker_deposits").select("user_id, currency, amount").is("deleted_at", null).in("user_id", userIds),
    ]);

    // 3. Build per-user holdings and deduplicated price request sets
    const coinIdSet = new Set<string>();
    const yahooTickerSet = new Set<string>();
    const currencySet = new Set<string>(["USD", "EUR"]);

    // Index crypto positions by asset ID
    const positionsByAsset = new Map<string, number>();
    for (const p of cryptoPositions ?? []) {
      const current = positionsByAsset.get(p.crypto_asset_id) ?? 0;
      positionsByAsset.set(p.crypto_asset_id, current + Number(p.quantity));
    }

    // Index stock positions by asset ID
    const stockPosByAsset = new Map<string, number>();
    for (const p of stockPositions ?? []) {
      const current = stockPosByAsset.get(p.stock_asset_id) ?? 0;
      stockPosByAsset.set(p.stock_asset_id, current + Number(p.quantity));
    }

    // Build per-user holdings
    const userHoldings = new Map<string, UserHoldings>();
    for (const userId of userIds) {
      userHoldings.set(userId, {
        userId,
        cryptoAssets: [],
        stockAssets: [],
        cashItems: [],
      });
    }

    // Crypto assets
    for (const asset of cryptoAssets ?? []) {
      const qty = positionsByAsset.get(asset.id) ?? 0;
      if (qty === 0) continue;
      coinIdSet.add(asset.coingecko_id);
      const holdings = userHoldings.get(asset.user_id);
      if (holdings) {
        holdings.cryptoAssets.push({
          coingecko_id: asset.coingecko_id,
          subcategory: asset.subcategory,
          quantity: qty,
        });
      }
    }

    // Stock assets
    for (const asset of stockAssets ?? []) {
      const qty = stockPosByAsset.get(asset.id) ?? 0;
      if (qty === 0) continue;
      const yahooTicker = asset.yahoo_ticker || asset.ticker;
      yahooTickerSet.add(yahooTicker);
      currencySet.add(asset.currency);
      const holdings = userHoldings.get(asset.user_id);
      if (holdings) {
        holdings.stockAssets.push({
          yahoo_ticker: yahooTicker,
          ticker: asset.ticker,
          currency: asset.currency,
          quantity: qty,
        });
      }
    }

    // Cash items (bank accounts + exchange deposits + broker deposits)
    for (const bank of bankAccounts ?? []) {
      const amt = Number(bank.balance);
      if (amt === 0) continue;
      currencySet.add(bank.currency);
      const holdings = userHoldings.get(bank.user_id);
      if (holdings) holdings.cashItems.push({ currency: bank.currency, amount: amt });
    }
    for (const dep of exchangeDeposits ?? []) {
      const amt = Number(dep.amount);
      if (amt === 0) continue;
      currencySet.add(dep.currency);
      const holdings = userHoldings.get(dep.user_id);
      if (holdings) holdings.cashItems.push({ currency: dep.currency, amount: amt });
    }
    for (const dep of brokerDeposits ?? []) {
      const amt = Number(dep.amount);
      if (amt === 0) continue;
      currencySet.add(dep.currency);
      const holdings = userHoldings.get(dep.user_id);
      if (holdings) holdings.cashItems.push({ currency: dep.currency, amount: amt });
    }

    // 4. Batch price fetches (4 API calls in parallel)
    const allTickers = [...yahooTickerSet];
    const [cryptoPrices, yahooQuotes, fxUsd, fxEur] = await Promise.all([
      fetchCoinGeckoPrices([...coinIdSet]),
      fetchYahooBatch(allTickers),
      fetchFxRates("USD", [...currencySet].filter((c) => c !== "USD")),
      fetchFxRates("EUR", [...currencySet].filter((c) => c !== "EUR")),
    ]);

    // 4b. Fall back to v8/chart for any tickers missing from v7 batch
    const missingTickers = allTickers.filter((t) => !yahooQuotes.has(t));
    if (missingTickers.length > 0) {
      console.log(`[daily-snapshot] v7 missing ${missingTickers.length} tickers, falling back to v8/chart`);
      const CHUNK_SIZE = 20;
      for (let i = 0; i < missingTickers.length; i += CHUNK_SIZE) {
        const chunk = missingTickers.slice(i, i + CHUNK_SIZE);
        const results = await Promise.allSettled(
          chunk.map((ticker) => fetchYahooSingle(ticker))
        );
        results.forEach((result, j) => {
          if (result.status === "fulfilled" && result.value) {
            yahooQuotes.set(chunk[j], result.value);
          }
        });
      }
    }

    // 5. Compute snapshots for each user
    const today = new Date().toISOString().split("T")[0];
    const snapshots: {
      user_id: string;
      snapshot_date: string;
      total_value_usd: number;
      total_value_eur: number;
      crypto_value_usd: number;
      stocks_value_usd: number;
      cash_value_usd: number;
    }[] = [];

    for (const [userId, holdings] of userHoldings) {
      let cryptoValueUsd = 0;
      let cryptoValueEur = 0;
      let stablecoinValueUsd = 0;
      let stablecoinValueEur = 0;

      // Crypto values (CoinGecko gives USD + EUR directly)
      for (const asset of holdings.cryptoAssets) {
        const price = cryptoPrices[asset.coingecko_id];
        if (!price) continue;
        const isStable = asset.subcategory?.toLowerCase() === "stablecoin";
        if (isStable) {
          stablecoinValueUsd += asset.quantity * (price.usd ?? 0);
          stablecoinValueEur += asset.quantity * (price.eur ?? 0);
        } else {
          cryptoValueUsd += asset.quantity * (price.usd ?? 0);
          cryptoValueEur += asset.quantity * (price.eur ?? 0);
        }
      }

      // Stock values (convert native currency → USD and EUR via FX)
      let stocksValueUsd = 0;
      let stocksValueEur = 0;
      for (const asset of holdings.stockAssets) {
        const quote = yahooQuotes.get(asset.yahoo_ticker);
        if (!quote) continue;
        const valueNative = asset.quantity * quote.price;
        stocksValueUsd += convertToBase(valueNative, quote.currency, "USD", fxUsd);
        stocksValueEur += convertToBase(valueNative, quote.currency, "EUR", fxEur);
      }

      // Cash values (convert each currency → USD and EUR via FX)
      let fiatCashValueUsd = 0;
      let fiatCashValueEur = 0;
      for (const item of holdings.cashItems) {
        fiatCashValueUsd += convertToBase(item.amount, item.currency, "USD", fxUsd);
        fiatCashValueEur += convertToBase(item.amount, item.currency, "EUR", fxEur);
      }

      // Cash = fiat + stablecoins (matching aggregate.ts logic)
      const cashValueUsd = fiatCashValueUsd + stablecoinValueUsd;
      const totalValueUsd = cryptoValueUsd + stocksValueUsd + cashValueUsd;
      const totalValueEur = cryptoValueEur + stocksValueEur + fiatCashValueEur + stablecoinValueEur;

      snapshots.push({
        user_id: userId,
        snapshot_date: today,
        total_value_usd: round2(totalValueUsd),
        total_value_eur: round2(totalValueEur),
        crypto_value_usd: round2(cryptoValueUsd),
        stocks_value_usd: round2(stocksValueUsd),
        cash_value_usd: round2(cashValueUsd),
      });
    }

    // 6. Batch upsert all snapshots
    if (snapshots.length > 0) {
      const { error: upsertErr } = await supabase
        .from("portfolio_snapshots")
        .upsert(snapshots, { onConflict: "user_id,snapshot_date" });

      if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
    }

    return jsonResponse({
      message: "Snapshots saved",
      snapshots: snapshots.length,
      prices: { coins: coinIdSet.size, stocks: yahooTickerSet.size, currencies: currencySet.size },
      v8Fallback: missingTickers.length,
    });
  } catch (err) {
    console.error("[daily-snapshot] Error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

// ─── Price fetchers ────────────────────────────────────────

async function fetchCoinGeckoPrices(
  coinIds: string[]
): Promise<Record<string, { usd: number; eur: number }>> {
  if (coinIds.length === 0) return {};
  try {
    const ids = coinIds.join(",");
    const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd,eur`;
    const headers: Record<string, string> = {};
    if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error("[daily-snapshot] CoinGecko error:", res.status);
      return {};
    }
    return await res.json();
  } catch (err) {
    console.error("[daily-snapshot] CoinGecko fetch error:", err);
    return {};
  }
}

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  try {
    // Step 1: Get session cookies
    const cookieRes = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
    });
    const setCookies = cookieRes.headers.getSetCookie?.() ?? [];
    const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) return null;

    // Step 2: Exchange cookies for crumb
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("Unauthorized")) return null;

    return { crumb, cookie };
  } catch (err) {
    console.error("[daily-snapshot] Yahoo crumb error:", err);
    return null;
  }
}

async function fetchYahooBatch(
  symbols: string[]
): Promise<Map<string, YahooQuote>> {
  const map = new Map<string, YahooQuote>();
  if (symbols.length === 0) return map;
  try {
    const auth = await getYahooCrumb();
    if (!auth) {
      console.error("[daily-snapshot] Yahoo crumb auth failed");
      return map;
    }

    const url = `${YAHOO_QUOTE_URL}?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Cookie: auth.cookie },
    });
    if (!res.ok) {
      console.error("[daily-snapshot] Yahoo error:", res.status);
      return map;
    }
    const json = await res.json();
    const quotes = json?.quoteResponse?.result;
    if (!Array.isArray(quotes)) return map;

    for (const q of quotes) {
      if (!q.symbol) continue;
      map.set(q.symbol, {
        price: q.regularMarketPrice ?? 0,
        currency: q.currency ?? "USD",
      });
    }
  } catch (err) {
    console.error("[daily-snapshot] Yahoo fetch error:", err);
  }
  return map;
}

async function fetchYahooSingle(ticker: string): Promise<YahooQuote | null> {
  try {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return {
      price: meta.regularMarketPrice ?? 0,
      currency: meta.currency ?? "USD",
    };
  } catch (err) {
    console.error(`[daily-snapshot] v8 fallback error for ${ticker}:`, err);
    return null;
  }
}

async function fetchFxRates(
  base: string,
  targets: string[]
): Promise<Record<string, number>> {
  const symbols = [...new Set(targets.filter((t) => t !== base))];
  if (symbols.length === 0) return { [base]: 1 };
  try {
    const url = `${FRANKFURTER_URL}?base=${base}&symbols=${symbols.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[daily-snapshot] Frankfurter error:", res.status);
      return { [base]: 1 };
    }
    const data = await res.json();
    return { ...data.rates, [base]: 1 };
  } catch (err) {
    console.error("[daily-snapshot] FX fetch error:", err);
    return { [base]: 1 };
  }
}

// ─── Helpers ───────────────────────────────────────────────

function convertToBase(
  amount: number,
  fromCurrency: string,
  baseCurrency: string,
  rates: Record<string, number>
): number {
  if (fromCurrency === baseCurrency) return amount;
  const rate = rates[fromCurrency];
  if (!rate || rate === 0) return amount;
  // rates[X] = X per 1 base → base = amount / rates[X]
  return amount / rate;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
