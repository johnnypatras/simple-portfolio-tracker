import { describe, it, expect } from "vitest";
import { buildPaletteHoldings } from "@/lib/portfolio/holdings";
import type {
  CryptoAssetWithPositions,
  BankAccount,
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

    const bankAccounts: BankAccount[] = [
      {
        id: "ba1",
        name: "Alpha Bank",
        bank_name: "Alpha Bank",
        region: "GR",
        balance: 5000,
        currency: "EUR",
        apy: 0,
        institution_id: null,
        user_id: "u",
        created_at: "",
        updated_at: "",
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets,
      cryptoPrices: {
        bitcoin: { usd: 60000, eur: 55000, usd_24h_change: 2, eur_24h_change: 1.5 },
      },
      stockAssets: [],
      stockPrices: {},
      bankAccounts,
      exchangeDeposits: [],
      brokerDeposits: [],
      fxRates: { USD: 1.09, EUR: 1 },
      pathPrefix: "/dashboard",
    });

    expect(result).toHaveLength(2); // 1 crypto + 1 bank
    expect(result.find((h) => h.ticker === "BTC")?.type).toBe("crypto");
    expect(result.find((h) => h.type === "bank")?.detailPath).toBe(
      "/dashboard/cash"
    );
  });

  it("returns empty array for empty data", () => {
    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      bankAccounts: [],
      exchangeDeposits: [],
      brokerDeposits: [],
      fxRates: {},
      pathPrefix: "/dashboard",
    });
    expect(result).toEqual([]);
  });

  it("applies pathPrefix correctly for share pages", () => {
    const bankAccounts: BankAccount[] = [
      {
        id: "ba1",
        name: "T",
        bank_name: "Test Bank",
        region: "US",
        balance: 100,
        currency: "USD",
        apy: 0,
        institution_id: null,
        user_id: "u",
        created_at: "",
        updated_at: "",
      },
    ];

    const result = buildPaletteHoldings({
      cryptoAssets: [],
      cryptoPrices: {},
      stockAssets: [],
      stockPrices: {},
      bankAccounts,
      exchangeDeposits: [],
      brokerDeposits: [],
      fxRates: { USD: 1 },
      pathPrefix: "/share/abc123",
    });
    expect(result[0].detailPath).toBe("/share/abc123/cash");
  });
});
