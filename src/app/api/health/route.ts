import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public health check — no auth required.
 *
 * Probes (parallelized via Promise.allSettled so one slow/degraded path
 * doesn't mask the others):
 *   1. portfolio_snapshots latest age — detects silent cron failures
 *   2. manual_nav_updates table reachability — detects RLS/grants regression
 *      on the kind='manual' pipeline (PR #75 added composite-FK RLS here)
 *   3. get_latest_manual_navs_at RPC callability — detects function-drop or
 *      argument-signature regression on the hot-path read used by assemble.ts,
 *      comparison.ts, and shared-portfolio.ts
 *
 * Returns 503 only when the primary snapshot probe fails (whole-DB outage).
 * NAV pipeline issues surface as `status: "warning"` + `navPipeline: "degraded"`
 * so they're visible without paging on every transient hiccup.
 */
const HEALTH_DB_TIMEOUT_MS = 3_000;

// Returns zero rows but proves the RPC exists and accepts the right param
// shape. Using the all-zeros UUID instead of a random one keeps the response
// deterministic across calls (helpful for cached health-check responses).
const HEALTH_PROBE_USER_ID = "00000000-0000-0000-0000-000000000000";

export async function GET() {
  const start = Date.now();
  const supabase = createAdminClient();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_DB_TIMEOUT_MS);

  try {
    const today = new Date().toISOString().split("T")[0];

    const [snapshotRes, navTableRes, navRpcRes] = await Promise.allSettled([
      // `created_at` (TIMESTAMPTZ written by the cron at run time) is the
      // correct freshness signal — `snapshot_date` is a DATE column resolving
      // to midnight UTC of the covered day, which can read ~24h older than
      // the actual write for a cron that fires at 23:59 UTC. Ordering by
      // `created_at` DESC also guards against a regression where the cron
      // gets stuck writing yesterday's snapshot_date.
      supabase
        .from("portfolio_snapshots")
        .select("snapshot_date, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .abortSignal(controller.signal)
        .single(),
      supabase
        .from("manual_nav_updates")
        .select("id")
        .limit(1)
        .abortSignal(controller.signal),
      supabase
        .rpc("get_latest_manual_navs_at", {
          p_as_of: today,
          p_user_id: HEALTH_PROBE_USER_ID,
        })
        .abortSignal(controller.signal),
    ]);

    clearTimeout(timeout);
    const abortedByTimeout = controller.signal.aborted;

    // Primary signal: snapshot probe. If this fails the DB is in trouble
    // and the rest of the response is moot.
    const snapshotOk =
      snapshotRes.status === "fulfilled" && !snapshotRes.value.error;
    if (!snapshotOk) {
      return NextResponse.json(
        {
          status: "degraded",
          error: abortedByTimeout ? "db_timeout" : "db_query_failed",
          ms: Date.now() - start,
        },
        { status: 503 }
      );
    }

    const lastSnapshotCreatedAt =
      snapshotRes.status === "fulfilled"
        ? (snapshotRes.value.data?.created_at as string | undefined)
        : undefined;
    const lastSnapshotDate =
      snapshotRes.status === "fulfilled"
        ? (snapshotRes.value.data?.snapshot_date as string | undefined)
        : undefined;
    const ageHours = lastSnapshotCreatedAt
      ? (Date.now() - new Date(lastSnapshotCreatedAt).getTime()) / 3_600_000
      : null;
    const snapshotStale = ageHours != null && ageHours > 26;

    // Secondary signals: manual-NAV pipeline. Both must be healthy.
    // PGRST116 ("no rows returned") is NOT a probe failure — the RPC
    // accepting a zero-UUID and returning no rows is the expected case.
    const navTableOk =
      navTableRes.status === "fulfilled" && !navTableRes.value.error;
    const navRpcOk =
      navRpcRes.status === "fulfilled" && !navRpcRes.value.error;
    const navPipelineOk = navTableOk && navRpcOk;

    const overallStatus = snapshotStale || !navPipelineOk ? "warning" : "ok";

    // Surface NAV pipeline degradation to Sentry so the warning is alertable
    // without depending on someone manually polling /api/health. A 200 with
    // status:"warning" is invisible to external uptime monitors.
    if (!navPipelineOk) {
      Sentry.captureMessage("Health probe: manual-NAV pipeline degraded", {
        level: "warning",
        tags: { route: "/api/health", probe: "nav_pipeline" },
        extra: { navTableOk, navRpcOk },
      });
    }
    // Stale snapshot is also an operational signal — surface it directly
    // instead of waiting for the user to notice the dashboard banner.
    if (snapshotStale) {
      Sentry.captureMessage("Health probe: snapshot stale (>26h)", {
        level: "warning",
        tags: { route: "/api/health", probe: "snapshot_age" },
        extra: { ageHours: ageHours ?? null, snapshotDate: lastSnapshotDate ?? null },
      });
    }

    return NextResponse.json({
      status: overallStatus,
      snapshotAgeHours: ageHours ? Math.round(ageHours) : null,
      snapshotDate: lastSnapshotDate ?? null,
      snapshotStale,
      navPipeline: navPipelineOk ? "ok" : "degraded",
      navTable: navTableOk ? "ok" : "degraded",
      navRpc: navRpcOk ? "ok" : "degraded",
      ms: Date.now() - start,
    });
  } catch (err) {
    clearTimeout(timeout);
    Sentry.captureException(err, {
      tags: { route: "/api/health", probe: "outer_catch" },
    });
    return NextResponse.json(
      { status: "error", error: "unreachable", ms: Date.now() - start },
      { status: 503 }
    );
  }
}
