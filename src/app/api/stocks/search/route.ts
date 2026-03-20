import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { searchStocks, fetchQuotesBatch } from "@/lib/prices/yahoo";
import { rateLimit } from "@/lib/rate-limit";

const limiter = rateLimit({ windowMs: 60_000, max: 30 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const query = req.nextUrl.searchParams.get("q") ?? "";

  if (query.length < 2 || query.length > 100) {
    return NextResponse.json([]);
  }

  const results = await searchStocks(query);

  // Enrich all results with trading currency + price in a single batch request
  const symbols = results.map((r) => r.symbol);
  const quotes = await fetchQuotesBatch(symbols);

  const enriched = results.map((result) => {
    const quote = quotes.get(result.symbol);
    return {
      ...result,
      currency: quote?.currency,
      price: quote?.price,
    };
  });

  return NextResponse.json(enriched);
}
