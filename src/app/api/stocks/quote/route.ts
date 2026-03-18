import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getStockQuote } from "@/lib/prices/yahoo";
import { rateLimit } from "@/lib/rate-limit";
import { validateYahooTicker } from "@/lib/validation";

const limiter = rateLimit({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";

  if (!symbol) {
    return NextResponse.json(null);
  }

  try { validateYahooTicker(symbol); } catch {
    return NextResponse.json({ error: "Invalid ticker symbol" }, { status: 400 });
  }

  const quote = await getStockQuote(symbol);
  return NextResponse.json(quote);
}
