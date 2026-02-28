"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  AssetCategory,
  StockAssetInput,
  StockAssetWithPositions,
  StockPositionInput,
  Broker,
} from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/** Normalize old DB category values (pre-migration-022) to current enum */
const OLD_CAT_MAP: Record<string, AssetCategory> = {
  stock: "individual_stock",
  etf_ucits: "etf",
  etf_non_ucits: "etf",
  bond: "bond_fixed_income",
};
function normalizeCategory(raw: string | null | undefined): AssetCategory {
  if (!raw) return "individual_stock";
  return OLD_CAT_MAP[raw] ?? (raw as AssetCategory);
}

/** Get all stock assets with their positions and broker names */
export async function getStockAssetsWithPositions(): Promise<
  StockAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();

  // Fetch assets (exclude soft-deleted)
  const { data: assets, error: assetsErr } = await supabase
    .from("stock_assets")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (assetsErr) throw new Error(assetsErr.message);
  if (!assets || assets.length === 0) return [];

  // Fetch all positions for these assets (exclude soft-deleted)
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("stock_positions")
    .select("*")
    .in("stock_asset_id", assetIds)
    .is("deleted_at", null);

  if (posErr) throw new Error(posErr.message);

  // Fetch broker names for display (exclude soft-deleted)
  const brokerIds = [...new Set((positions ?? []).map((p) => p.broker_id))];
  let brokersMap: Record<string, string> = {};
  if (brokerIds.length > 0) {
    const { data: brokers } = await supabase
      .from("brokers")
      .select("id, name")
      .in("id", brokerIds)
      .is("deleted_at", null);
    brokersMap = Object.fromEntries(
      (brokers ?? []).map((b: Pick<Broker, "id" | "name">) => [b.id, b.name])
    );
  }

  // Merge (normalize old category values so all consumers see current enum)
  return assets.map((asset) => ({
    ...asset,
    category: normalizeCategory(asset.category),
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

  const category = input.category ?? "individual_stock";
  const tags = input.tags ?? [];

  const { data, error } = await supabase
    .from("stock_assets")
    .insert({
      user_id: user.id,
      ticker: input.ticker.toUpperCase(),
      name: input.name,
      isin: input.isin ?? null,
      yahoo_ticker: input.yahoo_ticker ?? null,
      category,
      tags,
      currency: input.currency ?? "USD",
      subcategory: input.subcategory?.trim() || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      // Asset already exists — return existing ID so position creation can proceed
      if (
        error.message?.includes("stock_assets_user_yahoo_ticker_unique") &&
        input.yahoo_ticker
      ) {
        const { data: existing } = await supabase
          .from("stock_assets")
          .select("id")
          .eq("user_id", user.id)
          .eq("yahoo_ticker", input.yahoo_ticker)
          .is("deleted_at", null)
          .single();
        if (existing) return existing.id;
      }
      if (error.message?.includes("stock_assets_user_ticker_no_yahoo_unique")) {
        const { data: existing } = await supabase
          .from("stock_assets")
          .select("id")
          .eq("user_id", user.id)
          .eq("ticker", input.ticker.toUpperCase())
          .is("yahoo_ticker", null)
          .is("deleted_at", null)
          .single();
        if (existing) return existing.id;
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
    entity_id: data.id,
    entity_table: "stock_assets",
    before_snapshot: null,
    after_snapshot: data,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
  return data.id;
}

/** Update a stock asset's editable fields (category, subcategory, tags) */
export async function updateStockAsset(
  id: string,
  fields: { category?: AssetCategory; subcategory?: string | null; tags?: string[] }
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const updatePayload: Record<string, unknown> = {};
  if (fields.category !== undefined) updatePayload.category = fields.category;
  if (fields.tags !== undefined) updatePayload.tags = fields.tags;
  if (fields.subcategory !== undefined) updatePayload.subcategory = fields.subcategory?.trim() || null;

  if (Object.keys(updatePayload).length === 0) return;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("stock_assets")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("stock_assets")
    .update(updatePayload)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);

  // Capture after snapshot
  const { data: after } = await supabase
    .from("stock_assets")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  const label = after ? `${after.ticker} (${after.name})` : "Unknown";
  await logActivity({
    action: "updated",
    entity_type: "stock_asset",
    entity_name: label,
    description: `Updated ${after?.ticker ?? id} metadata`,
    entity_id: id,
    entity_table: "stock_assets",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}

/** Soft-delete a stock asset (cascade trigger handles positions) */
export async function deleteStockAsset(id: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("stock_assets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("stock_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) throw new Error(error.message);
  const label = snapshot ? `${snapshot.ticker} (${snapshot.name})` : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "stock_asset",
    entity_name: label,
    description: `Removed stock asset ${snapshot?.ticker ?? id}`,
    entity_id: id,
    entity_table: "stock_assets",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}

/** Upsert a position (set quantity for a stock asset at a specific broker) */
export async function upsertStockPosition(input: StockPositionInput) {
  const supabase = await createServerSupabaseClient();

  // Fetch asset ticker for logging
  const { data: asset } = await supabase
    .from("stock_assets")
    .select("ticker")
    .eq("id", input.stock_asset_id)
    .is("deleted_at", null)
    .single();
  const ticker = asset?.ticker ?? "Unknown";

  if (input.quantity <= 0) {
    // Soft-delete the position if quantity is zero or negative
    const { data: existing } = await supabase
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id)
      .is("deleted_at", null)
      .single();

    if (existing) {
      const { error } = await supabase
        .from("stock_positions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      await logActivity({
        action: "removed",
        entity_type: "stock_position",
        entity_name: ticker,
        description: `Removed ${ticker} position (qty set to 0)`,
        entity_id: existing.id,
        entity_table: "stock_positions",
        before_snapshot: existing,
        after_snapshot: null,
      });
    }
  } else {
    // Capture before state if updating
    const { data: before } = await supabase
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id)
      .is("deleted_at", null)
      .single();

    const { error } = before
      ? await supabase.from("stock_positions").update({
          quantity: input.quantity,
        }).eq("id", before.id)
      : await supabase.from("stock_positions").insert({
          stock_asset_id: input.stock_asset_id,
          broker_id: input.broker_id,
          quantity: input.quantity,
        });
    if (error) throw new Error(error.message);

    // Capture after state
    const { data: after } = await supabase
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id)
      .is("deleted_at", null)
      .single();

    await logActivity({
      action: before ? "updated" : "created",
      entity_type: "stock_position",
      entity_name: ticker,
      description: `Set ${ticker} position to ${input.quantity}`,
      entity_id: after?.id ?? before?.id,
      entity_table: "stock_positions",
      before_snapshot: before,
      after_snapshot: after,
    });
  }

  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}

/** Soft-delete a specific stock position */
export async function deleteStockPosition(positionId: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("stock_positions")
    .select("*, stock_assets(ticker)")
    .eq("id", positionId)
    .is("deleted_at", null)
    .single();
  const ticker =
    (snapshot?.stock_assets as unknown as { ticker: string } | null)?.ticker ?? "Unknown";

  const { error } = await supabase
    .from("stock_positions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", positionId);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "stock_position",
    entity_name: ticker,
    description: `Removed ${ticker} position`,
    entity_id: positionId,
    entity_table: "stock_positions",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}
