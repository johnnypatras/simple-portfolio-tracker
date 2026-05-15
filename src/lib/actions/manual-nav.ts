"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createStockAsset } from "@/lib/actions/stocks";
import { revalidateDashboard } from "@/lib/actions/revalidate";
import { logActivity } from "@/lib/actions/activity-log";
import { captureAction } from "@/lib/actions/with-sentry";
import { formatCurrency } from "@/lib/format";
import { PGRST_NO_ROWS } from "@/lib/supabase/error-codes";
import { MAX_NAV_NOTE_LENGTH } from "@/lib/constants";
import {
  validateUUID,
  validateAmount,
  validatePastOrTodayDate,
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
    // the manual-NAV modal doesn't expose a Yahoo ticker field for this flow.
    const assetId = await createStockAsset(
      { ...input, kind: "manual", yahoo_ticker: null },
      { isAdjustment: opts?.isAdjustment, effectiveDate: opts?.effectiveDate },
    );

    // Defense-in-depth: createStockAsset may return an EXISTING asset_id on
    // unique-violation reuse. If that existing asset is kind='yahoo' (user
    // previously created the same ticker as a Yahoo asset), inserting a NAV
    // row against it would be silently wrong — the kind='manual' filter
    // downstream wouldn't see it. Verify the returned asset's kind before
    // touching manual_nav_updates.
    if (opts?.initialNav) {
      const { data: assetRow, error: assetErr } = await supabase
        .from("stock_assets")
        .select("kind")
        .eq("id", assetId)
        .single();
      if (assetErr) throw new Error(`Failed to verify asset kind: ${assetErr.message}`);
      if (assetRow.kind !== "manual") {
        throw new Error(
          `Cannot record manual NAV: asset "${input.ticker}" already exists as a Yahoo-priced asset. Delete or rename the existing asset first.`,
        );
      }

      const { nav, effectiveDate, note } = opts.initialNav;
      validateAmount(nav, "Initial NAV");
      if (nav <= 0) throw new Error("Initial NAV must be positive");
      validatePastOrTodayDate(effectiveDate, "Initial NAV effective date");
      if (note) validateName(note, MAX_NAV_NOTE_LENGTH, "Note");

      const { data: inserted, error } = await supabase
        .from("manual_nav_updates")
        .insert({
          user_id: user.id,
          asset_id: assetId,
          effective_date: effectiveDate,
          nav,
          note: note?.trim() || null,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to seed initial NAV: ${error.message}`);

      await logActivity({
        action: "created",
        entity_type: "manual_nav_update",
        // entity_id is the manual_nav_updates row PK so entity_table+entity_id
        // form a real FK to the audit row, matching upsertManualNav's pattern
        // and the documented convention. Was previously the parent asset_id —
        // which broke the convention and made undo/lookup ambiguous.
        entity_id: inserted?.id ?? assetId,
        entity_table: "manual_nav_updates",
        entity_name: `${input.ticker} NAV ${effectiveDate}`,
        description: `Initial NAV: ${formatCurrency(nav, input.currency ?? "USD")} as of ${effectiveDate}`,
        is_adjustment: opts?.isAdjustment,
        effective_date: opts?.effectiveDate,
      });
    }

    revalidateDashboard();
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
    validatePastOrTodayDate(input.effective_date, "Effective date");
    validateAmount(input.nav, "NAV");
    if (input.nav <= 0) throw new Error("NAV must be positive");
    if (input.note) validateName(input.note, MAX_NAV_NOTE_LENGTH, "Note");

    // Look up the asset for naming the activity-log entry (also serves as an
    // ownership probe — RLS returns no row for foreign-owned asset_id).
    // Use .single() and inspect the error code to distinguish "not found /
    // not yours" (PGRST116) from a real DB error — the previous behavior
    // conflated five failure modes into one user message.
    const assetRes = await supabase
      .from("stock_assets")
      .select("ticker, currency, kind")
      .eq("id", input.asset_id)
      .is("deleted_at", null)
      .single();
    if (assetRes.error) {
      if (assetRes.error.code === PGRST_NO_ROWS) {
        // Drop "or not yours" disambiguation — would let an attacker enumerate
        // other users' asset UUIDs by probing for known-vs-unknown error text.
        // Combined with RLS scoping the SELECT to auth.uid(), the user can
        // already only see their own assets — the message just needs to match.
        throw new Error("Asset not found");
      }
      throw new Error(`Failed to load asset: ${assetRes.error.message}`);
    }
    const asset = assetRes.data;
    if (asset.kind !== "manual") throw new Error("Cannot record NAV for a Yahoo-priced asset");

    // Detect whether the row exists (drives action: 'created' vs 'updated')
    const existingRes = await supabase
      .from("manual_nav_updates")
      .select("id, nav")
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date)
      .maybeSingle();
    if (existingRes.error) throw new Error(`Failed to check existing NAV: ${existingRes.error.message}`);
    const existing = existingRes.data;

    const { data: upserted, error } = await supabase
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
      )
      .select("id")
      .single();
    if (error) throw new Error(`Failed to record NAV: ${error.message}`);

    await logActivity({
      action: existing ? "updated" : "created",
      entity_type: "manual_nav_update",
      // entity_id now references the NAV row PK (manual_nav_updates.id) so
      // entity_table + entity_id form a real FK to the audit row, matching
      // the project's general convention (e.g. stocks.ts: entity_id = data.id
      // for entity_table 'stock_assets').
      entity_id: upserted?.id ?? input.asset_id,
      entity_table: "manual_nav_updates",
      entity_name: `${asset.ticker} NAV ${input.effective_date}`,
      description: existing
        ? `NAV revised: ${formatCurrency(Number(existing.nav), asset.currency)} → ${formatCurrency(input.nav, asset.currency)} (${input.effective_date})`
        : `NAV recorded: ${formatCurrency(input.nav, asset.currency)} as of ${input.effective_date}`,
      before_snapshot: existing ?? undefined,
      after_snapshot: {
        id: upserted?.id,
        asset_id: input.asset_id,
        effective_date: input.effective_date,
        nav: input.nav,
        note: input.note?.trim() || null,
      },
    });

    revalidateDashboard();
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
    validatePastOrTodayDate(input.effective_date, "Effective date");

    // Probe for the row to delete. Disambiguate not-found (PGRST116) from
    // real DB error so the user sees a clear message instead of "NAV entry
    // not found" on a connection failure.
    const rowRes = await supabase
      .from("manual_nav_updates")
      .select("id, nav, note")
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date)
      .maybeSingle();
    if (rowRes.error) throw new Error(`Failed to load NAV entry: ${rowRes.error.message}`);
    const row = rowRes.data;
    if (!row) throw new Error("NAV entry not found");

    const assetRes = await supabase
      .from("stock_assets")
      .select("ticker, currency")
      .eq("id", input.asset_id)
      .maybeSingle();
    if (assetRes.error) throw new Error(`Failed to load asset: ${assetRes.error.message}`);
    const asset = assetRes.data;

    const { error } = await supabase
      .from("manual_nav_updates")
      .delete()
      .eq("asset_id", input.asset_id)
      .eq("effective_date", input.effective_date)
      .eq("user_id", user.id); // Defense-in-depth: explicit user_id filter on top of RLS
    if (error) throw new Error(`Failed to delete NAV: ${error.message}`);

    await logActivity({
      action: "removed",
      entity_type: "manual_nav_update",
      entity_id: row.id,
      entity_table: "manual_nav_updates",
      entity_name: `${asset?.ticker ?? "?"} NAV ${input.effective_date}`,
      description: `NAV removed: ${asset?.currency ?? ""} ${formatCurrency(Number(row.nav), asset?.currency ?? "USD")} (${input.effective_date})`,
      before_snapshot: row,
    });

    revalidateDashboard();
  });
}
