import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";
import type { DashboardInsights } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSnapshot, CashFlowEvent } from "@/lib/types";

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

/** `YYYY-MM-DD` for `daysAgo` days before now (UTC), matching snapshot_date shape. */
function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * A 30d-ago snapshot with positive past totals. The 30d headline change is
 * `current − past`, so a positive past total makes `getChangeForPeriod("30d")`
 * return `available: true` and the change line (and therefore the note) renders.
 */
function make30dSnapshot(
  overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
  return {
    id: "snap-30d",
    user_id: "user-1",
    snapshot_date: isoDate(30),
    total_value_usd: 8000,
    total_value_eur: 7000,
    crypto_value_usd: 4000,
    crypto_value_eur: 3500,
    stocks_value_usd: 2200,
    stocks_value_eur: 2000,
    cash_value_usd: 1800,
    cash_value_eur: 1500,
    stocks_eur_denominated_value: null,
    cash_eur_denominated_value: null,
    created_at: isoDate(30),
    ...overrides,
  };
}

/** A +€10,000 deposit (Salary) cash flow dated inside the 30d window. */
function makeDepositCashFlow(): CashFlowEvent {
  return {
    date: isoDate(5), // strictly after the 30d-ago snapshot's cutoff
    amount_usd: 11000,
    amount_eur: 10000,
    entity_name: "Salary",
    asset_class: "cash",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DashboardGrid — inline deposit note (Group C #2)", () => {
  it("shows the deposit note on a snapshot period with deposits", () => {
    render(
      <DashboardGrid
        summary={makeSummary()}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={{ "30d": make30dSnapshot() }}
        cashFlows={[makeDepositCashFlow()]}
      />,
    );

    // Default period is 24h — switch to 30d (snapshot period).
    const buttons = screen.getAllByRole("button", { name: "30D" });
    fireEvent.click(buttons[0]);

    expect(screen.getAllByText(/deposited/i).length).toBeGreaterThan(0);
  });

  it("hides the note on 24h even when deposits exist", () => {
    render(
      <DashboardGrid
        summary={makeSummary()}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={{ "30d": make30dSnapshot() }}
        cashFlows={[makeDepositCashFlow()]}
      />,
    );

    // 24h is the default selected period — do NOT switch.
    expect(screen.queryByText(/deposited/i)).toBeNull();
  });

  it("hides the note on a snapshot period with no deposits", () => {
    render(
      <DashboardGrid
        summary={makeSummary()}
        insights={EMPTY_INSIGHTS}
        pastSnapshots={{ "30d": make30dSnapshot() }}
        cashFlows={[]}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: "30D" });
    fireEvent.click(buttons[0]);

    expect(screen.queryByText(/deposited/i)).toBeNull();
  });
});
