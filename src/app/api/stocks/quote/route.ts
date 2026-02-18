import { NextRequest, NextResponse } from "next/server";
import { getStockQuote } from "@/lib/prices/yahoo";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";

  if (!symbol) {
    return NextResponse.json(null);
  }

  const quote = await getStockQuote(symbol);
  return NextResponse.json(quote);
}
