import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public health check — no auth required.
 * Verifies Supabase connectivity and checks latest snapshot age.
 */
export async function GET() {
  const start = Date.now();

  try {
    const supabase = createAdminClient();

    // Check latest snapshot to detect silent cron failures
    const { data, error } = await supabase
      .from("portfolio_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      return NextResponse.json(
        { status: "degraded", error: "db_query_failed", ms: Date.now() - start },
        { status: 503 }
      );
    }

    const lastSnapshot = data?.snapshot_date as string | undefined;
    const ageHours = lastSnapshot
      ? (Date.now() - new Date(lastSnapshot).getTime()) / 3_600_000
      : null;
    const snapshotStale = ageHours != null && ageHours > 26;

    return NextResponse.json({
      status: snapshotStale ? "warning" : "ok",
      snapshotAgeHours: ageHours ? Math.round(ageHours) : null,
      snapshotStale,
      ms: Date.now() - start,
    });
  } catch {
    return NextResponse.json(
      { status: "error", error: "unreachable", ms: Date.now() - start },
      { status: 503 }
    );
  }
}
