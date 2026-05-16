import * as Sentry from "@sentry/nextjs";
import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { fetchIndexHistory } from "@/lib/prices/yahoo";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getAdjustmentDeltas } from "@/lib/actions/activity-log";
import { backfillCashflowsAndDeltas } from "@/lib/actions/backfill";
import { assemblePortfolioView } from "@/lib/portfolio/assemble";
import { saveSnapshot, getSnapshots } from "@/lib/actions/snapshots";
import { findSnapshotAt } from "@/lib/portfolio/snapshot-utils";
import { ALL_SNAPSHOTS_DAYS } from "@/lib/constants";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { MobileMenuButton } from "@/components/sidebar";
import { RegisterHoldings } from "@/components/ui/command-palette-provider";
import { FxStatusIndicator } from "@/components/ui/fx-status-indicator";
import dynamic from "next/dynamic";

const PortfolioChart = dynamic(
  () => import("@/components/dashboard/portfolio-chart").then((m) => m.PortfolioChart),
  { loading: () => <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" /> }
);

export default async function DashboardPage() {
  // ── Round 1: Portfolio data + independent fetches in parallel ──
  // Snapshots and benchmark history don't depend on asset data,
  // so they run alongside DB queries.
  const [
    profile, cryptoAssets, stockAssets, cashAccounts,
    chartSnapshots,
    sp500TRHistory,
    cashFlowResult,
    adjustmentDeltas,
  ] = await Promise.all([
    getProfile(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getCashAccounts(),
    // All snapshots — chart "All" period and panel all-time change share this
    // data. We derive the 3d/7d/30d/90d/1y panel snapshots via in-memory binary
    // search below; previously this ran 5 additional `getSnapshotAt(N)` calls,
    // each issuing its own `auth.getUser` + snapshot lookup + manual-NAV
    // augmentation (10 redundant DB queries) for data already returned here.
    // The share-page pipeline (shared-portfolio.ts) uses the same pattern.
    getSnapshots(ALL_SNAPSHOTS_DAYS),
    // S&P 500 Total Return — fetch max history so the benchmark line
    // matches the chart's "All" extent (Yahoo maps days > 365 to range="max")
    fetchIndexHistory("^SP500TR", ALL_SNAPSHOTS_DAYS),
    deriveCashFlows(),
    getAdjustmentDeltas(),
  ]);

  // Derive period snapshots in-memory — `chartSnapshots` is already
  // augmented with manual NAV by `getSnapshots`, so `findSnapshotAt` is a
  // direct substitute for `getSnapshotAt`'s server-side lookup.
  const snap3d = findSnapshotAt(chartSnapshots, 3);
  const snap7d = findSnapshotAt(chartSnapshots, 7);
  const snap30d = findSnapshotAt(chartSnapshots, 30);
  const snap90d = findSnapshotAt(chartSnapshots, 90);
  const snap1y = findSnapshotAt(chartSnapshots, 365);

  // Earliest snapshot for all-time change — reuse data already loaded for the chart
  const snapAll = chartSnapshots.length > 0 ? chartSnapshots[0] : null;

  const { events: cashFlows, pendingCount: cfPendingCount, failedCount: cfFailedCount } = cashFlowResult;

  const primaryCurrency = profile.primary_currency;

  // Pass the latest snapshot's created_at timestamp to the chart for staleness detection.
  // Using created_at (not snapshot_date) because snapshot_date is a DATE without time —
  // new Date("2026-03-30") anchors to midnight UTC, making a 23:59 cron snapshot look 24h stale.
  const latestSnapshotDate = chartSnapshots[chartSnapshots.length - 1]?.created_at as string | undefined;

  // ── Round 2: Prices, aggregation, insights ─────────────
  const { summary, insights, paletteHoldings, fxStale, fxUnavailable } =
    await assemblePortfolioView(
      { cryptoAssets, stockAssets, cashAccounts, primaryCurrency },
      "/dashboard",
    );

  // ── Save today's snapshot (fire-and-forget) ───────────
  saveSnapshot({
    totalValueUsd: summary.totalValueUsd,
    totalValueEur: summary.totalValueEur,
    cryptoValueUsd: summary.cryptoValueUsd,
    stocksValueUsd: summary.stocksValueUsd,
    cashValueUsd: summary.cashValueUsd,
    cryptoValueEur: summary.cryptoValueEur,
    stocksValueEur: summary.stocksValueEur,
    cashValueEur: summary.cashValueEur,
    stocksHomeCurrencyEur: summary.stocksHomeCurrencyEur,
    cashHomeCurrencyEur: summary.cashHomeCurrencyEur,
  }).catch((err) => {
    // saveSnapshot is intentionally fire-and-forget (not awaited so it
    // doesn't block render) and intentionally not wrapped in captureAction
    // (uses richer manual captureMessage at its drift/sanity checkpoints).
    // The dashboard-side catch is the only place fire-and-forget rejections
    // surface — without Sentry here, a snapshot-save outage is invisible
    // until /api/health reports `snapshotStale: true` the next day.
    console.error("[snapshots] fire-and-forget save failed:", err);
    Sentry.captureException(err, {
      tags: { action: "snapshots.saveSnapshot", channel: "fire_and_forget" },
    });
  });

  // ── Backfill legacy cashflow/delta rows (fire-and-forget) ─
  backfillCashflowsAndDeltas().catch((err) => {
    console.error("[backfill] fire-and-forget failed:", err);
    Sentry.captureException(err, {
      tags: { action: "backfill.backfillCashflowsAndDeltas", channel: "fire_and_forget" },
    });
  });

  const pastSnapshots = {
    "24h": null,
    "3d": snap3d,
    "7d": snap7d,
    "30d": snap30d,
    "90d": snap90d,
    "1y": snap1y,
    "all": snapAll,
  };

  return (
    <div>
      <RegisterHoldings holdings={paletteHoldings} />
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
          <FxStatusIndicator stale={fxStale} unavailable={fxUnavailable} />
        </div>
        <p className="text-sm text-zinc-400 mt-1">
          Welcome back{profile?.display_name ? `, ${profile.display_name}` : ""}
        </p>
      </div>

      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
        cashFlows={cashFlows}
        adjustmentDeltas={adjustmentDeltas}
      />

      <div className="mt-6">
        <PortfolioChart
          snapshots={chartSnapshots}
          liveValue={summary.totalValue}
          liveValueUsd={summary.totalValueUsd}
          primaryCurrency={primaryCurrency}
          sp500History={sp500TRHistory}
          cashFlows={cashFlows}
          adjustmentDeltas={adjustmentDeltas}
          liveSlicesUsd={{
            crypto: summary.cryptoValueUsd,
            stocks: summary.stocksValueUsd,
            cash: summary.cashValueUsd,
          }}
          pendingCount={cfPendingCount}
          failedCount={cfFailedCount}
          latestSnapshotDate={latestSnapshotDate}
        />
      </div>
    </div>
  );
}
