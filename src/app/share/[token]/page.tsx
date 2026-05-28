import { notFound } from "next/navigation";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { fetchIndexHistory } from "@/lib/prices/yahoo";
import { deriveCashFlows, getHistoricalBenchmarkExtension } from "@/lib/actions/benchmark";
import { assemblePortfolioView } from "@/lib/portfolio/assemble";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { RegisterHoldings } from "@/components/ui/command-palette-provider";
import dynamic from "next/dynamic";

const PortfolioChart = dynamic(
  () => import("@/components/dashboard/portfolio-chart").then((m) => m.PortfolioChart),
  { loading: () => <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" /> }
);

export default async function SharedOverviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getSharedPortfolio(token);
  if (!data) notFound();

  const {
    profile, cryptoAssets, stockAssets, cashAccounts,
    snapshots, snap3d, snap7d, snap30d, snap90d, snap1y, snapAll,
  } = data;
  const primaryCurrency = profile.primary_currency;

  // Resolve benchmark extension first (owner-scoped) to get sp500Days before parallelising
  const benchmarkExtension = await getHistoricalBenchmarkExtension(data.share.owner_id);
  const { sp500Days } = benchmarkExtension;

  // Prices, aggregation, insights + benchmark data (parallelized)
  const [assembled, sp500TRHistory, cashFlowResult] = await Promise.all([
    assemblePortfolioView(
      { cryptoAssets, stockAssets, cashAccounts, primaryCurrency },
      `/share/${token}`,
      { ownerUserId: data.share.owner_id },
    ),
    // Fetch S&P 500 TR with owner-aware history extent
    fetchIndexHistory("^SP500TR", sp500Days),
    deriveCashFlows(data.share.owner_id),
  ]);

  const cashFlows = [...cashFlowResult.events, ...benchmarkExtension.syntheticCashFlows].sort(
    (a, b) => a.date.localeCompare(b.date),
  );

  const { summary, insights, paletteHoldings } = assembled;

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
        <h1 className="text-2xl font-semibold text-zinc-100">Dashboard</h1>
      </div>
      <DashboardGrid
        summary={summary}
        insights={insights}
        pastSnapshots={pastSnapshots}
        cashFlows={cashFlows}
      />
      <div className="mt-6">
        <PortfolioChart
          snapshots={snapshots}
          liveValue={summary.totalValue}
          liveValueUsd={summary.totalValueUsd}
          primaryCurrency={primaryCurrency}
          sp500History={sp500TRHistory}
          cashFlows={cashFlows}
          liveSlicesUsd={{
            crypto: summary.cryptoValueUsd,
            stocks: summary.stocksValueUsd,
            cash: summary.cashValueUsd,
          }}
          defaultReturnMode
        />
      </div>
    </div>
  );
}
