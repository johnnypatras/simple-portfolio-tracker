import { describe, it, expect } from "vitest";
import { buildPaletteHoldings } from "@/lib/portfolio/holdings";
import type {
  CryptoAssetWithPositions,
  CashAccount,
} from "@/lib/types";

describe("buildPaletteHoldings", () => {
  it("maps crypto, stock, and cash holdings correctly", () => {
    const cryptoAssets: CryptoAssetWithPositions[] = [
      {
        id: "ca1",
        name: "Bitcoin",
        coingecko_id: "bitcoin",
        ticker: "btc",
        chain: null,
        image_url: null,
        subcategory: null,
        user_id: "u",
        created_at: "",
        positions: [
          {
            id: "p1",
            quantity: 0.5,
            crypto_asset_id: "ca1",
            wallet_id: "w1",
            acquisition_method: "bought",
            apy: 0,
            wallet_name: "Ledger",
            wallet_type: "non_custodial",
            network: null,
            updated_at: "",
          },
        ],
      },
    ];

    const cashAccounts: CashAccount[] = [
      {
        id: "ba1",
        user_id: "u",
        institution_id: null,
        name: "Alpha Bank",
        currency: "EUR",
        balance: 5000,
        apy: 0,
        region: "GR",
        wallet_id: null,
        broker_id: null,
        last_was_adjustment: false,
        last_was_transfer: false,
        created_at: "",
        updated_at: "",
        deleted_at: null,
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets,
      cryptoPrices: {
        bitcoin: { usd: 60000, eur: 55000, usd_24h_change: 2, eur_24h_change: 1.5 },
      },
      stockAssets: [],
      stockPrices: {},
      cashAccounts,
      fxRates: { USD: 1.09, EUR: 1 },
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(2); // 1 crypto + 1 cash
    expect(result.find((h) => h.ticker === "BTC")?.type).toBe("crypto");
    expect(result.find((h) => h.type === "cash")?.detailPath).toBe(
      "/dashboard/cash"
    );
  });

  it("returns empty array for empty data", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts: [],
      fxRates: {},
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });
    expect(result).toEqual([]);
  });

  it("converts FX correctly using convertToBase (divides, not multiplies)", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts: [
        {
          id: "ba1",
          user_id: "u",
          institution_id: null,
          name: "USD Account",
          currency: "USD",
          balance: 109,
          apy: 0,
          region: "US",
          wallet_id: null,
          broker_id: null,
          last_was_adjustment: false,
          last_was_transfer: false,
          created_at: "",
          updated_at: "",
          deleted_at: null,
        },
      ],
      // 1 EUR = 1.09 USD → $109 = €100
      fxRates: { USD: 1.09, EUR: 1 },
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });
    // $109 / 1.09 = €100 (not $109 * 1.09 = €118.81)
    expect(result[0].value).toBeCloseTo(100, 1);
  });

  it("applies pathPrefix correctly for share pages", () => {
    const cashAccounts: CashAccount[] = [
      {
        id: "ba1",
        user_id: "u",
        institution_id: null,
        name: "T",
        currency: "USD",
        balance: 100,
        apy: 0,
        region: "US",
        wallet_id: null,
        broker_id: null,
        last_was_adjustment: false,
        last_was_transfer: false,
        created_at: "",
        updated_at: "",
        deleted_at: null,
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts,
      fxRates: { USD: 1 },
      primaryCurrency: "USD",
      pathPrefix: "/share/abc123",
    });
    expect(result[0].detailPath).toBe("/share/abc123/cash");
  });

  it("exchange-deposit cash (wallet_id set) produces type 'cash'", () => {
    const cashAccounts: CashAccount[] = [
      {
        id: "ed1",
        user_id: "u",
        institution_id: null,
        name: "Binance EUR",
        currency: "EUR",
        balance: 500,
        apy: 0,
        region: null,
        wallet_id: "w1",
        broker_id: null,
        last_was_adjustment: false,
        last_was_transfer: false,
        created_at: "",
        updated_at: "",
        deleted_at: null,
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts,
      fxRates: { EUR: 1 },
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cash");
    expect(result[0].name).toBe("Binance EUR");
  });

  it("broker-deposit cash (broker_id set) produces type 'cash'", () => {
    const cashAccounts: CashAccount[] = [
      {
        id: "bd1",
        user_id: "u",
        institution_id: null,
        name: "DEGIRO EUR",
        currency: "EUR",
        balance: 1000,
        apy: 0,
        region: null,
        wallet_id: null,
        broker_id: "b1",
        last_was_adjustment: false,
        last_was_transfer: false,
        created_at: "",
        updated_at: "",
        deleted_at: null,
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      cashAccounts,
      fxRates: { EUR: 1 },
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("cash");
    expect(result[0].name).toBe("DEGIRO EUR");
  });

  it("stock with yahoo_ticker uses yahoo_ticker for price lookup", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "VWCE", yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
          name: "Vanguard FTSE", currency: "EUR", category: "etf" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "DEGIRO", quantity: 10, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        // Price is keyed by yahoo_ticker "VWCE.DE", NOT "VWCE"
        "VWCE.DE": { price: 120, previousClose: 118, change24h: 1.5, currency: "EUR", name: "Vanguard FTSE" },
      },
      cashAccounts: [],
      fxRates: { EUR: 1 },
      primaryCurrency: "EUR",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(1);
    const stock = result[0];
    expect(stock.type).toBe("stock");
    expect(stock.ticker).toBe("VWCE"); // display ticker stays as ticker field
    expect(stock.value).toBeCloseTo(1200, 0); // 10 × 120
    expect(stock.pricePerUnit).toBeCloseTo(120, 0);
    expect(stock.change24h).toBe(1.5);
  });

  it("stock with null yahoo_ticker falls back to ticker for price lookup", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "AAPL", yahoo_ticker: null, kind: "yahoo" as const,
          name: "Apple Inc.", currency: "USD", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 5, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {
        // Keyed by plain ticker since yahoo_ticker is null
        AAPL: { price: 200, previousClose: 195, change24h: 2.5, currency: "USD", name: "Apple Inc." },
      },
      cashAccounts: [],
      fxRates: { USD: 1 },
      primaryCurrency: "USD",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(1);
    const stock = result[0];
    expect(stock.ticker).toBe("AAPL");
    expect(stock.value).toBeCloseTo(1000, 0); // 5 × 200
    expect(stock.pricePerUnit).toBeCloseTo(200, 0);
    expect(stock.change24h).toBe(2.5);
  });

  describe("chain disambiguation", () => {
    const baseAsset = (overrides: Partial<CryptoAssetWithPositions>): CryptoAssetWithPositions => ({
      id: "ca1",
      name: "Ethereum",
      coingecko_id: "ethereum",
      ticker: "eth",
      chain: null,
      image_url: null,
      subcategory: null,
      user_id: "u",
      created_at: "",
      positions: [
        {
          id: "p1",
          quantity: 1,
          crypto_asset_id: "ca1",
          wallet_id: "w1",
          acquisition_method: "bought",
          apy: 0,
          wallet_name: "W",
          wallet_type: "non_custodial",
          network: null,
          updated_at: "",
        },
      ],
      ...overrides,
    });

    it("single coingecko_id keeps the original name unchanged", () => {
      const result = buildPaletteHoldings({
        cryptoAssets: [baseAsset({ chain: "Ethereum" })],
        cryptoPrices: { ethereum: { usd: 3000, eur: 2700, usd_24h_change: 0, eur_24h_change: 0 } },
        stockAssets: [],
        stockPrices: {},
        cashAccounts: [],
        fxRates: { USD: 1 },
        primaryCurrency: "USD",
        pathPrefix: "/dashboard",
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Ethereum");
    });

    it("duplicate coingecko_ids with chains get '(Chain)' suffix on each name", () => {
      const result = buildPaletteHoldings({
        cryptoAssets: [
          baseAsset({ id: "ca1", chain: "Ethereum" }),
          baseAsset({ id: "ca2", chain: "Linea" }),
        ],
        cryptoPrices: { ethereum: { usd: 3000, eur: 2700, usd_24h_change: 0, eur_24h_change: 0 } },
        stockAssets: [],
        stockPrices: {},
        cashAccounts: [],
        fxRates: { USD: 1 },
        primaryCurrency: "USD",
        pathPrefix: "/dashboard",
      });
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(["Ethereum (Ethereum)", "Ethereum (Linea)"]);
    });

    it("duplicate coingecko_ids with null chain on one asset leaves that name unchanged", () => {
      const result = buildPaletteHoldings({
        cryptoAssets: [
          baseAsset({ id: "ca1", chain: null }),
          baseAsset({ id: "ca2", chain: "Arbitrum" }),
        ],
        cryptoPrices: { ethereum: { usd: 3000, eur: 2700, usd_24h_change: 0, eur_24h_change: 0 } },
        stockAssets: [],
        stockPrices: {},
        cashAccounts: [],
        fxRates: { USD: 1 },
        primaryCurrency: "USD",
        pathPrefix: "/dashboard",
      });
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(["Ethereum", "Ethereum (Arbitrum)"]);
    });
  });

  it("stock with missing price returns 0 for value and pricePerUnit", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [
        {
          id: "sa1", user_id: "u", ticker: "OBSCURE", yahoo_ticker: "OBSCURE.L", kind: "yahoo" as const,
          name: "Obscure Stock", currency: "GBP", category: "individual_stock" as const,
          isin: null, subcategory: null, tags: [], created_at: "",
          positions: [{ id: "p1", stock_asset_id: "sa1", broker_id: "b1",
            broker_name: "B", quantity: 100, last_was_adjustment: false,
            last_was_transfer: false, updated_at: "", deleted_at: null }],
        },
      ],
      stockPrices: {}, // no price data at all
      cashAccounts: [],
      fxRates: { GBP: 0.79, USD: 1 },
      primaryCurrency: "USD",
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(1);
    const stock = result[0];
    expect(stock.type).toBe("stock");
    expect(stock.ticker).toBe("OBSCURE");
    // price?.price ?? 0 = 0 → value and pricePerUnit should be 0
    expect(stock.value).toBe(0);
    expect(stock.pricePerUnit).toBe(0);
    expect(stock.change24h).toBeUndefined();
  });
});
