import { NextRequest, NextResponse } from "next/server";
import { getStockQuote } from "@/lib/prices/yahoo";
import { rateLimit } from "@/lib/rate-limit";

const limiter = rateLimit({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";

  if (!symbol) {
    return NextResponse.json(null);
  }

  const quote = await getStockQuote(symbol);
  return NextResponse.json(quote);
}
