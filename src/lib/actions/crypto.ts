"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  CryptoAssetInput,
  CryptoAssetWithPositions,
  CryptoPositionInput,
  Wallet,
} from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";

/** Get all crypto assets with their positions and wallet names */
export async function getCryptoAssetsWithPositions(): Promise<
  CryptoAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();

  // Fetch assets (exclude soft-deleted)
  const { data: assets, error: assetsErr } = await supabase
    .from("crypto_assets")
    .select("*")
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (assetsErr) throw new Error(assetsErr.message);
  if (!assets || assets.length === 0) return [];

  // Fetch all positions for these assets (exclude soft-deleted)
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("crypto_positions")
    .select("*")
    .in("crypto_asset_id", assetIds)
    .is("deleted_at", null);

  if (posErr) throw new Error(posErr.message);

  // Fetch wallet names + types for display (exclude soft-deleted)
  const walletIds = [...new Set((positions ?? []).map((p) => p.wallet_id))];
  let walletsMap: Record<string, { name: string; wallet_type: Wallet["wallet_type"] }> = {};
  if (walletIds.length > 0) {
    const { data: wallets } = await supabase
      .from("wallets")
      .select("id, name, wallet_type")
      .in("id", walletIds)
      .is("deleted_at", null);
    walletsMap = Object.fromEntries(
      (wallets ?? []).map((w: Pick<Wallet, "id" | "name" | "wallet_type">) => [
        w.id,
        { name: w.name, wallet_type: w.wallet_type },
      ])
    );
  }

  // Merge
  return assets.map((asset) => ({
    ...asset,
    positions: (positions ?? [])
      .filter((p) => p.crypto_asset_id === asset.id)
      .map((p) => {
        const walletInfo = walletsMap[p.wallet_id];
        return {
          ...p,
          quantity: Number(p.quantity),
          apy: Number(p.apy ?? 0),
          wallet_name: walletInfo?.name ?? "Unknown",
          wallet_type: walletInfo?.wallet_type ?? "custodial" as const,
        };
      }),
  }));
}

/** Add a new crypto asset. Returns the new asset's id. */
export async function createCryptoAsset(input: CryptoAssetInput): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("crypto_assets")
    .insert({
      user_id: user.id,
      ticker: input.ticker.toUpperCase(),
      name: input.name,
      coingecko_id: input.coingecko_id,
      chain: input.chain ?? null,
      subcategory: input.subcategory?.trim() || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      // Asset already exists — return the existing id so a position can still be added
      const { data: existing } = await supabase
        .from("crypto_assets")
        .select("id")
        .eq("user_id", user.id)
        .eq("coingecko_id", input.coingecko_id)
        .is("deleted_at", null)
        .single();
      if (existing) {
        revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
        return existing.id;
      }
      throw new Error("This crypto asset is already in your portfolio");
    }
    throw new Error(error.message);
  }
  await logActivity({
    action: "created",
    entity_type: "crypto_asset",
    entity_name: `${input.ticker.toUpperCase()} (${input.name})`,
    description: `Added crypto asset ${input.ticker.toUpperCase()}`,
    entity_id: data.id,
    entity_table: "crypto_assets",
    before_snapshot: null,
    after_snapshot: data,
  });
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
  return data.id;
}

/** Update mutable fields on an existing crypto asset (chain, subcategory) */
export async function updateCryptoAsset(
  id: string,
  fields: { chain?: string | null; subcategory?: string | null }
) {
  const supabase = await createServerSupabaseClient();

  // Build dynamic payload — only include fields that were explicitly passed
  const updatePayload: Record<string, unknown> = {};
  if (fields.chain !== undefined) updatePayload.chain = fields.chain?.trim() || null;
  if (fields.subcategory !== undefined) updatePayload.subcategory = fields.subcategory?.trim() || null;
  if (Object.keys(updatePayload).length === 0) return;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("crypto_assets")
    .update(updatePayload)
    .eq("id", id);

  if (error) throw new Error(error.message);

  // Capture after snapshot
  const { data: after } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .single();

  const label = after ? `${after.ticker} (${after.name})` : "Unknown";
  await logActivity({
    action: "updated",
    entity_type: "crypto_asset",
    entity_name: label,
    description: `Updated ${after?.ticker ?? id} metadata`,
    entity_id: id,
    entity_table: "crypto_assets",
    before_snapshot: before,
    after_snapshot: after,
  });
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
}

