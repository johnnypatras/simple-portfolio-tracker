import { describe, it, expect, vi } from "vitest";
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
  stocksHomeCurrencyEur: 0,
  cashHomeCurrencyEur: 0,
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
      cashAccounts: [],
      primaryCurrency: "USD",
      fxRates: { USD: 1 },
      summary: emptySummary,
      ...mkt,
    });
    expect(result.stocksWeightedYield).toBe(0);
    expect(Number.isFinite(result.stocksWeightedYield)).toBe(true);
  });

  it("APY income uses APY-bearing balance only", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts: [
        {
          id: "1", user_id: "u", institution_id: null, name: "Savings",
          currency: "USD", balance: 10000, apy: 5, region: "US",
          wallet_id: null, broker_id: null,
          last_was_adjustment: false, last_was_transfer: false,
          created_at: "", updated_at: "", deleted_at: null,
        },
        {
          id: "2", user_id: "u", institution_id: null, name: "Checking",
          currency: "USD", balance: 5000, apy: 0, region: "US",
          wallet_id: null, broker_id: null,
          last_was_adjustment: false, last_was_transfer: false,
          created_at: "", updated_at: "", deleted_at: null,
        },
      ],
      primaryCurrency: "USD",
      fxRates: { USD: 1 },
      summary: { ...emptySummary, cashValue: 15000 },
      ...mkt,
    });
    expect(result.apyIncomeYearly).toBeCloseTo(500, 0);
    expect(result.weightedAvgApy).toBe(5);
  });

  it("computes BTC dominance in crypto portfolio", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [
        {
          id: "ca1", user_id: "u", ticker: "BTC", name: "Bitcoin",
          coingecko_id: "bitcoin", chain: null, subcategory: null, image_url: null, created_at: "",
          positions: [{ id: "p1", crypto_asset_id: "ca1", wallet_id: "w1",
            wallet_name: "W", wallet_type: "custodial" as const, quantity: 1, apy: 0,
            acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false,
            updated_at: "", deleted_at: null }],
        },
        {
          id: "ca2", user_id: "u", ticker: "ETH", name: "Ethereum",
          coingecko_id: "ethereum", chain: null, subcategory: null, image_url: null, created_at: "",
          positions: [{ id: "p2", crypto_asset_id: "ca2", wallet_id: "w1",
            wallet_name: "W", wallet_type: "custodial" as const, quantity: 10, apy: 0,
            acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false,
            updated_at: "", deleted_at: null }],
        },
      ],
      cryptoPrices: {
        bitcoin: { usd: 60000, eur: 60000, usd_24h_change: 0, eur_24h_change: 0 },
        ethereum: { usd: 3000, eur: 3000, usd_24h_change: 0, eur_24h_change: 0 },
      },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 90000, cryptoValue: 90000 },
      ...mkt,
    });
    // BTC: 60000, ETH: 30000, Total: 90000 → BTC dominance = 66.67%
    expect(result.btcDominancePercent).toBeCloseTo(66.67, 0);
    expect(result.btcValueInBase).toBe(60000);
  });

  it("excludes stablecoins from crypto metrics", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [
        {
          id: "ca1", user_id: "u", ticker: "USDC", name: "USD Coin",
          coingecko_id: "usd-coin", chain: null, subcategory: "stablecoin", image_url: null, created_at: "",
          positions: [{ id: "p1", crypto_asset_id: "ca1", wallet_id: "w1",
            wallet_name: "W", wallet_type: "custodial" as const, quantity: 5000, apy: 3,
            acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false,
            updated_at: "", deleted_at: null }],
        },
      ],
      cryptoPrices: {
        "usd-coin": { usd: 1, eur: 0.92, usd_24h_change: 0, eur_24h_change: 0 },
      },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, cashValue: 5000 },
      ...mkt,
    });
    expect(result.cryptoAssetCount).toBe(0);
    expect(result.cryptoPositionCount).toBe(0);
    // Stablecoin counts as cash account
    expect(result.cashAccountCount).toBe(1);
    // APY from stablecoin: 5000 × 3% = 150
    expect(result.apyIncomeYearly).toBeCloseTo(150, 0);
  });

  it("tracks mined/staked positions", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [{
        id: "ca1", user_id: "u", ticker: "ETH", name: "Ethereum",
        coingecko_id: "ethereum", chain: null, subcategory: null, image_url: null, created_at: "",
        positions: [
          { id: "p1", crypto_asset_id: "ca1", wallet_id: "w1", wallet_name: "W",
            wallet_type: "custodial" as const, quantity: 5, apy: 4,
            acquisition_method: "staked", network: null, last_was_adjustment: false, last_was_transfer: false,
            updated_at: "", deleted_at: null },
          { id: "p2", crypto_asset_id: "ca1", wallet_id: "w1", wallet_name: "W",
            wallet_type: "custodial" as const, quantity: 3, apy: 0,
            acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false,
            updated_at: "", deleted_at: null },
        ],
      }],
      cryptoPrices: {
        ethereum: { usd: 3000, eur: 3000, usd_24h_change: 0, eur_24h_change: 0 },
      },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 24000, cryptoValue: 24000 },
      ...mkt,
    });
    // 5 staked + 3 bought = 8 total, staked value = 15000
    expect(result.minedStakedCount).toBe(1);
    expect(result.minedStakedPercent).toBeCloseTo(62.5, 0); // 15000/24000
  });

  it("builds equities breakdown by category", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
          name: "Vanguard", currency: "USD", category: "etf" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 10, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
        {
          id: "sa2", user_id: "u", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
          name: "Apple", currency: "USD", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p2", stock_asset_id: "sa2", broker_id: "b1",
            broker_name: "B", quantity: 5, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        "VWCE.DE": { price: 100, previousClose: 100, change24h: 0, currency: "USD", name: "Vanguard FTSE All-World ETF" },
        AAPL: { price: 200, previousClose: 200, change24h: 0, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 2000, stocksValue: 2000 },
      ...mkt,
    });
    expect(result.equitiesBreakdown).toHaveLength(2);
    // AAPL: 5 × 200 = 1000 (stocks), VWCE: 10 × 100 = 1000 (ETF)
    // Sorted by value descending — both equal, so order by TYPE_META order
    const labels = result.equitiesBreakdown.map((e) => e.label);
    expect(labels).toContain("ETFs");
    expect(labels).toContain("Stocks");
  });

  it("identifies top holding", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
          name: "Vanguard FTSE", currency: "USD", category: "etf" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 20, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
        {
          id: "sa2", user_id: "u", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
          name: "Apple", currency: "USD", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p2", stock_asset_id: "sa2", broker_id: "b1",
            broker_name: "B", quantity: 1, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        "VWCE.DE": { price: 100, previousClose: 100, change24h: 0, currency: "USD", name: "Vanguard FTSE All-World ETF" },
        AAPL: { price: 200, previousClose: 200, change24h: 0, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 2200, stocksValue: 2200 },
      ...mkt,
    });
    // VWCE: 20 × 100 = 2000, AAPL: 1 × 200 = 200
    expect(result.topHolding).not.toBeNull();
    expect(result.topHolding!.ticker).toBe("VWCE");
    expect(result.topHolding!.percent).toBeCloseTo(90.9, 0);
  });

  it("builds cash currency breakdown with fiat and stablecoins", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [{
        id: "ca1", user_id: "u", ticker: "USDC", name: "USD Coin",
        coingecko_id: "usd-coin", chain: null, subcategory: "stablecoin", image_url: null, created_at: "",
        positions: [{ id: "p1", crypto_asset_id: "ca1", wallet_id: "w1",
          wallet_name: "W", wallet_type: "custodial" as const, quantity: 1000, apy: 0,
          acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false,
          updated_at: "", deleted_at: null }],
      }],
      cryptoPrices: {
        "usd-coin": { usd: 1, eur: 1, usd_24h_change: 0, eur_24h_change: 0 },
      },
      stockAssets: [], stockPrices: {},
      cashAccounts: [{
        id: "ba1", user_id: "u", institution_id: null, name: "EUR Savings",
        currency: "EUR", balance: 5000, apy: 0, region: "EU",
        wallet_id: null, broker_id: null,
        last_was_adjustment: false, last_was_transfer: false,
        created_at: "", updated_at: "", deleted_at: null,
      }],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, cashValue: 6000 },
      ...mkt,
    });
    // Two currencies: EUR (fiat bank) and USD (stablecoin USDC)
    expect(result.cashCurrencyBreakdown.length).toBeGreaterThanOrEqual(2);
    const eurEntry = result.cashCurrencyBreakdown.find((e) => e.currency === "EUR");
    const usdEntry = result.cashCurrencyBreakdown.find((e) => e.currency === "USD");
    expect(eurEntry).toBeDefined();
    expect(eurEntry!.fiatValue).toBe(5000);
    expect(usdEntry).toBeDefined();
    expect(usdEntry!.stablecoinValue).toBe(1000);
  });

  it("derives EUR/USD rate from EUR-based FX rates", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.10 },
      summary: emptySummary,
      ...mkt,
    });
    // EUR user: eurUsdRate = fxRates["USD"] = 1.10
    expect(result.eurUsdRate).toBe(1.10);
  });

  it("derives EUR/USD rate from USD-based FX rates", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1, EUR: 0.91 },
      summary: emptySummary,
      ...mkt,
    });
    // USD user: eurUsdRate = 1 / fxRates["EUR"] = 1 / 0.91 ≈ 1.099
    expect(result.eurUsdRate).toBeCloseTo(1.099, 2);
  });

  it("computes value-weighted stock dividend yield", () => {
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
          name: "Vanguard", currency: "USD", category: "etf" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 100, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: { "VWCE.DE": { price: 100, previousClose: 100, change24h: 0, currency: "USD", name: "Vanguard FTSE All-World ETF" } },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 10000, stocksValue: 10000 },
      ...mkt,
      dividends: {
        "VWCE.DE": { trailingYield: 1.5, annualDividend: 1.5, dividendCount: 4, currency: "USD" },
      },
    });
    // 100 × $100 = $10000 value, yield = 1.5%
    expect(result.stocksWeightedYield).toBeCloseTo(1.5, 1);
    // Annual income: 100 shares × $1.50 = $150
    expect(result.stocksDividendIncomeYearly).toBeCloseTo(150, 0);
  });

  it("filters out tag that duplicates type label (case-insensitive)", () => {
    // Stock in "individual_stock" category with tag "Stocks" → type label = "Stocks"
    // The tag should be filtered out since it matches the type label
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
          name: "Apple", currency: "USD", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: ["stocks"], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 10, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        AAPL: { price: 200, previousClose: 200, change24h: 0, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 2000, stocksValue: 2000 },
      ...mkt,
    });
    const stocksEntry = result.equitiesBreakdown.find((e) => e.label === "Stocks");
    expect(stocksEntry).toBeDefined();
    // tagBreakdown should be undefined — "stocks" tag matches "Stocks" label
    expect(stocksEntry!.tagBreakdown).toBeUndefined();
  });

  it("non-matching tag is included in tagBreakdown", () => {
    // Stock with tag "Tech" under "individual_stock" (label "Stocks") → kept
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
          name: "Apple", currency: "USD", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: ["Tech"], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 10, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        AAPL: { price: 200, previousClose: 200, change24h: 0, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
      summary: { ...emptySummary, totalValue: 2000, stocksValue: 2000 },
      ...mkt,
    });
    const stocksEntry = result.equitiesBreakdown.find((e) => e.label === "Stocks");
    expect(stocksEntry).toBeDefined();
    expect(stocksEntry!.tagBreakdown).toBeDefined();
    expect(stocksEntry!.tagBreakdown![0].label).toBe("Tech");
  });

  it("derives EUR/USD rate from third-currency (CHF) FX rates", () => {
    // CHF base: fxRates["USD"] = 1.13 (USD per CHF), fxRates["EUR"] = 1.04 (EUR per CHF)
    // eurUsdRate = usdRate / eurRate = 1.13 / 1.04 ≈ 1.0865
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "CHF" as "USD", // Cast needed — BaseCurrency is EUR|USD but logic handles any
      fxRates: { CHF: 1, USD: 1.13, EUR: 1.04 },
      summary: emptySummary,
      ...mkt,
    });
    expect(result.eurUsdRate).toBeCloseTo(1.0865, 3);
    warnSpy.mockRestore();
  });

  it("EUR/USD rate is 0 when third-currency FX is missing EUR", () => {
    // CHF base but no EUR rate → eurUsdRate = 0
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = computeDashboardInsights({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "CHF" as "USD",
      fxRates: { CHF: 1, USD: 1.13 }, // EUR missing
      summary: emptySummary,
      ...mkt,
    });
    expect(result.eurUsdRate).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Missing USD/EUR rates"),
    );
    warnSpy.mockRestore();
  });
});
