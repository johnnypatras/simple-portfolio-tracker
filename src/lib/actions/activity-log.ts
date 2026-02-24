"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ActionType, ActivityLog, EntityType } from "@/lib/types";

// ─── Fire-and-forget activity logger ────────────────────
// Never throws — logging failures must not break mutations.

export async function logActivity(params: {
  action: ActionType;
  entity_type: EntityType;
  entity_name: string;
  description: string;
  details?: Record<string, unknown>;
  entity_id?: string;
  entity_table?: string;
  before_snapshot?: unknown;
  after_snapshot?: unknown;
}): Promise<void> {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return; // silently bail if unauthenticated

    await supabase.from("activity_log").insert({
      user_id: user.id,
      action: params.action,
      entity_type: params.entity_type,
      entity_name: params.entity_name,
      description: params.description,
      details: params.details ?? null,
      entity_id: params.entity_id ?? null,
      entity_table: params.entity_table ?? null,
      before_snapshot: params.before_snapshot ?? null,
      after_snapshot: params.after_snapshot ?? null,
    });
  } catch {
    // Swallow — audit logging is best-effort
  }
}

// ─── Fetch activity logs with optional filters ──────────

export async function getActivityLogs(filters?: {
  entity_type?: EntityType;
  action?: ActionType;
  limit?: number;
  offset?: number;
}): Promise<{ logs: ActivityLog[]; total: number }> {
  const supabase = await createServerSupabaseClient();
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  // Build filtered query
  let query = supabase
    .from("activity_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters?.entity_type) {
    query = query.eq("entity_type", filters.entity_type);
  }
  if (filters?.action) {
    query = query.eq("action", filters.action);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return {
    logs: (data ?? []) as ActivityLog[],
    total: count ?? 0,
  };
}

// ─── CSV export ─────────────────────────────────────────

export async function exportActivityLogsCsv(): Promise<string> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as ActivityLog[];

  // CSV header
  const lines = ["Date,Action,Type,Name,Description"];

  for (const row of rows) {
    const date = new Date(row.created_at).toISOString();
    const escapeCsv = (s: string) =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;

    lines.push(
      [
        date,
        row.action,
        row.entity_type,
        escapeCsv(row.entity_name),
        escapeCsv(row.description),
      ].join(",")
    );
  }

  return lines.join("\n");
}