/** Soft-delete a crypto asset (cascade trigger handles positions + goal_prices) */
export async function deleteCryptoAsset(id: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("crypto_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw new Error(error.message);
  const label = snapshot ? `${snapshot.ticker} (${snapshot.name})` : "Unknown";
  await logActivity({
    action: "removed",
    entity_type: "crypto_asset",
    entity_name: label,
    description: `Removed crypto asset ${snapshot?.ticker ?? id}`,
    entity_id: id,
    entity_table: "crypto_assets",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
}

/** Upsert a position (set quantity for a crypto asset in a specific wallet) */
export async function upsertPosition(input: CryptoPositionInput) {
  const supabase = await createServerSupabaseClient();

  // Fetch asset ticker for logging
  const { data: asset } = await supabase
    .from("crypto_assets")
    .select("ticker")
    .eq("id", input.crypto_asset_id)
    .single();
  const ticker = asset?.ticker ?? "Unknown";

  if (input.quantity <= 0) {
    // Soft-delete the position if quantity is zero or negative
    const { data: existing } = await supabase
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id)
      .is("deleted_at", null)
      .single();

    if (existing) {
      const { error } = await supabase
        .from("crypto_positions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      await logActivity({
        action: "removed",
        entity_type: "crypto_position",
        entity_name: ticker,
        description: `Removed ${ticker} position (qty set to 0)`,
        entity_id: existing.id,
        entity_table: "crypto_positions",
        before_snapshot: existing,
        after_snapshot: null,
      });
    }
  } else {
    // Capture before state if updating
    const { data: before } = await supabase
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id)
      .is("deleted_at", null)
      .single();

    const { error } = await supabase.from("crypto_positions").upsert(
      {
        crypto_asset_id: input.crypto_asset_id,
        wallet_id: input.wallet_id,
        quantity: input.quantity,
        acquisition_method: input.acquisition_method ?? "bought",
        apy: input.apy ?? 0,
      },
      { onConflict: "crypto_asset_id,wallet_id" }
    );
    if (error) throw new Error(error.message);

    // Capture after state
    const { data: after } = await supabase
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id)
      .is("deleted_at", null)
      .single();

    await logActivity({
      action: before ? "updated" : "created",
      entity_type: "crypto_position",
      entity_name: ticker,
      description: `Set ${ticker} position to ${input.quantity}`,
      entity_id: after?.id ?? before?.id,
      entity_table: "crypto_positions",
      before_snapshot: before,
      after_snapshot: after,
    });
  }

  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
}

/** Soft-delete a specific position */
export async function deletePosition(positionId: string) {
  const supabase = await createServerSupabaseClient();

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("crypto_positions")
    .select("*, crypto_assets(ticker)")
    .eq("id", positionId)
    .single();
  const ticker =
    (snapshot?.crypto_assets as unknown as { ticker: string } | null)?.ticker ?? "Unknown";

  const { error } = await supabase
    .from("crypto_positions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", positionId);

  if (error) throw new Error(error.message);
  await logActivity({
    action: "removed",
    entity_type: "crypto_position",
    entity_name: ticker,
    description: `Removed ${ticker} position`,
    entity_id: positionId,
    entity_table: "crypto_positions",
    before_snapshot: snapshot,
    after_snapshot: null,
  });
  revalidatePath("/dashboard/crypto");
  revalidatePath("/dashboard");
}
