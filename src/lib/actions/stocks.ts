"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  StockAssetInput,
  StockAssetWithPositions,
  StockPositionInput,
  Broker,
} from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/** Get all stock assets with their positions and broker names */
export async function getStockAssetsWithPositions(): Promise<
  StockAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();

  // Fetch assets
  const { data: assets, error: assetsErr } = await supabase
    .from("stock_assets")
    .select("*")
    .order("created_at", { ascending: true });

  if (assetsErr) throw new Error(assetsErr.message);
  if (!assets || assets.length === 0) return [];

  // Fetch all positions for these assets
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("stock_positions")
    .select("*")
    .in("stock_asset_id", assetIds);

  if (posErr) throw new Error(posErr.message);

  // Fetch broker names for display
  const brokerIds = [...new Set((positions ?? []).map((p) => p.broker_id))];
  let brokersMap: Record<string, string> = {};
  if (brokerIds.length > 0) {
    const { data: brokers } = await supabase
      .from("brokers")
      .select("id, name")
      .in("id", brokerIds);
    brokersMap = Object.fromEntries(
      (brokers ?? []).map((b: Pick<Broker, "id" | "name">) => [b.id, b.name])
    );
  }

  // Merge
  return assets.map((asset) => ({
    ...asset,
    positions: (positions ?? [])
      .filter((p) => p.stock_asset_id === asset.id)
      .map((p) => ({
        ...p,
        quantity: Number(p.quantity),
        broker_name: brokersMap[p.broker_id] ?? "Unknown",
      })),
  }));
}

/** Add a new stock/ETF asset. Returns the new asset's id. */
export async function createStockAsset(input: StockAssetInput): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("stock_assets")
    .insert({
      user_id: user.id,
      ticker: input.ticker.toUpperCase(),
      name: input.name,
      isin: input.isin ?? null,
      yahoo_ticker: input.yahoo_ticker ?? null,
      category: input.category ?? "stock",
      currency: input.currency ?? "USD",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      if (error.message?.includes("stock_assets_user_yahoo_ticker_unique")) {
        throw new Error("You already have this exact exchange listing in your portfolio");
      }
      throw new Error("This stock/ETF is already in your portfolio");
    }
    throw new Error(error.message);
  }
  await logActivity({
    action: "created",
    entity_type: "stock_asset",
    entity_name: `${input.ticker.toUpperCase()} (${input.name})`,
    description: `Added stock asset ${input.ticker.toUpperCase()}`,
    details: { ...input },
  });
  revalidatePath("/dashboard/stocks");
  return data.id;
}

/** Remove a stock asset and all its positions (CASCADE) */
export async function deleteStockAsset(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data: existing } = await supabase
    .from("stock_assets")
    .select("ticker, name")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("stock_assets").delete().eq("id", id);

  if (error) throw new Error(error.message);
  const label = existing ? `${existing.ticker} (${existing.name})` : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "stock_asset",
    entity_name: label,
    description: `Removed stock asset ${existing?.ticker ?? id}`,
  });
  revalidatePath("/dashboard/stocks");
}

/** Upsert a position (set quantity for a stock asset at a specific broker) */
export async function upsertStockPosition(input: StockPositionInput) {
  const supabase = await createServerSupabaseClient();

  // Fetch asset ticker for logging
  const { data: asset } = await supabase
    .from("stock_assets")
    .select("ticker")
    .eq("id", input.stock_asset_id)
    .single();
  const ticker = asset?.ticker ?? "Unknown";

  if (input.quantity <= 0) {
    // Remove the position if quantity is zero or negative
    const { error } = await supabase
      .from("stock_positions")
      .delete()
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id);
    if (error) throw new Error(error.message);
    await logActivity({
      action: "removed",
      entity_type: "stock_position",
      entity_name: ticker,
      description: `Removed ${ticker} position (qty set to 0)`,
      details: { ...input },
    });
  } else {
    const { error } = await supabase.from("stock_positions").upsert(
      {
        stock_asset_id: input.stock_asset_id,
        broker_id: input.broker_id,
        quantity: input.quantity,
      },
      { onConflict: "stock_asset_id,broker_id" }
    );
    if (error) throw new Error(error.message);
    await logActivity({
      action: "updated",
      entity_type: "stock_position",
      entity_name: ticker,
      description: `Set ${ticker} position to ${input.quantity}`,
      details: { ...input },
    });
  }

  revalidatePath("/dashboard/stocks");
}

/** Delete a specific position */
export async function deleteStockPosition(positionId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: pos } = await supabase
    .from("stock_positions")
    .select("stock_asset_id, stock_assets(ticker)")
    .eq("id", positionId)
    .single();
  const ticker =
    (pos?.stock_assets as unknown as { ticker: string } | null)?.ticker ?? "Unknown";

  const { error } = await supabase
    .from("stock_positions")
    .delete()
    .eq("id", positionId);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "stock_position",
    entity_name: ticker,
    description: `Removed ${ticker} position`,
  });
  revalidatePath("/dashboard/stocks");
}
