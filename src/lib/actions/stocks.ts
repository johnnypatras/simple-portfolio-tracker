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
import { validateQuantity, validateUUID, validateYahooTicker } from "@/lib/validation";
import { normalizeCategory } from "@/lib/stock-categories";

/** Get all stock assets with their positions and broker names */
export async function getStockAssetsWithPositions(): Promise<
  StockAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();

  // Round 1: fetch assets and all user brokers in parallel
  const [assetsResult, brokersResult] = await Promise.all([
    supabase
      .from("stock_assets")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("brokers")
      .select("id, name")
      .is("deleted_at", null),
  ]);

  if (assetsResult.error) throw new Error(assetsResult.error.message);
  const assets = assetsResult.data;
  if (!assets || assets.length === 0) return [];

  const brokersMap: Record<string, string> = Object.fromEntries(
    (brokersResult.data ?? []).map((b: Pick<Broker, "id" | "name">) => [b.id, b.name])
  );

  // Round 2: fetch positions (depends on asset IDs from round 1)
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("stock_positions")
    .select("*")
    .in("stock_asset_id", assetIds)
    .is("deleted_at", null);

  if (posErr) throw new Error(posErr.message);

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
export async function createStockAsset(input: StockAssetInput, opts?: { isAdjustment?: boolean }): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  if (input.yahoo_ticker) validateYahooTicker(input.yahoo_ticker);

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
        error.message?.includes("uq_stock_assets_yahoo_active") &&
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
      if (error.message?.includes("uq_stock_assets_ticker_active")) {
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
    is_adjustment: opts?.isAdjustment,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
  return data.id;
}

