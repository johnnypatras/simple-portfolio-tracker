import { NextRequest, NextResponse } from "next/server";
import { getCoinDetail, inferChain, inferSubcategory } from "@/lib/prices/coingecko";

export async function GET(req: NextRequest) {
  const coinId = req.nextUrl.searchParams.get("id") ?? "";

  if (!coinId) {
    return NextResponse.json({ chain: "", subcategory: "" });
  }

  const detail = await getCoinDetail(coinId);

  if (!detail) {
    return NextResponse.json({ chain: "", subcategory: "" });
  }

  return NextResponse.json({
    chain: inferChain(coinId, detail),
    subcategory: inferSubcategory(detail.categories),
  });
}
