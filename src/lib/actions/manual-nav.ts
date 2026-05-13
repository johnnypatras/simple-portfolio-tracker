"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createStockAsset } from "@/lib/actions/stocks";
import { logActivity } from "@/lib/actions/activity-log";
import { captureAction } from "@/lib/actions/with-sentry";
import {
  validateUUID,
  validateAmount,
  validateDate,
  validateName,
} from "@/lib/validation";
import type {
  StockAssetInput,
  ManualNavInput,
} from "@/lib/types";

/**
 * Create a kind='manual' stock_asset with an optional initial NAV.
 *
 * Workflow:
 *   1. Validate inputs (delegates ticker/name/ISIN to createStockAsset)
 *   2. Call createStockAsset with kind='manual' forced (overrides any caller input.kind)
 *   3. If `opts.initialNav` is provided, insert the first manual_nav_updates row
 *
 * Use cases:
 *   - User adds EQT Nexus ELTIF with the latest published NAV in one step (common)
 *   - User adds the asset and defers the NAV (allowed; asset value = 0 until first NAV)
 */
export async function addManualNavAsset(
  input: StockAssetInput,
  opts?: {
    initialNav?: { nav: number; effectiveDate: string; note?: string | null };
    isAdjustment?: boolean;
    effectiveDate?: string;
  },
): Promise<string> {
  return captureAction("manual-nav.addManualNavAsset", async () => {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    // Force kind='manual' regardless of caller input. yahoo_ticker should be null;
    // the modal in PR 4 won't expose a Yahoo ticker field for the manual flow.
    const assetId = await createStockAsset(
      { ...input, kind: "manual", yahoo_ticker: null },
      { isAdjustment: opts?.isAdjustment, effectiveDate: opts?.effectiveDate },
    );

    if (opts?.initialNav) {
      const { nav, effectiveDate, note } = opts.initialNav;
      validateAmount(nav, "Initial NAV");
      if (nav <= 0) throw new Error("Initial NAV must be positive");
      validateDate(effectiveDate, "Initial NAV effective date");
      if (note) validateName(note, 500, "Note");

      const { error } = await supabase
        .from("manual_nav_updates")
        .insert({
          user_id: user.id,
          asset_id: assetId,
          effective_date: effectiveDate,
          nav,
          note: note?.trim() || null,
        });
      if (error) throw new Error(`Failed to seed initial NAV: ${error.message}`);

      await logActivity({
        action: "created",
        entity_type: "manual_nav_update",
        entity_id: assetId,
        entity_table: "manual_nav_updates",
        entity_name: `${input.ticker} NAV ${effectiveDate}`,
        description: `Initial NAV: ${input.currency ?? "USD"} ${nav.toFixed(2)} as of ${effectiveDate}`,
      });
    }

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/stocks");
    return assetId;
  });
}

/**
 * Upsert a NAV entry by (asset_id, effective_date). Idempotent — re-running with
 * the same date updates the nav/note. New rows trigger an activity-log entry;
 * updates of existing rows also log (so the audit trail captures revisions).
 *
 * Asset ownership is enforced via RLS on stock_assets — the upsert's foreign key
 * + RLS will reject inserts where asset_id belongs to another user.
 */
export async function upsertManualNav(input: ManualNavInput): Promise<void> {
  return captureAction("manual-nav.upsertManualNav", async () => {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    validateUUID(input.asset_id, "Asset ID");
    validateDate(input.effective_date, "Effective date");
    validateAmount(input.nav, "NAV");
    if (input.nav <= 0) throw new Error("NAV must be positive");
    if (input.note) validateName(input.note, 500, "Note");

    // Look up the asset for naming the activity-log entry (also serves as an
    // ownership probe — RLS returns no row for foreign-owned asset_id).
    const { data: asset } = await supabase
      .from("stock_assets")
      .select("ticker, currency, kind")
      .eq("id", input.asset_id)
      .is("deleted_at", null)
      .single();
    if (!asset) throw new Error("Asset not found or not yours");
    if (asset.kind !== "manual") throw new Error("Cannot record NAV for a Yahoo-priced asset");

    // Detect whether the row exists (drives action: 'created' vs 'updated')
    const { data: existing } = await supabase
      .from("manual_nav_updates")
      .select("id, nav")
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date)
      .maybeSingle();

    const { error } = await supabase
      .from("manual_nav_updates")
      .upsert(
        {
          user_id: user.id,
          asset_id: input.asset_id,
          effective_date: input.effective_date,
          nav: input.nav,
          note: input.note?.trim() || null,
        },
        { onConflict: "asset_id,effective_date" },
      );
    if (error) throw new Error(`Failed to record NAV: ${error.message}`);

    await logActivity({
      action: existing ? "updated" : "created",
      entity_type: "manual_nav_update",
      entity_id: input.asset_id,
      entity_table: "manual_nav_updates",
      entity_name: `${asset.ticker} NAV ${input.effective_date}`,
      description: existing
        ? `NAV revised: ${asset.currency} ${existing.nav} → ${input.nav.toFixed(2)} (${input.effective_date})`
        : `NAV recorded: ${asset.currency} ${input.nav.toFixed(2)} as of ${input.effective_date}`,
    });

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/stocks");
  });
}

/**
 * Delete a single NAV entry by (asset_id, effective_date). Activity log records
 * the deletion so the audit trail is complete.
 */
export async function deleteManualNav(input: {
  asset_id: string;
  effective_date: string;
}): Promise<void> {
  return captureAction("manual-nav.deleteManualNav", async () => {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not authenticated");

    validateUUID(input.asset_id, "Asset ID");
    validateDate(input.effective_date, "Effective date");

    const { data: row } = await supabase
      .from("manual_nav_updates")
      .select("nav")
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date)
      .maybeSingle();
    if (!row) throw new Error("NAV entry not found");

    const { data: asset } = await supabase
      .from("stock_assets")
      .select("ticker, currency")
      .eq("id", input.asset_id)
      .single();

    const { error } = await supabase
      .from("manual_nav_updates")
      .delete()
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date);
    if (error) throw new Error(`Failed to delete NAV: ${error.message}`);

    await logActivity({
      action: "removed",
      entity_type: "manual_nav_update",
      entity_id: input.asset_id,
      entity_table: "manual_nav_updates",
      entity_name: `${asset?.ticker ?? "?"} NAV ${input.effective_date}`,
      description: `NAV removed: ${asset?.currency ?? ""} ${row.nav} (${input.effective_date})`,
    });

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/stocks");
  });
}