/** Update a stock asset's editable fields (name, yahoo_ticker, isin, category, subcategory, tags) */
export async function updateStockAsset(
  id: string,
  fields: {
    name?: string;
    yahoo_ticker?: string | null;
    isin?: string | null;
    category?: AssetCategory;
    subcategory?: string | null;
    tags?: string[];
  }
) {
  validateUUID(id, "Stock asset ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const updatePayload: Record<string, unknown> = {};
  if (fields.name !== undefined) updatePayload.name = fields.name.trim();
  if (fields.yahoo_ticker !== undefined) {
    if (fields.yahoo_ticker?.trim()) validateYahooTicker(fields.yahoo_ticker.trim());
    updatePayload.yahoo_ticker = fields.yahoo_ticker?.trim() || null;
  }
  if (fields.isin !== undefined) updatePayload.isin = fields.isin?.trim() || null;
  if (fields.category !== undefined) updatePayload.category = fields.category;
  if (fields.tags !== undefined) updatePayload.tags = fields.tags;
  if (fields.subcategory !== undefined) updatePayload.subcategory = fields.subcategory?.trim() || null;

  if (Object.keys(updatePayload).length === 0) return;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("stock_assets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("stock_assets")
    .update(updatePayload)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    if (error.code === "23505" && error.message?.includes("uq_stock_assets_yahoo_active")) {
      throw new Error("Another asset already uses this Yahoo ticker");
    }
    throw new Error(error.message);
  }

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

/** Soft-delete a stock asset — individually deletes child positions first for activity logging */
export async function deleteStockAsset(id: string, opts?: { isAdjustment?: boolean }) {
  validateUUID(id, "Stock asset ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Delete child positions individually so each gets an activity_log entry
  const { data: positions } = await supabase
    .from("stock_positions")
    .select("id")
    .eq("stock_asset_id", id)
    .is("deleted_at", null);

  if (positions?.length) {
    for (const pos of positions) {
      await deleteStockPosition(pos.id, opts ? { isAdjustment: opts.isAdjustment } : undefined);
    }
  }

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
export async function upsertStockPosition(input: StockPositionInput, opts?: {
  isAdjustment?: boolean;
  currentPriceNative?: number;
  assetCurrency?: string;
  transferGroupId?: string;
  effectiveDate?: string;
}) {
  validateQuantity(input.quantity, "Stock quantity");
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

      let deltaUsd: number | null = null;
      let deltaEur: number | null = null;
      let cashflowUsd: number | null = null;
      let cashflowEur: number | null = null;
      let cashflowAssetClass: string | null = null;
      let cashflowStatus: "complete" | "pending" | null = null;
      let deltaStatus: "complete" | "pending" | null = null;

      if (opts?.currentPriceNative) {
        const qty = (existing.quantity as number) ?? 0;
        const deltaNative = -(qty * opts.currentPriceNative);

        if (opts?.isAdjustment) {
          try {
            const { toUsdAndEur } = await import("@/lib/actions/activity-log");
            const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
            deltaUsd = converted.usd;
            deltaEur = converted.eur;
            deltaStatus = "complete";
          } catch (err) {
            console.error("[stocks] FX delta failed, marked pending:", err instanceof Error ? err.message : err);
            deltaStatus = "pending";
          }
        } else {
          try {
            const { toUsdAndEur } = await import("@/lib/actions/activity-log");
            const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
            const { classifyAssetClass } = await import("@/lib/cashflow");
            cashflowUsd = converted.usd;
            cashflowEur = converted.eur;
            cashflowAssetClass = classifyAssetClass("stock_position");
            cashflowStatus = "complete";
          } catch (err) {
            console.error("[stocks] FX cashflow failed, marked pending:", err instanceof Error ? err.message : err);
            cashflowStatus = "pending";
          }
        }
      }

      await logActivity({
        action: "removed",
        entity_type: "stock_position",
        entity_name: ticker,
        description: `Removed ${ticker} position (qty set to 0)`,
        entity_id: existing.id,
        entity_table: "stock_positions",
        before_snapshot: existing,
        after_snapshot: null,
        is_adjustment: opts?.isAdjustment,
        delta_usd: deltaUsd,
        delta_eur: deltaEur,
        delta_status: deltaStatus,
        cashflow_amount_usd: cashflowUsd,
        cashflow_amount_eur: cashflowEur,
        cashflow_asset_class: cashflowAssetClass,
        cashflow_status: cashflowStatus,
        transfer_group_id: opts?.transferGroupId,
        created_at: opts?.effectiveDate,
      });
    }
  } else {
    const { data: before } = await supabase
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id)
      .is("deleted_at", null)
      .single();

    if (before) {
      const { error } = await supabase.from("stock_positions").update({
        quantity: input.quantity,
        last_was_adjustment: opts?.isAdjustment ?? false,
        last_was_transfer: opts?.transferGroupId != null,
      }).eq("id", before.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("stock_positions").insert({
        stock_asset_id: input.stock_asset_id,
        broker_id: input.broker_id,
        quantity: input.quantity,
        last_was_adjustment: opts?.isAdjustment ?? false,
        last_was_transfer: opts?.transferGroupId != null,
      });
      if (error) {
        if (error.code === "23505") {
          const { data: existing } = await supabase
            .from("stock_positions")
            .select("*")
            .eq("stock_asset_id", input.stock_asset_id)
            .eq("broker_id", input.broker_id)
            .is("deleted_at", null)
            .single();
          if (!existing) throw new Error(error.message);
          const { error: updateErr } = await supabase.from("stock_positions").update({
            quantity: input.quantity,
            last_was_adjustment: opts?.isAdjustment ?? false,
            last_was_transfer: opts?.transferGroupId != null,
          }).eq("id", existing.id);
          if (updateErr) throw new Error(updateErr.message);
        } else {
          throw new Error(error.message);
        }
      }
    }

    // Capture after state
    const { data: after } = await supabase
      .from("stock_positions")
      .select("*")
      .eq("stock_asset_id", input.stock_asset_id)
      .eq("broker_id", input.broker_id)
      .is("deleted_at", null)
      .single();

    let deltaUsd: number | null = null;
    let deltaEur: number | null = null;
    let cashflowUsd: number | null = null;
    let cashflowEur: number | null = null;
    let cashflowAssetClass: string | null = null;
    let cashflowStatus: "complete" | "pending" | null = null;
    let deltaStatus: "complete" | "pending" | null = null;

    if (opts?.currentPriceNative) {
      const beforeQty = (before?.quantity as number) ?? 0;
      const afterQty = input.quantity;
      const qtyDelta = afterQty - beforeQty;
      const deltaNative = qtyDelta * opts.currentPriceNative;

      if (opts?.isAdjustment) {
        try {
          const { toUsdAndEur } = await import("@/lib/actions/activity-log");
          const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
          deltaUsd = converted.usd;
          deltaEur = converted.eur;
          deltaStatus = "complete";
        } catch (err) {
          console.error("[stocks] FX delta failed, marked pending:", err instanceof Error ? err.message : err);
          deltaStatus = "pending";
        }
      } else {
        try {
          const { toUsdAndEur } = await import("@/lib/actions/activity-log");
          const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts.effectiveDate?.split("T")[0]);
          const { classifyAssetClass } = await import("@/lib/cashflow");
          cashflowUsd = converted.usd;
          cashflowEur = converted.eur;
          cashflowAssetClass = classifyAssetClass("stock_position");
          cashflowStatus = "complete";
        } catch (err) {
          console.error("[stocks] FX cashflow failed, marked pending:", err instanceof Error ? err.message : err);
          cashflowStatus = "pending";
        }
      }
    }

    await logActivity({
      action: before ? "updated" : "created",
      entity_type: "stock_position",
      entity_name: ticker,
      description: `Set ${ticker} position to ${input.quantity}`,
      entity_id: after?.id ?? before?.id,
      entity_table: "stock_positions",
      before_snapshot: before,
      after_snapshot: after,
      is_adjustment: opts?.isAdjustment,
      delta_usd: deltaUsd,
      delta_eur: deltaEur,
      delta_status: deltaStatus,
      cashflow_amount_usd: cashflowUsd,
      cashflow_amount_eur: cashflowEur,
      cashflow_asset_class: cashflowAssetClass,
      cashflow_status: cashflowStatus,
      transfer_group_id: opts?.transferGroupId,
      created_at: opts?.effectiveDate,
    });
  }

  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}

/** Soft-delete a specific stock position */
export async function deleteStockPosition(positionId: string, opts?: {
  isAdjustment?: boolean;
  currentPriceNative?: number;
  assetCurrency?: string;
  transferGroupId?: string;
  effectiveDate?: string;
}) {
  validateUUID(positionId, "Stock position ID");
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

  let deltaUsd: number | null = null;
  let deltaEur: number | null = null;
  let cashflowUsd: number | null = null;
  let cashflowEur: number | null = null;
  let cashflowAssetClass: string | null = null;
  let cashflowStatus: "complete" | "pending" | null = null;
  let deltaStatus: "complete" | "pending" | null = null;

  if (snapshot) {
    const qty = (snapshot.quantity as number) ?? 0;
    const deltaNative = -(qty * (opts?.currentPriceNative ?? 0));

    if (opts?.isAdjustment) {
      try {
        const { toUsdAndEur } = await import("@/lib/actions/activity-log");
        const converted = await toUsdAndEur(deltaNative, opts.assetCurrency ?? "USD", opts?.effectiveDate?.split("T")[0]);
        deltaUsd = converted.usd;
        deltaEur = converted.eur;
        deltaStatus = "complete";
      } catch (err) {
        console.error("[stocks] FX delta failed, marked pending:", err instanceof Error ? err.message : err);
        deltaStatus = "pending";
      }
    } else {
      try {
        const { toUsdAndEur } = await import("@/lib/actions/activity-log");
        const converted = await toUsdAndEur(deltaNative, opts?.assetCurrency ?? "USD", opts?.effectiveDate?.split("T")[0]);
        const { classifyAssetClass } = await import("@/lib/cashflow");
        cashflowUsd = converted.usd;
        cashflowEur = converted.eur;
        cashflowAssetClass = classifyAssetClass("stock_position");
        cashflowStatus = "complete";
      } catch (err) {
        console.error("[stocks] FX cashflow failed, marked pending:", err instanceof Error ? err.message : err);
        cashflowStatus = "pending";
      }
    }
  }

  await logActivity({
    action: "removed",
    entity_type: "stock_position",
    entity_name: ticker,
    description: `Removed ${ticker} position`,
    entity_id: positionId,
    entity_table: "stock_positions",
    before_snapshot: snapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: deltaUsd,
    delta_eur: deltaEur,
    delta_status: deltaStatus,
    cashflow_amount_usd: cashflowUsd,
    cashflow_amount_eur: cashflowEur,
    cashflow_asset_class: cashflowAssetClass,
    cashflow_status: cashflowStatus,
    transfer_group_id: opts?.transferGroupId,
    created_at: opts?.effectiveDate,
  });
  revalidatePath("/dashboard/stocks");
  revalidatePath("/dashboard");
}
