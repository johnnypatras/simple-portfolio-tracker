import { NextRequest, NextResponse } from "next/server";
import { getCoinDetail, inferChain, inferSubcategory, getAvailableChains } from "@/lib/prices/coingecko";
import { rateLimit } from "@/lib/rate-limit";

const limiter = rateLimit({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const coinId = req.nextUrl.searchParams.get("id") ?? "";

  if (!coinId) {
    return NextResponse.json({ chain: "", subcategory: "", availableChains: [] });
  }

  const detail = await getCoinDetail(coinId);

  if (!detail) {
    return NextResponse.json({ chain: "", subcategory: "", availableChains: [] });
  }

  return NextResponse.json({
    chain: inferChain(coinId, detail),
    subcategory: inferSubcategory(detail.categories),
    availableChains: getAvailableChains(coinId, detail),
  });
}
