import type { CoinGeckoSearchResult, CoinGeckoPriceData } from "@/lib/types";

const BASE_URL = "https://api.coingecko.com/api/v3";

function apiKey(): string {
  return process.env.NEXT_PUBLIC_COINGECKO_API_KEY ?? "";
}

function headers(): HeadersInit {
  const key = apiKey();
  return key ? { "x-cg-demo-api-key": key } : {};
}

/**
 * Search for coins by name or ticker.
 * Returns up to 10 results sorted by market cap rank.
 */
export async function searchCoins(
  query: string
): Promise<CoinGeckoSearchResult[]> {
  if (!query.trim()) return [];

  const url = `${BASE_URL}/search?query=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 300 } });

  if (!res.ok) {
    console.error("[coingecko] Search failed:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  return (data.coins ?? []).slice(0, 10).map(
    (c: Record<string, unknown>) => ({
      id: c.id as string,
      name: c.name as string,
      symbol: c.symbol as string,
      thumb: c.thumb as string,
      large: c.large as string,
      market_cap_rank: (c.market_cap_rank as number) ?? null,
    })
  );
}

/**
 * Fetch current prices for multiple coins in a single request.
 * Returns USD and EUR prices with 24h change percentages.
 */
export async function getPrices(
  coinIds: string[]
): Promise<CoinGeckoPriceData> {
  if (coinIds.length === 0) return {};

  const ids = coinIds.join(",");
  const url = `${BASE_URL}/simple/price?ids=${ids}&vs_currencies=usd,eur&include_24hr_change=true`;
  const res = await fetch(url, { headers: headers(), next: { revalidate: 60 } });

  if (!res.ok) {
    console.error("[coingecko] Price fetch failed:", res.status);
    return {};
  }

  return res.json();
}
