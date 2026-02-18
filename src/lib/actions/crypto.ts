"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type {
  CryptoAssetInput,
  CryptoAssetWithPositions,
  CryptoPositionInput,
  Wallet,
} from "@/lib/types";

/** Get all crypto assets with their positions and wallet names */
export async function getCryptoAssetsWithPositions(): Promise<
  CryptoAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();

  // Fetch assets
  const { data: assets, error: assetsErr } = await supabase
    .from("crypto_assets")
    .select("*")
    .order("created_at", { ascending: true });

  if (assetsErr) throw new Error(assetsErr.message);
  if (!assets || assets.length === 0) return [];

  // Fetch all positions for these assets
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("crypto_positions")
    .select("*")
    .in("crypto_asset_id", assetIds);

  if (posErr) throw new Error(posErr.message);

  // Fetch wallet names for display
  const walletIds = [...new Set((positions ?? []).map((p) => p.wallet_id))];
  let walletsMap: Record<string, string> = {};
  if (walletIds.length > 0) {
    const { data: wallets } = await supabase
      .from("wallets")
      .select("id, name")
      .in("id", walletIds);
    walletsMap = Object.fromEntries(
      (wallets ?? []).map((w: Pick<Wallet, "id" | "name">) => [w.id, w.name])
    );
  }

  // Merge
  return assets.map((asset) => ({
    ...asset,
    positions: (positions ?? [])
      .filter((p) => p.crypto_asset_id === asset.id)
      .map((p) => ({
        ...p,
        quantity: Number(p.quantity),
        wallet_name: walletsMap[p.wallet_id] ?? "Unknown",
      })),
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
      acquisition_method: input.acquisition_method ?? null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error("This crypto asset is already in your portfolio");
    }
    throw new Error(error.message);
  }
  revalidatePath("/dashboard/crypto");
  return data.id;
}

/** Remove a crypto asset and all its positions (CASCADE) */
export async function deleteCryptoAsset(id: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("crypto_assets").delete().eq("id", id);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/crypto");
}

/** Upsert a position (set quantity for a crypto asset in a specific wallet) */
export async function upsertPosition(input: CryptoPositionInput) {
  const supabase = await createServerSupabaseClient();

  if (input.quantity <= 0) {
    // Remove the position if quantity is zero or negative
    const { error } = await supabase
      .from("crypto_positions")
      .delete()
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("crypto_positions").upsert(
      {
        crypto_asset_id: input.crypto_asset_id,
        wallet_id: input.wallet_id,
        quantity: input.quantity,
      },
      { onConflict: "crypto_asset_id,wallet_id" }
    );
    if (error) throw new Error(error.message);
  }

  revalidatePath("/dashboard/crypto");
}

/** Delete a specific position */
export async function deletePosition(positionId: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("crypto_positions")
    .delete()
    .eq("id", positionId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/crypto");
}
