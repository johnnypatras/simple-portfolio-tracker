import { NextRequest, NextResponse } from "next/server";
import { searchCoins } from "@/lib/prices/coingecko";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "";

  if (query.length < 2) {
    return NextResponse.json([]);
  }

  const results = await searchCoins(query);
  return NextResponse.json(results);
}
