"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import type {
  AcquisitionType,
  CryptoAssetInput,
  CryptoAssetWithPositions,
  CryptoPositionInput,
  Wallet,
} from "@/lib/types";
import { logActivity } from "@/lib/actions/activity-log";
import { getCoinImage } from "@/lib/prices/coingecko";
import { partialUpdate } from "@/lib/partial-update";
import { validateQuantity, validateUUID, validateCoinGeckoId, validateName, validateImageUrl, validateApy } from "@/lib/validation";
import { computeActivityFx, emptyFx } from "@/lib/activity-fx";
import { captureAction } from "@/lib/actions/with-sentry";
import { PG_UNIQUE_VIOLATION } from "@/lib/supabase/error-codes";

/** Get all crypto assets with their positions and wallet names */
export async function getCryptoAssetsWithPositions(): Promise<
  CryptoAssetWithPositions[]
> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  // Round 1: fetch assets and all user wallets in parallel
  const [assetsResult, walletsResult] = await Promise.all([
    supabase
      .from("crypto_assets")
      .select("*")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("wallets")
      .select("id, name, wallet_type")
      .eq("user_id", user.id)
      .is("deleted_at", null),
  ]);

  if (assetsResult.error) throw new Error(assetsResult.error.message);
  const assets = assetsResult.data;
  if (!assets || assets.length === 0) return [];

  const walletsMap: Record<string, { name: string; wallet_type: Wallet["wallet_type"] }> =
    Object.fromEntries(
      (walletsResult.data ?? []).map((w: Pick<Wallet, "id" | "name" | "wallet_type">) => [
        w.id,
        { name: w.name, wallet_type: w.wallet_type },
      ])
    );

  // Round 2: fetch positions (depends on asset IDs from round 1)
  const assetIds = assets.map((a) => a.id);
  const { data: positions, error: posErr } = await supabase
    .from("crypto_positions")
    .select("*")
    .in("crypto_asset_id", assetIds)
    .is("deleted_at", null);

  if (posErr) throw new Error(posErr.message);

  // Merge
  return assets.map<CryptoAssetWithPositions>((asset) => ({
    ...asset,
    positions: (positions ?? [])
      .filter((p) => p.crypto_asset_id === asset.id)
      .map((p) => {
        const walletInfo = walletsMap[p.wallet_id];
        return {
          ...p,
          quantity: Number(p.quantity),
          apy: Number(p.apy ?? 0),
          // DB stores acquisition_method as free-text constrained by validation;
          // narrow to the domain enum at the boundary.
          acquisition_method: (p.acquisition_method ?? "bought") as AcquisitionType,
          wallet_name: walletInfo?.name ?? "Unknown",
          wallet_type: walletInfo?.wallet_type ?? "custodial" as const,
        };
      }),
  }));
}

/** Add a new crypto asset. Returns the new asset's id. */
export async function createCryptoAsset(input: CryptoAssetInput, opts?: { isAdjustment?: boolean; effectiveDate?: string }): Promise<string> {
  return captureAction("crypto.createCryptoAsset", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  validateName(input.name, 100, "Name");
  if (input.ticker) validateName(input.ticker, 20, "Ticker");
  validateCoinGeckoId(input.coingecko_id);
  const trimmedChain = input.chain?.trim() || null;
  if (trimmedChain) validateName(trimmedChain, 50, "Chain");

  const { data, error } = await supabase
    .from("crypto_assets")
    .insert({
      user_id: user.id,
      ticker: input.ticker.toUpperCase(),
      name: input.name,
      coingecko_id: input.coingecko_id,
      chain: trimmedChain,
      subcategory: input.subcategory?.trim() || null,
      image_url: validateImageUrl(input.image_url),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // Asset already exists — return the existing id so a position can still be added
      // Must match chain too: constraint is (user_id, coingecko_id, COALESCE(chain, ''))
      // Supabase query builder methods return new builders — must reassign, not chain in-place
      const baseQ = supabase
        .from("crypto_assets")
        .select("id")
        .eq("user_id", user.id)
        .eq("coingecko_id", input.coingecko_id)
        .is("deleted_at", null);
      const q = trimmedChain ? baseQ.eq("chain", trimmedChain) : baseQ.is("chain", null);
      const { data: existing } = await q.single();
      if (existing) {
        revalidateDashboard();
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
    is_adjustment: opts?.isAdjustment,
    effective_date: opts?.effectiveDate,
  });
  revalidateDashboard();
  return data.id;
  });
}

