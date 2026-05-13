import { describe, it, expect, vi, afterEach } from "vitest";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";

let idCounter = 0;

// Minimal crypto position factory (deterministic IDs)
function cryptoPos(qty: number, assetId: string) {
  return {
    id: `cp-${++idCounter}`,
    crypto_asset_id: assetId,
    wallet_id: "w1",
    wallet_name: "TestWallet",
    wallet_type: "custodial" as const,
    quantity: qty,
    acquisition_method: "bought" as const,
    apy: 0,
    network: null,
    last_was_adjustment: false,
    last_was_transfer: false,
    updated_at: "",
    deleted_at: null,
  };
}

// Minimal stock position factory (deterministic IDs)
function stockPos(qty: number, assetId: string) {
  return {
    id: `sp-${++idCounter}`,
    stock_asset_id: assetId,
    broker_id: "b1",
    broker_name: "TestBroker",
    quantity: qty,
    last_was_adjustment: false,
    last_was_transfer: false,
    updated_at: "",
    deleted_at: null,
  };
}

describe("aggregatePortfolio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies stablecoin as cash, not crypto", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "USDC", ticker: "USDC", coingecko_id: "usd-coin",
        image_url: null, chain: null, subcategory: "stablecoin",
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1000, "ca1")],
      }],
      cryptoPrices: { "usd-coin": { usd: 1, eur: 0.92, usd_24h_change: 0, eur_24h_change: 0 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
    });
    expect(result.cryptoValue).toBe(0);
    expect(result.stablecoinValue).toBe(1000);
    expect(result.cashValue).toBe(1000);
  });

  it("returns all zeros for empty portfolio without crashing", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1 },
    });
    expect(result.totalValue).toBe(0);
    expect(result.allocation).toEqual({ crypto: 0, stocks: 0, cash: 0 });
  });

  it("component sum matches total", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      cryptoPrices: { bitcoin: { usd: 50000, eur: 46000, usd_24h_change: 2, eur_24h_change: 1.5 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [{
        id: "ba1", user_id: "u1", institution_id: null, name: "Bank",
        currency: "EUR", balance: 5000, apy: 0, region: "EU",
        wallet_id: null, broker_id: null,
        last_was_adjustment: false, last_was_transfer: false,
        created_at: "", updated_at: "", deleted_at: null,
      }],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.09 },
    });
    const sum = result.cryptoValue + result.stocksValue + result.cashValue;
    expect(Math.abs(result.totalValue - sum)).toBeLessThan(0.01);
  });

  it("handles missing FX rate without silent zero", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [{
        id: "sa1", name: "AAPL", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
        currency: "GBP", isin: null, category: "individual_stock" as const,
        subcategory: null, tags: [],
        user_id: "u1", created_at: "",
        positions: [stockPos(10, "sa1")],
      }],
      stockPrices: { AAPL: { price: 200, previousClose: 198, change24h: 1, currency: "GBP", name: "Apple Inc." } },
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 }, // GBP missing
    });
    expect(result.stocksValue).toBe(2000); // unconverted, not zero
  });

  it("converts USD stock to EUR for EUR user", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [{
        id: "sa1", name: "AAPL", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
        currency: "USD", isin: null, category: "individual_stock" as const,
        subcategory: null, tags: [],
        user_id: "u1", created_at: "",
        positions: [stockPos(5, "sa1")],
      }],
      stockPrices: { AAPL: { price: 200, previousClose: 198, change24h: 1, currency: "USD", name: "Apple Inc." } },
      cashAccounts: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.10 },
    });
    // 5 × $200 = $1000 → EUR: $1000 / 1.10 ≈ €909.09
    expect(result.stocksValue).toBeCloseTo(909.09, 0);
  });

  it("computes allocation percentages", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      cryptoPrices: { bitcoin: { usd: 50000, eur: 50000, usd_24h_change: 0, eur_24h_change: 0 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [{
        id: "ba1", user_id: "u1", institution_id: null, name: "Bank",
        currency: "USD", balance: 50000, apy: 0, region: "EU",
        wallet_id: null, broker_id: null,
        last_was_adjustment: false, last_was_transfer: false,
        created_at: "", updated_at: "", deleted_at: null,
      }],
      primaryCurrency: "USD", fxRates: { USD: 1 },
    });
    // 50k crypto + 50k cash = 100k total → 50/50
    expect(result.allocation.crypto).toBeCloseTo(50, 0);
    expect(result.allocation.cash).toBeCloseTo(50, 0);
    expect(result.allocation.stocks).toBe(0);
  });

  it("computes value-weighted 24h change", () => {
    // BTC: 50k value, +2% change → weighted = 50000 × 2 = 100000
    // Cash: 50k value, 0% change → weighted = 0
    // Total weighted = 100000 / 100000 total = 1% overall change
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      cryptoPrices: { bitcoin: { usd: 50000, eur: 50000, usd_24h_change: 2, eur_24h_change: 2 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [{
        id: "ba1", user_id: "u1", institution_id: null, name: "Bank",
        currency: "USD", balance: 50000, apy: 0, region: "EU",
        wallet_id: null, broker_id: null,
        last_was_adjustment: false, last_was_transfer: false,
        created_at: "", updated_at: "", deleted_at: null,
      }],
      primaryCurrency: "USD", fxRates: { USD: 1 },
    });
    expect(result.change24hPercent).toBeCloseTo(1, 1);
    // Absolute change: 50000 × 2 / 100 = 1000
    expect(result.totalValueChange24h).toBeCloseTo(1000, 0);
    expect(result.cryptoValueChange24h).toBeCloseTo(1000, 0);
  });

  it("includes exchange and broker deposits in cash", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [], stockPrices: {},
      cashAccounts: [
        {
          id: "ed1", user_id: "u1", institution_id: null, name: null,
          currency: "EUR", balance: 1000, apy: 0, region: null,
          wallet_id: "w1", broker_id: null,
          last_was_adjustment: false, last_was_transfer: false,
          created_at: "", updated_at: "", deleted_at: null,
        },
        {
          id: "bd1", user_id: "u1", institution_id: null, name: null,
          currency: "EUR", balance: 2000, apy: 0, region: null,
          wallet_id: null, broker_id: "b1",
          last_was_adjustment: false, last_was_transfer: false,
          created_at: "", updated_at: "", deleted_at: null,
        },
      ],
      primaryCurrency: "EUR", fxRates: { EUR: 1 },
    });
    expect(result.cashValue).toBe(3000);
    expect(result.totalValue).toBe(3000);
  });

  it("computes dual-currency snapshot values with fxRatesUsd/fxRatesEur", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      cryptoPrices: { bitcoin: { usd: 60000, eur: 54000, usd_24h_change: 0, eur_24h_change: 0 } },
      stockAssets: [{
        id: "sa1", name: "VWCE", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
        currency: "EUR", isin: null, category: "etf" as const,
        subcategory: null, tags: [],
        user_id: "u1", created_at: "",
        positions: [stockPos(10, "sa1")],
      }],
      stockPrices: { "VWCE.DE": { price: 100, previousClose: 100, change24h: 0, currency: "EUR", name: "Vanguard FTSE All-World ETF" } },
      cashAccounts: [],
      primaryCurrency: "EUR",
      fxRates: { EUR: 1, USD: 1.11 },
      fxRatesUsd: { USD: 1, EUR: 0.90 },
      fxRatesEur: { EUR: 1, USD: 1.11 },
    });
    // Crypto: CoinGecko gives both directly → USD=60000, EUR=54000
    expect(result.cryptoValueUsd).toBe(60000);
    expect(result.cryptoValueEur).toBe(54000);
    // Stocks: 10 × 100 = 1000 EUR → direct conversion
    // USD: 1000 EUR / 0.90 (EUR per USD) = 1111.11
    expect(result.stocksValueUsd).toBeCloseTo(1111.11, 0);
    // EUR: 1000 EUR / 1 = 1000
    expect(result.stocksValueEur).toBe(1000);
  });

  it("tracks home-currency EUR stocks and cash", () => {
    // EUR user with EUR-denominated stocks → stocksHomeCurrencyEur
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", name: "VWCE", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
          currency: "EUR", isin: null, category: "etf" as const,
          subcategory: null, tags: [],
          user_id: "u1", created_at: "",
          positions: [stockPos(10, "sa1")],
        },
        {
          id: "sa2", name: "AAPL", ticker: "AAPL", yahoo_ticker: "AAPL", kind: "yahoo" as const,
          currency: "USD", isin: null, category: "individual_stock" as const,
          subcategory: null, tags: [],
          user_id: "u1", created_at: "",
          positions: [stockPos(5, "sa2")],
        },
      ],
      stockPrices: {
        "VWCE.DE": { price: 100, previousClose: 100, change24h: 0, currency: "EUR", name: "Vanguard FTSE All-World ETF" },
        AAPL: { price: 200, previousClose: 200, change24h: 0, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [{
        id: "ba1", user_id: "u1", institution_id: null, name: "Savings",
        currency: "EUR", balance: 5000, apy: 0, region: "EU",
        wallet_id: null, broker_id: null,
        last_was_adjustment: false, last_was_transfer: false,
        created_at: "", updated_at: "", deleted_at: null,
      }],
      primaryCurrency: "EUR",
      fxRates: { EUR: 1, USD: 1.10 },
      fxRatesUsd: { USD: 1, EUR: 0.91 },
      fxRatesEur: { EUR: 1, USD: 1.10 },
    });
    // Only EUR stocks count as home currency
    // VWCE: 10 × 100 = 1000 EUR → converted to EUR via fxRatesEur = 1000
    expect(result.stocksHomeCurrencyEur).toBeCloseTo(1000, 0);
    // EUR bank account → home currency cash
    expect(result.cashHomeCurrencyEur).toBeCloseTo(5000, 0);
  });

  it("FX change is zero for USD user's USD-denominated assets", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      // usd_24h_change = eur_24h_change → no FX difference
      cryptoPrices: { bitcoin: { usd: 50000, eur: 46000, usd_24h_change: 3, eur_24h_change: 3 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "USD", fxRates: { USD: 1 },
    });
    // No FX impact when USD changes equal EUR changes
    expect(result.fxChange24hPercent).toBe(0);
    expect(result.fxValueChange24h).toBe(0);
  });

  it("FX change is non-zero for EUR user when EUR/USD diverge", () => {
    const result = aggregatePortfolio({
      cryptoAssets: [{
        id: "ca1", name: "BTC", ticker: "BTC", coingecko_id: "bitcoin",
        image_url: null, chain: null, subcategory: null,
        user_id: "u1", created_at: "",
        positions: [cryptoPos(1, "ca1")],
      }],
      // EUR change differs from USD change → FX component exists
      cryptoPrices: { bitcoin: { usd: 50000, eur: 46000, usd_24h_change: 2, eur_24h_change: 1.5 } },
      stockAssets: [], stockPrices: {},
      cashAccounts: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.09 },
    });
    // FX = EUR change - USD change = 1.5 - 2 = -0.5
    // cryptoFxWeightedChange = 46000 × (1.5 - 2) = -23000
    // fxChange24hPercent = -23000 / 46000 = -0.5
    expect(result.cryptoFxChange24hPercent).toBeCloseTo(-0.5, 1);
    expect(result.cryptoFxValueChange24h).toBeCloseTo(-230, 0);
  });
});
