import { getProfile } from "@/lib/actions/profile";
import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { fetchIndexHistory } from "@/lib/prices/yahoo";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getAdjustmentDeltas } from "@/lib/actions/activity-log";
import { backfillCashflowsAndDeltas } from "@/lib/actions/backfill";
import { assemblePortfolioView } from "@/lib/portfolio/assemble";
import {
  saveSnapshot,
  getSnapshots,
  getSnapshotAt,
} from "@/lib/actions/snapshots";
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
    chartSnapshots, snap7d, snap30d, snap1y,
    sp500TRHistory,
    cashFlowResult,
    adjustmentDeltas,
  ] = await Promise.all([
    getProfile(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getCashAccounts(),
    getSnapshots(365),           // up to 1 year of history for the chart
    getSnapshotAt(7),            // for 7d change
    getSnapshotAt(30),           // for 30d change
    getSnapshotAt(365),          // for 1y change
    fetchIndexHistory("^SP500TR", 365), // S&P 500 Total Return (benchmark line)
    deriveCashFlows(),
    getAdjustmentDeltas(),
  ]);

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
  }).catch((err) => console.error("[snapshots] fire-and-forget save failed:", err));

  // ── Backfill legacy cashflow/delta rows (fire-and-forget) ─
  backfillCashflowsAndDeltas().catch((err) =>
    console.error("[backfill] fire-and-forget failed:", err)
  );

  const pastSnapshots = {
    "24h": null,
    "7d": snap7d,
    "30d": snap30d,
    "1y": snap1y,
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
        <p className="text-sm text-zinc-500 mt-1">
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