/** Update mutable fields on an existing crypto asset (chain, subcategory) */
export async function updateCryptoAsset(
  id: string,
  fields: { chain?: string | null; subcategory?: string | null }
) {
  return captureAction("crypto.updateCryptoAsset", async () => {
  validateUUID(id, "Crypto asset ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Normalize inputs once; partialUpdate() strips `undefined` keys so that
  // "not provided" is distinguished from "explicitly null". validateName
  // runs only when a non-empty trimmed value is provided.
  let normalizedChain: string | null | undefined;
  if (fields.chain !== undefined) {
    normalizedChain = fields.chain?.trim() || null;
    if (normalizedChain) validateName(normalizedChain, 50, "Chain");
  }
  const normalizedSubcategory = fields.subcategory !== undefined
    ? (fields.subcategory?.trim() || null)
    : undefined;

  const updatePayload = partialUpdate({
    chain: normalizedChain,
    subcategory: normalizedSubcategory,
  });
  if (Object.keys(updatePayload).length === 0) return;

  // Capture before snapshot
  const { data: before } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("crypto_assets")
    .update(updatePayload)
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const ticker = before?.ticker?.toUpperCase() ?? "this asset";
      throw new Error(
        `You already have ${ticker} on the "${normalizedChain ?? "no chain"}" chain. Use the existing entry instead.`
      );
    }
    throw new Error(error.message);
  }

  // Capture after snapshot
  const { data: after } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
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
  revalidateDashboard();
  });
}

