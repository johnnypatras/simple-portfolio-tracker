import { NextRequest, NextResponse } from "next/server";
import { searchStocks, getStockQuote } from "@/lib/prices/yahoo";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "";

  if (query.length < 2) {
    return NextResponse.json([]);
  }

  const results = await searchStocks(query);

  // Enrich each result with actual trading currency from chart API
  // Fire all requests in parallel — failures gracefully return no currency
  const enriched = await Promise.all(
    results.map(async (result) => {
      const quote = await getStockQuote(result.symbol);
      return {
        ...result,
        currency: quote?.currency,
        price: quote?.price,
      };
    })
  );

  return NextResponse.json(enriched);
}
