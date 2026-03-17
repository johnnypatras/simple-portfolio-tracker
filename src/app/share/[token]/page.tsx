import { notFound } from "next/navigation";
import { getSharedPortfolio } from "@/lib/actions/shared-portfolio";
import { fetchIndexHistory } from "@/lib/prices/yahoo";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getAdjustmentDeltas } from "@/lib/actions/activity-log";
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
    snapshots, snap7d, snap30d, snap1y,
  } = data;
  const primaryCurrency = profile.primary_currency;

  // Prices, aggregation, insights + benchmark data (parallelized)
  const [assembled, sp500TRHistory, cashFlowResult, adjustmentDeltas] = await Promise.all([
    assemblePortfolioView(
      { cryptoAssets, stockAssets, cashAccounts, primaryCurrency },
      `/share/${token}`,
    ),
    fetchIndexHistory("^SP500TR", 365),
    deriveCashFlows(data.share.owner_id),
    getAdjustmentDeltas(data.share.owner_id),
  ]);

  const cashFlows = cashFlowResult.events;

  const { summary, insights, paletteHoldings } = assembled;

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
          adjustmentDeltas={adjustmentDeltas}
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
