"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { classifyAssetClass } from "@/lib/cashflow";
import { computeDeltaFromSnapshots } from "./activity-log";

const BATCH_SIZE = 50;
const THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours between retries
const MAX_DAYS_BEFORE_EXHAUSTED = 3; // 3 days minimum before escalating to failed

export async function backfillCashflowsAndDeltas(): Promise<{
  processed: number;
  succeeded: number;
  pending: number;
  failed: number;
}> {
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
      "id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, cashflow_attempted_at"
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
      "id, action, entity_type, entity_id, entity_table, before_snapshot, after_snapshot, created_at, delta_attempted_at"
    )
    .eq("user_id", user.id)
    .eq("delta_status", "pending")
    .is("undone_at", null)
    .or(`delta_attempted_at.is.null,delta_attempted_at.lt.${throttleDate}`)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  const allRows = [...(cashflowRows ?? []), ...(deltaRows ?? [])];
  if (allRows.length === 0) {
    return { processed: 0, succeeded: 0, pending: 0, failed: 0 };
  }

  let succeeded = 0;
  let pending = 0;
  let failed = 0;

  for (const row of allRows) {
    const isCashflow = (cashflowRows ?? []).some((r) => r.id === row.id);

    try {
      // Use computeDeltaFromSnapshots for both cashflow and delta computation
      const values = await computeDeltaFromSnapshots(
        row.entity_type as string,
        row.action as string,
        row.created_at as string,
        row.before_snapshot as Record<string, unknown> | null,
        row.after_snapshot as Record<string, unknown> | null
      );

      if (isCashflow) {
        // Determine asset class
        let isStablecoin = false;
        if (row.entity_type === "crypto_position") {
          const snap = (row.after_snapshot ?? row.before_snapshot) as Record<
            string,
            unknown
          > | null;
          const assetId = snap?.crypto_asset_id as string | undefined;
          if (assetId) {
            const { data: asset } = await supabase
              .from("crypto_assets")
              .select("subcategory")
              .eq("id", assetId)
              .single();
            isStablecoin = asset?.subcategory?.toLowerCase() === "stablecoin";
          }
        }
        const assetClass = classifyAssetClass(row.entity_type as string, isStablecoin);

        await supabase
          .from("activity_log")
          .update({
            cashflow_amount_usd: Math.round(values.usd * 100) / 100,
            cashflow_amount_eur: Math.round(values.eur * 100) / 100,
            cashflow_asset_class: assetClass,
            cashflow_status: "complete",
            cashflow_attempted_at: now.toISOString(),
          })
          .eq("id", row.id);
      } else {
        await supabase
          .from("activity_log")
          .update({
            delta_usd: Math.round(values.usd * 100) / 100,
            delta_eur: Math.round(values.eur * 100) / 100,
            delta_status: "complete",
            delta_attempted_at: now.toISOString(),
          })
          .eq("id", row.id);
      }
      succeeded++;
    } catch (err) {
      console.error(
        `[backfill] Failed row ${row.id as string}:`,
        err instanceof Error ? err.message : err
      );

      // Check if retries exhausted via attempted_at timestamps
      // Access via index because allRows is a union of two differently-shaped types
      const rowAny = row as Record<string, unknown>;
      const attemptedAt = isCashflow
        ? (rowAny.cashflow_attempted_at as string | null)
        : (rowAny.delta_attempted_at as string | null);
      const daysSinceFirst = attemptedAt
        ? (now.getTime() - new Date(attemptedAt).getTime()) / THROTTLE_MS
        : 0;
      const isExhausted = daysSinceFirst >= MAX_DAYS_BEFORE_EXHAUSTED - 1;

      if (isExhausted) {
        // Try snapshot estimation fallback before giving up
        let estimateUsd = 0;
        let estimateEur = 0;
        let hasEstimate = false;

        try {
          const eventDate = (row.created_at as string).split("T")[0];
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
            const assetClass = classifyAssetClass(row.entity_type as string);
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
        } catch {
          // Snapshot estimation failed — will use $0
        }

        if (isCashflow) {
          const assetClass = classifyAssetClass(row.entity_type as string);
          await supabase
            .from("activity_log")
            .update({
              cashflow_amount_usd: Math.round(estimateUsd * 100) / 100,
              cashflow_amount_eur: Math.round(estimateEur * 100) / 100,
              cashflow_asset_class: assetClass,
              cashflow_status: hasEstimate ? "complete" : "failed",
              cashflow_attempted_at: now.toISOString(),
            })
            .eq("id", row.id);
        } else {
          await supabase
            .from("activity_log")
            .update({
              delta_usd: Math.round(estimateUsd * 100) / 100,
              delta_eur: Math.round(estimateEur * 100) / 100,
              delta_status: hasEstimate ? "complete" : "failed",
              delta_attempted_at: now.toISOString(),
            })
            .eq("id", row.id);
        }
        failed++;
      } else {
        // Update attempted_at, keep pending
        const updateField = isCashflow
          ? "cashflow_attempted_at"
          : "delta_attempted_at";
        await supabase
          .from("activity_log")
          .update({
            [updateField]: now.toISOString(),
          })
          .eq("id", row.id);
        pending++;
      }
    }
  }

  return { processed: allRows.length, succeeded, pending, failed };
}
