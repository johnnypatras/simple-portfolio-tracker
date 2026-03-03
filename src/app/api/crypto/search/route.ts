import { NextRequest, NextResponse } from "next/server";
import { searchCoins, getPrices } from "@/lib/prices/coingecko";
import { rateLimit } from "@/lib/rate-limit";

const limiter = rateLimit({ windowMs: 60_000, max: 30 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const query = req.nextUrl.searchParams.get("q") ?? "";

  if (query.length < 2) {
    return NextResponse.json([]);
  }

  const results = await searchCoins(query);

  // Enrich with current USD prices via a single batch request
  if (results.length > 0) {
    const coinIds = results.map((r) => r.id);
    const prices = await getPrices(coinIds);

    return NextResponse.json(
      results.map((coin) => ({
        ...coin,
        price_usd: prices[coin.id]?.usd ?? undefined,
      }))
    );
  }

  return NextResponse.json(results);
}
