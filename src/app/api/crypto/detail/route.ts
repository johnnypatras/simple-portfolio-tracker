import { NextRequest, NextResponse } from "next/server";
import { getCoinDetail, inferChain, inferSubcategory, getAvailableChains } from "@/lib/prices/coingecko";

export async function GET(req: NextRequest) {
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
