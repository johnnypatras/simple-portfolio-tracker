import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import type { DashboardInsights } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSnapshot, CashFlowEvent } from "@/lib/types";
import { COST_COPY } from "@/lib/cost-basis-copy";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/shared-view-context", () => ({
  useSharedView: () => ({ shareToken: null, isReadOnly: false }),
}));

vi.mock("@/lib/hooks/use-tooltip-dismiss", () => ({
  useTooltipDismiss: () => ({
    openTooltip: null,
    tooltipRef: { current: null },
    toggleTooltip: vi.fn(),
  }),
}));

// Import after mocks
const { DashboardGrid } = await import(
  "@/components/dashboard/dashboard-grid"
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePnlTotals(
  eur: { costBasis: number; realized: number; unrealized: number; totalPnL: number },
): NonNullable<PortfolioSummary["costBasisTotals"]> {
  return {
    eur,
    usd: { ...eur }, // usd side not rendered; shape must match
  };
}

/** Minimal PortfolioSummary — only fields DashboardGrid actually destructures. */
function makeSummary(
  overrides: Partial<PortfolioSummary> = {},
): PortfolioSummary {
  return {
    totalValue: 10000,
    cryptoValue: 5000,
    stocksValue: 3000,
    cashValue: 2000,
    stablecoinValue: 0,
    change24hPercent: 1.5,
    fxChange24hPercent: 0.2,
    allocation: { crypto: 50, stocks: 30, cash: 20 },
    primaryCurrency: "EUR",
    totalValueChange24h: 150,
    cryptoValueChange24h: 80,
    stocksValueChange24h: 50,
    stablecoinValueChange24h: 0,
    cashFxValueChange24h: 0,
    fxValueChange24h: 20,
    cryptoFxValueChange24h: 10,
    cryptoFxChange24hPercent: 0.1,
    stocksFxValueChange24h: 10,
    stocksFxChange24hPercent: 0.3,
    cashTotalValueChange24h: 20,
    cashTotalFxValueChange24h: 5,
    cashTotalFxChange24hPercent: 0.2,
    totalValueUsd: 11000,
    totalValueEur: 10000,
    cryptoValueUsd: 5500,
    cryptoValueEur: 5000,
    stocksValueUsd: 3300,
    stocksValueEur: 3000,
    cashValueUsd: 2200,
    cashValueEur: 2000,
    stocksHomeCurrencyEur: 0,
    cashHomeCurrencyEur: 0,
    ...overrides,
  };
}

/** Minimal DashboardInsights with all required fields zeroed / empty. */
const EMPTY_INSIGHTS: DashboardInsights = {
  btcPriceUsd: 0, btcChange24h: 0,
  ethPriceUsd: 0, ethChange24h: 0,
  sp500Price: 0, sp500Change24h: 0,
  goldPriceUsd: 0, goldChange24h: 0,
  nasdaqPrice: 0, nasdaqChange24h: 0,
  dowPrice: 0, dowChange24h: 0,
  solPriceUsd: 0, solChange24h: 0,
  stoxx50Price: 0, stoxx50Change24h: 0,
  silverPriceUsd: 0, silverChange24h: 0,
  oilPriceUsd: 0, oilChange24h: 0,
  treasury10yYield: 0, treasury10yChange24h: 0,
  vixPrice: 0, vixChange24h: 0,
  eurUsdRate: 0, eurUsdChange24h: 0,
  cryptoAssetCount: 0, cryptoPositionCount: 0, cryptoChange24h: 0,
  btcDominancePercent: 0, btcValueInBase: 0,
  minedStakedPercent: 0, minedStakedCount: 0,
  cryptoBreakdown: [],
  stockAssetCount: 0, stockPositionCount: 0, stockChange24h: 0,
  equitiesBreakdown: [], topHolding: null,
  stocksWeightedYield: 0, stocksDividendIncomeYearly: 0,
  cashAccountCount: 0, weightedAvgApy: 0,
  apyIncomeDaily: 0, apyIncomeMonthly: 0, apyIncomeYearly: 0,
  cashCurrencyBreakdown: [],
  currencyExposure: [],
};

const NO_SNAPSHOTS: Record<string, PortfolioSnapshot | null> = {};
const NO_CASHFLOWS: CashFlowEvent[] = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DashboardGrid — Total P&L stat (Task 3.3c)", () => {
  it("renders EUR totalPnL and % when costBasisTotals is present", () => {
    const summary = makeSummary({
      costBasisTotals: makePnlTotals({
        costBasis: 8000,
        realized: 200,
        unrealized: 800,
        totalPnL: 1000,
      }),
    });

    render(
      <DashboardGrid
        summary={summary}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={NO_SNAPSHOTS}
        cashFlows={NO_CASHFLOWS}
      />,
    );

    // Headline value should appear
    expect(screen.getByText(/Total P&L/)).toBeInTheDocument();
    // EUR value formatted (€1,000.00)
    expect(screen.getByText(/€1,000\.00/)).toBeInTheDocument();
    // % = 1000/8000 = 12.5%
    expect(screen.getByText(/12\.5%/)).toBeInTheDocument();
    // Exactly ONE sign on the percent (smoke finding: a manual "+" prefixed
    // onto fmtPct — which already signs — rendered "(++12.5%)").
    expect(screen.getByText(/\(\+12\.5%\)/)).toBeInTheDocument();
    expect(screen.queryByText(/\+\+/)).toBeNull();
    // Unrealized sub-line
    expect(screen.getByText(/Unrealized/)).toBeInTheDocument();
    expect(screen.getByText(/€800\.00/)).toBeInTheDocument();
    // Realized sub-line
    expect(screen.getByText(/Realized/)).toBeInTheDocument();
    expect(screen.getByText(/€200\.00/)).toBeInTheDocument();
  });

  it("applies a red color class for a negative totalPnL", () => {
    const summary = makeSummary({
      costBasisTotals: makePnlTotals({
        costBasis: 8000,
        realized: -100,
        unrealized: -300,
        totalPnL: -400,
      }),
    });

    const { container } = render(
      <DashboardGrid
        summary={summary}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={NO_SNAPSHOTS}
        cashFlows={NO_CASHFLOWS}
      />,
    );

    // The span that holds the headline value should carry a red class
    const headline = container.querySelector("span.text-red-400");
    expect(headline).not.toBeNull();
    expect(headline?.textContent).toContain("€400.00");
  });

  it("renders nothing (no Total P&L row) when costBasisTotals is absent", () => {
    const summary = makeSummary(); // no costBasisTotals

    render(
      <DashboardGrid
        summary={summary}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={NO_SNAPSHOTS}
        cashFlows={NO_CASHFLOWS}
      />,
    );

    expect(screen.queryByText(/Total P&L/)).toBeNull();
    expect(screen.queryByText(/Unrealized/)).toBeNull();
    expect(screen.queryByText(/Realized/)).toBeNull();
  });

  it("applies fxDivergenceTooltip title on the headline span when currency is USD", () => {
    const summary = makeSummary({
      primaryCurrency: "USD",
      costBasisTotals: makePnlTotals({
        costBasis: 5000,
        realized: 100,
        unrealized: 400,
        totalPnL: 500,
      }),
    });

    const { container } = render(
      <DashboardGrid
        summary={summary}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={NO_SNAPSHOTS}
        cashFlows={NO_CASHFLOWS}
      />,
    );

    // Find the colored headline span — it should carry the FX divergence title
    const spanWithTitle = container.querySelector(
      `span[title="${COST_COPY.fxDivergenceTooltip}"]`,
    );
    expect(spanWithTitle).not.toBeNull();
  });
});