/** Soft-delete a crypto asset — individually deletes child positions first for activity logging */
export async function deleteCryptoAsset(id: string, opts?: { isAdjustment?: boolean }) {
  return captureAction("crypto.deleteCryptoAsset", async () => {
  validateUUID(id, "Crypto asset ID");
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Delete child positions individually so each gets an activity_log entry
  const { data: positions, error: positionsError } = await supabase
    .from("crypto_positions")
    .select("id")
    .eq("crypto_asset_id", id)
    .is("deleted_at", null);
  if (positionsError) throw new Error(`Failed to fetch crypto positions: ${positionsError.message}`);

  if (positions?.length) {
    for (const pos of positions) {
      await deletePosition(pos.id, opts ? { isAdjustment: opts.isAdjustment } : undefined);
    }
  }

  // Capture full snapshot before soft-delete
  const { data: snapshot } = await supabase
    .from("crypto_assets")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  const { error } = await supabase
    .from("crypto_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

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
  revalidateDashboard();
  });
}

/** Upsert a position (set quantity for a crypto asset in a specific wallet) */
export async function upsertPosition(input: CryptoPositionInput, opts?: {
  isAdjustment?: boolean;
  currentPriceUsd?: number;
  currentPriceEur?: number;
  transferGroupId?: string;
  effectiveDate?: string;
}) {
  return captureAction("crypto.upsertPosition", async () => {
  validateUUID(input.crypto_asset_id, "Crypto asset ID");
  validateUUID(input.wallet_id, "Wallet ID");
  validateQuantity(input.quantity, "Crypto quantity");
  if (input.apy != null) validateApy(input.apy, "APY");
  // Preserve undefined for the update path so partialUpdate() can strip it;
  // the insert path explicitly falls back to null at its call site below.
  let normalizedNetwork: string | null | undefined;
  if (input.network !== undefined) {
    normalizedNetwork = input.network?.trim() || null;
    if (normalizedNetwork) validateName(normalizedNetwork, 50, "Network");
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Fetch asset ticker and subcategory for logging and cashflow classification
  const { data: asset } = await supabase
    .from("crypto_assets")
    .select("ticker, subcategory")
    .eq("id", input.crypto_asset_id)
    .is("deleted_at", null)
    .single();
  const ticker = asset?.ticker ?? "Unknown";
  const { isStablecoin } = await import("@/lib/cashflow");
  const isStable = isStablecoin(asset?.subcategory);

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
      // Defense-in-depth: scope update by crypto_asset_id as well. crypto_positions
      // has no direct user_id column, so ownership is enforced via RLS + the
      // input.crypto_asset_id that was already validated above.
      const { error } = await supabase
        .from("crypto_positions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", existing.id)
        .eq("crypto_asset_id", input.crypto_asset_id);
      if (error) throw new Error(error.message);

      const qty = (existing.quantity as number) ?? 0;
      const valUsd = -(qty * (opts?.currentPriceUsd ?? 0));
      const valEur = -(qty * (opts?.currentPriceEur ?? 0));
      const fx = (opts?.currentPriceUsd != null || opts?.currentPriceEur != null)
        ? await computeActivityFx({ valUsd, valEur, isAdjustment: opts?.isAdjustment, entityType: "crypto_position", isStable })
        : emptyFx();

      await logActivity({
        action: "removed",
        entity_type: "crypto_position",
        entity_name: ticker,
        description: `Removed ${ticker} position (qty set to 0)`,
        entity_id: existing.id,
        entity_table: "crypto_positions",
        before_snapshot: existing,
        after_snapshot: null,
        is_adjustment: opts?.isAdjustment,
        delta_usd: fx.deltaUsd,
        delta_eur: fx.deltaEur,
        delta_status: fx.deltaStatus,
        cashflow_amount_usd: fx.cashflowUsd,
        cashflow_amount_eur: fx.cashflowEur,
        cashflow_asset_class: fx.cashflowAssetClass,
        cashflow_status: fx.cashflowStatus,
        transfer_group_id: opts?.transferGroupId,
        effective_date: opts?.effectiveDate,
      });
    }
  } else {
    const { data: before } = await supabase
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id)
      .is("deleted_at", null)
      .single();

    if (before) {
      const { error } = await supabase.from("crypto_positions").update(partialUpdate({
        quantity: input.quantity,
        acquisition_method: input.acquisition_method,
        apy: input.apy,
        network: normalizedNetwork,
        last_was_adjustment: opts?.isAdjustment ?? false,
        last_was_transfer: opts?.transferGroupId != null,
      })).eq("id", before.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("crypto_positions").insert({
        crypto_asset_id: input.crypto_asset_id,
        wallet_id: input.wallet_id,
        quantity: input.quantity,
        acquisition_method: input.acquisition_method ?? "bought",
        apy: input.apy ?? 0,
        network: normalizedNetwork ?? null,
        last_was_adjustment: opts?.isAdjustment ?? false,
        last_was_transfer: opts?.transferGroupId != null,
      });
      if (error) {
        if (error.code === PG_UNIQUE_VIOLATION) {
          const { data: existing } = await supabase
            .from("crypto_positions")
            .select("*")
            .eq("crypto_asset_id", input.crypto_asset_id)
            .eq("wallet_id", input.wallet_id)
            .is("deleted_at", null)
            .single();
          if (!existing) throw new Error(error.message);
          const { error: updateErr } = await supabase.from("crypto_positions").update(partialUpdate({
            quantity: input.quantity,
            acquisition_method: input.acquisition_method,
            apy: input.apy,
            network: normalizedNetwork,
            last_was_adjustment: opts?.isAdjustment ?? false,
            last_was_transfer: opts?.transferGroupId != null,
          })).eq("id", existing.id);
          if (updateErr) throw new Error(updateErr.message);
        } else {
          throw new Error(error.message);
        }
      }
    }

    // Capture after state
    const { data: after } = await supabase
      .from("crypto_positions")
      .select("*")
      .eq("crypto_asset_id", input.crypto_asset_id)
      .eq("wallet_id", input.wallet_id)
      .is("deleted_at", null)
      .single();

    const beforeQty = (before?.quantity as number) ?? 0;
    const afterQty = input.quantity;
    const qtyDelta = afterQty - beforeQty;
    const valUsd = qtyDelta * (opts?.currentPriceUsd ?? 0);
    const valEur = qtyDelta * (opts?.currentPriceEur ?? 0);
    const fx = (opts?.currentPriceUsd != null || opts?.currentPriceEur != null)
      ? await computeActivityFx({ valUsd, valEur, isAdjustment: opts?.isAdjustment, entityType: "crypto_position", isStable })
      : emptyFx();

    await logActivity({
      action: before ? "updated" : "created",
      entity_type: "crypto_position",
      entity_name: ticker,
      description: `Set ${ticker} position to ${input.quantity}`,
      entity_id: after?.id ?? before?.id,
      entity_table: "crypto_positions",
      before_snapshot: before,
      after_snapshot: after,
      is_adjustment: opts?.isAdjustment,
      delta_usd: fx.deltaUsd,
      delta_eur: fx.deltaEur,
      delta_status: fx.deltaStatus,
      cashflow_amount_usd: fx.cashflowUsd,
      cashflow_amount_eur: fx.cashflowEur,
      cashflow_asset_class: fx.cashflowAssetClass,
      cashflow_status: fx.cashflowStatus,
      transfer_group_id: opts?.transferGroupId,
      effective_date: opts?.effectiveDate,
    });
  }

  revalidateDashboard();
  });
}

