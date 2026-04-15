import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public health check — no auth required.
 * Verifies Supabase connectivity and checks latest snapshot age.
 */
/**
 * Timeout for the health-check DB probe. Kept well below the Vercel 10s
 * function limit so a slow/degraded DB surfaces as "db_timeout" rather
 * than a generic 504 from the platform.
 */
const HEALTH_DB_TIMEOUT_MS = 3_000;

export async function GET() {
  const start = Date.now();

  try {
    const supabase = createAdminClient();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_DB_TIMEOUT_MS);

    // Check latest snapshot to detect silent cron failures
    const { data, error } = await supabase
      .from("portfolio_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .abortSignal(controller.signal)
      .single();

    clearTimeout(timeout);

    if (error) {
      const abortedByTimeout = controller.signal.aborted;
      return NextResponse.json(
        {
          status: "degraded",
          error: abortedByTimeout ? "db_timeout" : "db_query_failed",
          ms: Date.now() - start,
        },
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
