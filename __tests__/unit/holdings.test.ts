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
});
