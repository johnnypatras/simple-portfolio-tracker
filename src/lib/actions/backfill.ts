"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { classifyAssetClass, isStablecoin } from "@/lib/cashflow";
import { cashAmountField, cashDelta, CASH_ENTITY_TYPES } from "@/lib/deltas";
import type { CashEntityType } from "@/lib/deltas";
import type { ActionType, EntityType } from "@/lib/types";
import type { Database } from "@/types/database";
import { toUsdAndEur, computeDeltaFromSnapshots } from "./activity-log";
import { round2 } from "@/lib/format";
import { captureAction } from "@/lib/actions/with-sentry";

const BATCH_SIZE = 10; // Small batch to stay within Vercel 10s timeout
const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours between retries
const MAX_DAYS_BEFORE_EXHAUSTED = 3; // 3 days minimum before escalating to failed


export async function backfillCashflowsAndDeltas(): Promise<{
  processed: number;
  succeeded: number;
  pending: number;
  failed: number;
}> {
  return captureAction("backfill.backfillCashflowsAndDeltas", async () => {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { processed: 0, succeeded: 0, pending: 0, failed: 0 };

  const now = new Date();
  const throttleDate = new Date(now.getTime() - THROTTLE_MS).toISOString();

  // Query rows needing cashflow backfill:
  // 1. Legacy rows: cashflow_status IS NULL + entity produces cashflows + not adjustment + not undone
  // 2. Pending rows: cashflow_status = 'pending' + not recently attempted
  const { data: cashflowRows } = await supabase
    .from("activity_log")
    .select(
      "id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, effective_date, cashflow_attempted_at"
    )
    .eq("user_id", user.id)
    .eq("is_adjustment", false)
    .is("undone_at", null)
    .in("entity_type", [
      "crypto_position",
      "stock_position",
      "exchange_deposit",
      "broker_deposit",
      "bank_account",
      "cash_account",
    ])
    .or(
      `cashflow_status.is.null,and(cashflow_status.eq.pending,or(cashflow_attempted_at.is.null,cashflow_attempted_at.lt.${throttleDate}))`
    )
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  // Query rows needing delta backfill
  const { data: deltaRows } = await supabase
    .from("activity_log")
    .select(
      "id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, effective_date, delta_attempted_at"
    )
    .eq("user_id", user.id)
    .eq("delta_status", "pending")
    .is("undone_at", null)
    .or(`delta_attempted_at.is.null,delta_attempted_at.lt.${throttleDate}`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const seen = new Set<string>();
  const allRows = [...(cashflowRows ?? []), ...(deltaRows ?? [])].filter(r => {
    const id = r.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (allRows.length === 0) {
    return { processed: 0, succeeded: 0, pending: 0, failed: 0 };
  }

  // Pre-fetch subcategories for all crypto rows in one query to avoid N+1
  const cryptoAssetIds = allRows
    .filter((r) => r.entity_type === "crypto_position")
    .map((r) => {
      const snap = (r.after_snapshot ?? r.before_snapshot) as Record<string, unknown> | null;
      return snap?.crypto_asset_id as string | undefined;
    })
    .filter((id): id is string => Boolean(id));

  const cryptoSubcategoryMap = new Map<string, string>();
  if (cryptoAssetIds.length > 0) {
    const { data: cryptoAssets, error: subcatErr } = await supabase
      .from("crypto_assets")
      .select("id, subcategory")
      .in("id", cryptoAssetIds);
    if (subcatErr) console.error("[backfill] Subcategory pre-fetch failed:", subcatErr.message);
    for (const asset of cryptoAssets ?? []) {
      if (asset.subcategory) cryptoSubcategoryMap.set(asset.id, asset.subcategory);
    }
  }

  let succeeded = 0;
  let pending = 0;
  let failed = 0;

  for (const row of allRows) {
    const isCashflow = (cashflowRows ?? []).some((r) => r.id === row.id);
    const isDelta = (deltaRows ?? []).some((r) => r.id === row.id);
    const entityType = row.entity_type as EntityType;
    const isCashEntity = CASH_ENTITY_TYPES.includes(entityType as CashEntityType);

    try {
      let values: { usd: number; eur: number };

      if (isCashEntity) {
        // Cash entities: compute directly from snapshots — no price API needed.
        // Just extract amount delta and convert currency via Frankfurter.
        const field = cashAmountField(entityType as CashEntityType);
        const before = row.before_snapshot as Record<string, unknown> | null;
        const after = row.after_snapshot as Record<string, unknown> | null;
        const beforeAmt = (before?.[field] as number) ?? 0;
        const afterAmt = (after?.[field] as number) ?? 0;
        const currency = (after?.currency as string) ?? (before?.currency as string) ?? "USD";
        const delta = cashDelta(row.action as ActionType, beforeAmt, afterAmt);

        if (delta === 0) {
          values = { usd: 0, eur: 0 };
        } else {
          values = await toUsdAndEur(delta, currency, ((row.effective_date as string) ?? (row.created_at as string)).split("T")[0]);
        }
      } else {
        // Position entities: need historical price lookup via CoinGecko/Yahoo
        values = await computeDeltaFromSnapshots(
          entityType,
          row.action as ActionType,
          (row.effective_date as string) ?? (row.created_at as string),
          row.before_snapshot as Record<string, unknown> | null,
          row.after_snapshot as Record<string, unknown> | null
        );
      }

      if (isCashflow) {
        // Determine asset class (with stablecoin check for crypto)
        let isStable = false;
        if (entityType === "crypto_position") {
          const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
          const assetId = snap?.crypto_asset_id as string | undefined;
          if (assetId) {
            isStable = isStablecoin(cryptoSubcategoryMap.get(assetId));
          }
        }
        const assetClass = classifyAssetClass(entityType, isStable);

        const { error: cfWriteErr } = await supabase
          .from("activity_log")
          .update({
            cashflow_amount_usd: round2(values.usd),
            cashflow_amount_eur: round2(values.eur),
            cashflow_asset_class: assetClass,
            cashflow_status: "complete",
            cashflow_attempted_at: now.toISOString(),
          })
          .eq("id", row.id)
          .eq("user_id", user.id);
        if (cfWriteErr) {
          console.error(`[backfill] Cashflow write failed for row ${row.id as string}:`, cfWriteErr.message);
          pending++;
          continue;
        }
      }
      if (isDelta) {
        const { error: deltaWriteErr } = await supabase
          .from("activity_log")
          .update({
            delta_usd: round2(values.usd),
            delta_eur: round2(values.eur),
            delta_status: "complete",
            delta_attempted_at: now.toISOString(),
          })
          .eq("id", row.id)
          .eq("user_id", user.id);
        if (deltaWriteErr) {
          console.error(`[backfill] Delta write failed for row ${row.id as string}:`, deltaWriteErr.message);
          pending++;
          continue;
        }
      }
      succeeded++;
    } catch (err) {
      console.error(
        `[backfill] Failed row ${row.id as string} (${entityType}):`,
        err instanceof Error ? err.message : err
      );

      // Check if retries exhausted via attempted_at timestamps
      const rowAny = row as Record<string, unknown>;
      const attemptedAt = isCashflow
        ? (rowAny.cashflow_attempted_at as string | null)
        : (rowAny.delta_attempted_at as string | null);
      const daysSinceFirst = attemptedAt
        ? (now.getTime() - new Date(attemptedAt).getTime()) / THROTTLE_MS
        : 0;
      // Off-by-one fix: escalate to the snapshot-estimation fallback once the
      // row has been pending for at least MAX_DAYS_BEFORE_EXHAUSTED days,
      // not one day earlier.
      const isExhausted = daysSinceFirst >= MAX_DAYS_BEFORE_EXHAUSTED;

      if (isExhausted) {
        // Try snapshot estimation fallback before giving up
        let estimateUsd = 0;
        let estimateEur = 0;
        let hasEstimate = false;

        try {
          const eventDate = ((row.effective_date as string) ?? (row.created_at as string)).split("T")[0];
          const { data: snapBefore } = await supabase
            .from("portfolio_snapshots")
            .select(
              "crypto_value_usd, stocks_value_usd, cash_value_usd, crypto_value_eur, stocks_value_eur, cash_value_eur"
            )
            .eq("user_id", user.id)
            .lt("snapshot_date", eventDate)
            .order("snapshot_date", { ascending: false })
            .limit(1)
            .single();
          const { data: snapAfter } = await supabase
            .from("portfolio_snapshots")
            .select(
              "crypto_value_usd, stocks_value_usd, cash_value_usd, crypto_value_eur, stocks_value_eur, cash_value_eur"
            )
            .eq("user_id", user.id)
            .gte("snapshot_date", eventDate)
            .order("snapshot_date", { ascending: true })
            .limit(1)
            .single();

          if (snapBefore && snapAfter) {
            const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
            const assetId = snap?.crypto_asset_id as string | undefined;
            const isStable = entityType === "crypto_position" && assetId
              ? isStablecoin(cryptoSubcategoryMap.get(assetId))
              : false;
            const assetClass = classifyAssetClass(entityType, isStable);
            const classKey =
              assetClass === "crypto"
                ? "crypto"
                : assetClass === "stocks"
                  ? "stocks"
                  : "cash";
            estimateUsd =
              ((snapAfter as Record<string, number>)[`${classKey}_value_usd`] ?? 0) -
              ((snapBefore as Record<string, number>)[`${classKey}_value_usd`] ?? 0);
            estimateEur =
              ((snapAfter as Record<string, number>)[`${classKey}_value_eur`] ?? 0) -
              ((snapBefore as Record<string, number>)[`${classKey}_value_eur`] ?? 0);
            hasEstimate = true;
          }
        } catch (estErr) {
          console.error("[backfill] Snapshot estimation failed for row:", row.id, estErr);
        }

        if (isCashflow) {
          const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
          const assetId = snap?.crypto_asset_id as string | undefined;
          const isStable = entityType === "crypto_position" && assetId
            ? isStablecoin(cryptoSubcategoryMap.get(assetId))
            : false;
          const assetClass = classifyAssetClass(entityType, isStable);
          const { error: cfEstErr } = await supabase
            .from("activity_log")
            .update({
              cashflow_amount_usd: round2(estimateUsd),
              cashflow_amount_eur: round2(estimateEur),
              cashflow_asset_class: assetClass,
              cashflow_status: hasEstimate ? "complete" : "failed",
              cashflow_attempted_at: now.toISOString(),
            })
            .eq("id", row.id)
            .eq("user_id", user.id);
          if (cfEstErr) console.error(`[backfill] Cashflow fallback write failed for row ${row.id as string}:`, cfEstErr.message);
        }
        if (isDelta) {
          const { error: deltaEstErr } = await supabase
            .from("activity_log")
            .update({
              delta_usd: round2(estimateUsd),
              delta_eur: round2(estimateEur),
              delta_status: hasEstimate ? "complete" : "failed",
              delta_attempted_at: now.toISOString(),
            })
            .eq("id", row.id)
            .eq("user_id", user.id);
          if (deltaEstErr) console.error(`[backfill] Delta fallback write failed for row ${row.id as string}:`, deltaEstErr.message);
        }
        failed++;
      } else {
        // Update attempted_at, keep pending
        const pendingUpdate: Database["public"]["Tables"]["activity_log"]["Update"] = {};
        if (isCashflow) pendingUpdate["cashflow_attempted_at"] = now.toISOString();
        if (isDelta) pendingUpdate["delta_attempted_at"] = now.toISOString();
        const { error: pendingWriteErr } = await supabase
          .from("activity_log")
          .update(pendingUpdate)
          .eq("id", row.id)
          .eq("user_id", user.id);
        if (pendingWriteErr) console.error(`[backfill] Pending update write failed for row ${row.id as string}:`, pendingWriteErr.message);
        pending++;
      }
    }
  }

  return { processed: allRows.length, succeeded, pending, failed };
  });
}

/**
 * Retry computation for a single activity_log row.
 * Called by the UI retry button — skips throttle/exhaustion gates.
 */
export async function backfillSingleRow(rowId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  return captureAction("backfill.backfillSingleRow", async () => {
  const { validateUUID } = await import("@/lib/validation");
  validateUUID(rowId, "Activity log row ID");

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated" };

  const { data: row, error: fetchErr } = await supabase
    .from("activity_log")
    .select("id, action, entity_type, entity_id, before_snapshot, after_snapshot, created_at, effective_date, is_adjustment, cashflow_status, delta_status")
    .eq("id", rowId)
    .eq("user_id", user.id)
    .single();

  if (fetchErr || !row) return { success: false, error: "Row not found" };

  const entityType = row.entity_type as EntityType;
  const isCashEntity = CASH_ENTITY_TYPES.includes(entityType as CashEntityType);
  const needsCashflow = row.cashflow_status === "pending" || row.cashflow_status === "failed";
  const needsDelta = row.delta_status === "pending" || row.delta_status === "failed";

  if (!needsCashflow && !needsDelta) {
    return { success: true }; // Nothing to retry
  }

  try {
    let values: { usd: number; eur: number };

    if (isCashEntity) {
      const field = cashAmountField(entityType as CashEntityType);
      const before = row.before_snapshot as Record<string, unknown> | null;
      const after = row.after_snapshot as Record<string, unknown> | null;
      const beforeAmt = (before?.[field] as number) ?? 0;
      const afterAmt = (after?.[field] as number) ?? 0;
      const currency = (after?.currency as string) ?? (before?.currency as string) ?? "USD";
      const delta = cashDelta(row.action as ActionType, beforeAmt, afterAmt);

      if (delta === 0) {
        values = { usd: 0, eur: 0 };
      } else {
        values = await toUsdAndEur(delta, currency, ((row.effective_date as string) ?? (row.created_at as string)).split("T")[0]);
      }
    } else {
      values = await computeDeltaFromSnapshots(
        entityType,
        row.action as ActionType,
        (row.effective_date as string) ?? (row.created_at as string),
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );
    }

    const now = new Date().toISOString();

    if (needsCashflow) {
      let isStable = false;
      if (entityType === "crypto_position") {
        const snap = (row.after_snapshot ?? row.before_snapshot) as Record<string, unknown> | null;
        const assetId = snap?.crypto_asset_id as string | undefined;
        if (assetId) {
          const { data: asset } = await supabase
            .from("crypto_assets")
            .select("subcategory")
            .eq("id", assetId)
            .single();
          isStable = isStablecoin(asset?.subcategory);
        }
      }
      const assetClass = classifyAssetClass(entityType, isStable);
      const { error: cfErr } = await supabase.from("activity_log").update({
        cashflow_amount_usd: round2(values.usd),
        cashflow_amount_eur: round2(values.eur),
        cashflow_asset_class: assetClass,
        cashflow_status: "complete",
        cashflow_attempted_at: now,
      }).eq("id", rowId).eq("user_id", user.id);
      if (cfErr) {
        console.error(`[backfill] Single row cashflow write failed for ${rowId}:`, cfErr.message);
        // Propagate — otherwise the UI retry button shows "success" despite
        // the value never being persisted (R2 CRITICAL finding).
        return { success: false, error: `Cashflow write failed: ${cfErr.message}` };
      }
    }

    if (needsDelta) {
      const { error: deltaErr } = await supabase.from("activity_log").update({
        delta_usd: round2(values.usd),
        delta_eur: round2(values.eur),
        delta_status: "complete",
        delta_attempted_at: now,
      }).eq("id", rowId).eq("user_id", user.id);
      if (deltaErr) {
        console.error(`[backfill] Single row delta write failed for ${rowId}:`, deltaErr.message);
        return { success: false, error: `Delta write failed: ${deltaErr.message}` };
      }
    }

    return { success: true };
  } catch (err) {
    console.error(`[backfill] Single row retry failed ${rowId}:`, err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : "Computation failed" };
  }
  });
}
