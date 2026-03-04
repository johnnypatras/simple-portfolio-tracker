import { describe, it, expect, vi } from "vitest";
import { aggregatePortfolio } from "@/lib/portfolio/aggregate";

// Minimal crypto position factory
function cryptoPos(qty: number, assetId: string) {
  return {
    id: "cp-" + Math.random().toString(36).slice(2, 8),
    crypto_asset_id: assetId,
    wallet_id: "w1",
    wallet_name: "TestWallet",
    wallet_type: "custodial" as const,
    quantity: qty,
    acquisition_method: "buy",
    apy: 0,
    last_was_adjustment: false,
    last_was_transfer: false,
    updated_at: "",
    deleted_at: null,
  };
}

// Minimal stock position factory
function stockPos(qty: number, assetId: string) {
  return {
    id: "sp-" + Math.random().toString(36).slice(2, 8),
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
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
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
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
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
      bankAccounts: [{
        id: "ba1", name: "Bank", bank_name: "TestBank", region: "EU",
        balance: 5000, currency: "EUR", apy: 0, institution_id: null,
        user_id: "u1", created_at: "", updated_at: "",
        last_was_adjustment: false, last_was_transfer: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }] as any,
      exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "EUR", fxRates: { EUR: 1, USD: 1.09 },
    });
    const sum = result.cryptoValue + result.stocksValue + result.cashValue;
    expect(Math.abs(result.totalValue - sum)).toBeLessThan(0.01);
  });

  it("handles missing FX rate without silent zero", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = aggregatePortfolio({
      cryptoAssets: [], cryptoPrices: {},
      stockAssets: [{
        id: "sa1", name: "AAPL", ticker: "AAPL", yahoo_ticker: "AAPL",
        currency: "GBP", isin: null, category: "individual_stock" as const,
        subcategory: null, tags: [],
        user_id: "u1", created_at: "",
        positions: [stockPos(10, "sa1")],
      }],
      stockPrices: { AAPL: { price: 200, change24h: 1, currency: "GBP" } },
      bankAccounts: [], exchangeDeposits: [], brokerDeposits: [],
      primaryCurrency: "USD", fxRates: { USD: 1 }, // GBP missing
    });
    expect(result.stocksValue).toBe(2000); // unconverted, not zero
    spy.mockRestore();
  });
});