/** Soft-delete a specific position */
export async function deletePosition(positionId: string, opts?: {
  isAdjustment?: boolean;
  currentPriceUsd?: number;
  currentPriceEur?: number;
  transferGroupId?: string;
  effectiveDate?: string;
}) {
  return captureAction("crypto.deletePosition", async () => {
  validateUUID(positionId, "Crypto position ID");
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Capture full snapshot before soft-delete (join parent to verify ownership)
  const { data: snapshot } = await supabase
    .from("crypto_positions")
    .select("*, crypto_assets(user_id, ticker, subcategory)")
    .eq("id", positionId)
    .is("deleted_at", null)
    .single();

  if (!snapshot) throw new Error("Position not found");
  const parentAsset = snapshot.crypto_assets as { user_id: string; ticker: string; subcategory?: string } | null;
  if (!parentAsset || parentAsset.user_id !== user.id) throw new Error("Position not found");

  const ticker = parentAsset.ticker ?? "Unknown";
  const { isStablecoin } = await import("@/lib/cashflow");
  const isStable = isStablecoin(parentAsset.subcategory);

  // Defense-in-depth: also scope by crypto_asset_id derived from parent ownership
  // check above. RLS is the primary guard; this belt-and-suspenders prevents a
  // mis-wired call site from deleting a position through a stale id.
  const { error } = await supabase
    .from("crypto_positions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", positionId)
    .eq("crypto_asset_id", snapshot.crypto_asset_id);

  if (error) throw new Error(error.message);

  const qty = (snapshot?.quantity as number) ?? 0;
  const valUsd = -(qty * (opts?.currentPriceUsd ?? 0));
  const valEur = -(qty * (opts?.currentPriceEur ?? 0));
  const fx = (snapshot && (opts?.currentPriceUsd != null || opts?.currentPriceEur != null))
    ? await computeActivityFx({ valUsd, valEur, isAdjustment: opts?.isAdjustment, entityType: "crypto_position", isStable })
    : emptyFx();

  await logActivity({
    action: "removed",
    entity_type: "crypto_position",
    entity_name: ticker,
    description: `Removed ${ticker} position`,
    entity_id: positionId,
    entity_table: "crypto_positions",
    before_snapshot: snapshot,
    after_snapshot: null,
    is_adjustment: opts?.isAdjustment,
    delta_usd: fx.deltaUsd,
    delta_eur: fx.deltaEur,
    delta_status: fx.deltaStatus,
    cashflow_amount_usd: fx.cashflowUsd,
    cashflow_amount_eur: fx.cashflowEur,
    cashflow_asset_class: fx.cashflowAssetClass,
    cashflow_status: fx.cashflowStatus,
    transfer_group_id: opts?.transferGroupId,
    effective_date: opts?.effectiveDate,
  });
  revalidateDashboard();
  });
}

/**
 * Backfill image_url for crypto assets that don't have one yet.
 * Safe to call on every page load — only fetches for NULL rows,
 * and processes sequentially to respect CoinGecko rate limits.
 */
export async function backfillCryptoImages() {
  return captureAction("crypto.backfillCryptoImages", async () => {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: missing } = await supabase
    .from("crypto_assets")
    .select("id, coingecko_id")
    .is("image_url", null)
    .is("deleted_at", null);

  if (!missing || missing.length === 0) return;

  const batch = missing.slice(0, 3);
  const results = await Promise.allSettled(
    batch.map(async (asset) => {
      const thumbUrl = await getCoinImage(asset.coingecko_id);
      const safeUrl = validateImageUrl(thumbUrl);
      if (safeUrl) {
        const { error: updateErr } = await supabase
          .from("crypto_assets")
          .update({ image_url: safeUrl })
          .eq("id", asset.id)
          .eq("user_id", user.id);
        if (updateErr) console.warn(`[backfill] Failed to update image for ${asset.coingecko_id}:`, updateErr.message);
      }
    })
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[backfill] Failed:", result.reason);
    }
  }

  if (batch.length > 0) {
    revalidateDashboard();
  }
  });
}
