import { describe, it, expect } from "vitest";
import { computeDashboardInsights } from "@/lib/portfolio/dashboard-insights";
import type { PortfolioSummary } from "@/lib/portfolio/aggregate";

const emptySummary: PortfolioSummary = {
  totalValue: 0,
  cryptoValue: 0,
  stocksValue: 0,
  cashValue: 0,
  stablecoinValue: 0,
  change24hPercent: 0,
  fxChange24hPercent: 0,
  allocation: { crypto: 0, stocks: 0, cash: 0 },
  primaryCurrency: "USD",
  totalValueChange24h: 0,
  cryptoValueChange24h: 0,
  stocksValueChange24h: 0,
  stablecoinValueChange24h: 0,
  cashFxValueChange24h: 0,
  fxValueChange24h: 0,
  cryptoFxValueChange24h: 0,
  cryptoFxChange24hPercent: 0,
  stocksFxValueChange24h: 0,
  stocksFxChange24hPercent: 0,
  cashTotalValueChange24h: 0,
  cashTotalFxValueChange24h: 0,
  cashTotalFxChange24hPercent: 0,
  totalValueUsd: 0,
  totalValueEur: 0,
  cryptoValueUsd: 0,
  cryptoValueEur: 0,
  stocksValueUsd: 0,
  stocksValueEur: 0,
  cashValueUsd: 0,
  cashValueEur: 0,
};

const mkt = {
  sp500Price: 5000,
  sp500Change24h: 0.5,
  goldPrice: 2000,
  goldChange24h: 0.1,
  nasdaqPrice: 15000,
  nasdaqChange24h: 0.3,
  dowPrice: 38000,
  dowChange24h: 0.2,
  eurUsdChange24h: 0,
  solPriceUsd: 150,
  solChange24h: 1,
  stoxx50Price: 4500,
  stoxx50Change24h: 0.1,
  silverPrice: 25,
  silverChange24h: 0.2,
  oilPrice: 80,
  oilChange24h: -0.5,
  treasury10yPrice: 4.5,
  treasury10yChange24h: 0.01,
  vixPrice: 15,
  vixChange24h: -2,
};

describe("computeDashboardInsights", () => {
  it("handles zero/NaN dividend yield without crash", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      bankAccounts: [],
      exchangeDeposits: [],
      brokerDeposits: [],
      primaryCurrency: "USD",
      fxRates: { USD: 1 },
      summary: emptySummary,
      ...mkt,
    });
    expect(result.stocksWeightedYield).toBe(0);
    expect(Number.isFinite(result.stocksWeightedYield)).toBe(true);
  });

  it("APY income uses APY-bearing balance only", () => {
    // Bank accounts with apy > 0 should contribute to apyIncomeYearly
    // Bank accounts with apy = 0 should NOT
    const result = computeDashboardInsights({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      bankAccounts: [
        {
          id: "1",
          name: "Savings",
          bank_name: "Test Bank",
          region: "US",
          balance: 10000,
          currency: "USD",
          apy: 5,
          institution_id: null,
          user_id: "u",
          created_at: "",
          updated_at: "",
        },
        {
          id: "2",
          name: "Checking",
          bank_name: "Test Bank",
          region: "US",
          balance: 5000,
          currency: "USD",
          apy: 0,
          institution_id: null,
          user_id: "u",
          created_at: "",
          updated_at: "",
        },
      ],
      exchangeDeposits: [],
      brokerDeposits: [],
      primaryCurrency: "USD",
      fxRates: { USD: 1 },
      summary: { ...emptySummary, cashValue: 15000 },
      ...mkt,
    });
    // APY income = apyTotalValue * (weightedAvgApy / 100)
    // Only the savings account (10000 @ 5%) contributes → 10000 * 5/100 = 500
    expect(result.apyIncomeYearly).toBeCloseTo(500, 0);
    // weightedAvgApy = (10000 * 5) / 10000 = 5
    expect(result.weightedAvgApy).toBe(5);
  });
});
