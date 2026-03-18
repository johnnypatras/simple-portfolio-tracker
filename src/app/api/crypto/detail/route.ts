import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCoinDetail, inferChain, inferSubcategory, getAvailableChains } from "@/lib/prices/coingecko";
import { rateLimit } from "@/lib/rate-limit";
import { validateCoinGeckoId } from "@/lib/validation";

const limiter = rateLimit({ windowMs: 60_000, max: 60 });

export async function GET(req: NextRequest) {
  const limited = limiter(req);
  if (limited) return limited;

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const coinId = req.nextUrl.searchParams.get("id") ?? "";

  if (!coinId) {
    return NextResponse.json({ chain: "", subcategory: "", availableChains: [] });
  }

  try { validateCoinGeckoId(coinId); } catch {
    return NextResponse.json({ error: "Invalid coin ID" }, { status: 400 });
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
