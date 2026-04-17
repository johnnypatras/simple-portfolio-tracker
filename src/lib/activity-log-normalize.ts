import type { ActivityLog } from "@/lib/types";
import type { Database } from "@/types/database";

type ActivityLogRow = Database["public"]["Tables"]["activity_log"]["Row"];

/**
 * Narrow the DB-generic `Json` / nullable-text columns on an `activity_log`
 * row to the ActivityLog domain type (Record<string, unknown> snapshots,
 * domain-enum cashflow/delta statuses and asset class).
 *
 * The DB stores JSON columns untyped and enum-like text without a CHECK —
 * the validation lives in application code. This helper re-establishes the
 * domain contract at the query boundary so consumers get a stable shape.
 */
export function normalizeActivityLogRow(row: ActivityLogRow): ActivityLog {
  return {
    ...row,
    details: row.details as Record<string, unknown> | null,
    before_snapshot: row.before_snapshot as Record<string, unknown> | null,
    after_snapshot: row.after_snapshot as Record<string, unknown> | null,
    cashflow_asset_class: row.cashflow_asset_class as ActivityLog["cashflow_asset_class"],
    cashflow_status: row.cashflow_status as ActivityLog["cashflow_status"],
    delta_status: row.delta_status as ActivityLog["delta_status"],
  };
}
