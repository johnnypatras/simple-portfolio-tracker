import { describe, it, expect } from "vitest";
import { buildInstitutionGroups } from "@/lib/portfolio/institution-grouping";
import type { GroupingInput } from "@/lib/portfolio/institution-grouping";
import type {
  InstitutionWithRoles,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  Wallet,
  Broker,
  CashAccount,
  CoinGeckoPriceData,
  YahooStockPriceData,
} from "@/lib/types";
import type { FXRates } from "@/lib/prices/fx";

// ── Factories ───────────────────────────────────────────

function makeInstitution(overrides: Partial<InstitutionWithRoles> = {}): InstitutionWithRoles {
  return {
    id: "inst-1",
    user_id: "u1",
    name: "Binance",
    roles: ["wallet" as const],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeWallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: "w1",
    user_id: "u1",
    name: "Binance Wallet",
    wallet_type: "custodial",
    privacy_label: null,
    chain: null,
    institution_id: "inst-1",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBroker(overrides: Partial<Broker> = {}): Broker {
  return {
    id: "b1",
    user_id: "u1",
    name: "DEGIRO",
    institution_id: "inst-1",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCryptoAsset(overrides: Partial<CryptoAssetWithPositions> = {}): CryptoAssetWithPositions {
  return {
    id: "ca1",
    user_id: "u1",
    ticker: "BTC",
    name: "Bitcoin",
    coingecko_id: "bitcoin",
    chain: null,
    subcategory: null,
    image_url: null,
    created_at: "2026-01-01T00:00:00Z",
    positions: [{
      id: "cp1",
      crypto_asset_id: "ca1",
      wallet_id: "w1",
      wallet_name: "Binance Wallet",
      wallet_type: "custodial" as const,
      quantity: 1,
      apy: 0,
      acquisition_method: "bought",
      network: null,
      last_was_adjustment: false,
      last_was_transfer: false,
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
    }],
    ...overrides,
  };
}

function makeStockAsset(overrides: Partial<StockAssetWithPositions> = {}): StockAssetWithPositions {
  return {
    id: "sa1",
    user_id: "u1",
    ticker: "VWCE",
    yahoo_ticker: "VWCE.DE", kind: "yahoo" as const,
    name: "Vanguard FTSE All-World",
    currency: "EUR",
    category: "etf",
    isin: null,
    subcategory: null,
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    positions: [{
      id: "sp1",
      stock_asset_id: "sa1",
      broker_id: "b1",
      broker_name: "DEGIRO",
      quantity: 10,
      last_was_adjustment: false,
      last_was_transfer: false,
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
    }],
    ...overrides,
  };
}

function makeCashAccount(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: "ca1",
    user_id: "u1",
    institution_id: "inst-1",
    name: "Savings",
    currency: "EUR",
    balance: 5000,
    apy: 1.5,
    region: null,
    wallet_id: null,
    broker_id: null,
    last_was_adjustment: false,
    last_was_transfer: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

const defaultPrices: CoinGeckoPriceData = {
  bitcoin: { usd: 60000, eur: 54000, usd_24h_change: 2, eur_24h_change: 1.8 },
};

const defaultStockPrices: YahooStockPriceData = {
  "VWCE.DE": { price: 120, previousClose: 118, change24h: 1.69, currency: "EUR", name: "Vanguard FTSE All-World ETF" },
};

const defaultFxRates: FXRates = { USD: 1.11, EUR: 1 };

function makeInput(overrides: Partial<GroupingInput> = {}): GroupingInput {
  return {
    institutions: [makeInstitution()],
    cryptoAssets: [],
    stockAssets: [],
    wallets: [makeWallet()],
    brokers: [],
    cashAccounts: [],
    cryptoPrices: defaultPrices,
    stockPrices: defaultStockPrices,
    fxRates: defaultFxRates,
    primaryCurrency: "EUR",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────

describe("buildInstitutionGroups", () => {
  it("groups crypto positions under their institution", () => {
    const result = buildInstitutionGroups(makeInput({
      cryptoAssets: [makeCryptoAsset()],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].institution.name).toBe("Binance");
    expect(result[0].crypto).toHaveLength(1);
    expect(result[0].crypto[0].ticker).toBe("BTC");
    expect(result[0].crypto[0].valueBase).toBe(54000); // 1 BTC × €54,000
    expect(result[0].totalValue).toBe(54000);
  });

  it("groups stock positions under their institution via broker", () => {
    const result = buildInstitutionGroups(makeInput({
      stockAssets: [makeStockAsset()],
      brokers: [makeBroker()],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].stocks).toHaveLength(1);
    expect(result[0].stocks[0].ticker).toBe("VWCE");
    // EUR stock, EUR user → no FX conversion: 10 × 120 = 1200
    expect(result[0].stocks[0].valueBase).toBe(1200);
  });

  it("groups bank accounts under their institution", () => {
    const result = buildInstitutionGroups(makeInput({
      cashAccounts: [makeCashAccount()],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].cash).toHaveLength(1);
    expect(result[0].cash[0].label).toBe("Savings");
    expect(result[0].cash[0].valueBase).toBe(5000); // EUR → EUR, no conversion
  });

  it("assigns type 'bank' for cash with no wallet_id and no broker_id", () => {
    // Bank-origin cash: both wallet_id and broker_id are null
    const result = buildInstitutionGroups(makeInput({
      cashAccounts: [makeCashAccount({
        id: "bank-cash",
        wallet_id: null,
        broker_id: null,
      })],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].cash).toHaveLength(1);
    expect(result[0].cash[0].type).toBe("bank");
  });

  it("groups exchange deposits via wallet→institution", () => {
    const result = buildInstitutionGroups(makeInput({
      cashAccounts: [makeCashAccount({
        id: "ed1", name: null, balance: 500, apy: 0,
        wallet_id: "w1", broker_id: null,
      })],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].cash).toHaveLength(1);
    expect(result[0].cash[0].type).toBe("exchange_deposit");
    expect(result[0].cash[0].valueBase).toBe(500);
  });

  it("groups broker deposits via broker→institution", () => {
    const result = buildInstitutionGroups(makeInput({
      brokers: [makeBroker()],
      cashAccounts: [makeCashAccount({
        id: "bd1", name: null, balance: 1000, apy: 0,
        wallet_id: null, broker_id: "b1",
      })],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].cash).toHaveLength(1);
    expect(result[0].cash[0].type).toBe("broker_deposit");
    expect(result[0].cash[0].valueBase).toBe(1000);
  });

  it("creates virtual groups for standalone wallets", () => {
    const standaloneWallet = makeWallet({
      id: "w-standalone",
      name: "Ledger",
      institution_id: null,
    });
    const asset = makeCryptoAsset({
      positions: [{
        id: "cp2",
        crypto_asset_id: "ca1",
        wallet_id: "w-standalone",
        wallet_name: "Ledger",
        wallet_type: "non_custodial" as const,
        quantity: 0.5,
        apy: 0,
        acquisition_method: "bought",
        network: null,
        last_was_adjustment: false,
        last_was_transfer: false,
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
      }],
    });
    const result = buildInstitutionGroups(makeInput({
      institutions: [],
      wallets: [standaloneWallet],
      cryptoAssets: [asset],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].institution.id).toBe("__wallet__w-standalone");
    expect(result[0].institution.name).toBe("Ledger");
    expect(result[0].crypto).toHaveLength(1);
    expect(result[0].totalValue).toBeCloseTo(27000, 0); // 0.5 × 54000
  });

  it("sorts groups by value descending, then alphabetically", () => {
    const inst1 = makeInstitution({ id: "inst-a", name: "Alpha" });
    const inst2 = makeInstitution({ id: "inst-b", name: "Beta" });
    const walletA = makeWallet({ id: "wa", institution_id: "inst-a" });
    const walletB = makeWallet({ id: "wb", institution_id: "inst-b" });
    // Beta has more value (1 BTC = 54000) vs Alpha (0.1 BTC = 5400)
    const result = buildInstitutionGroups(makeInput({
      institutions: [inst1, inst2],
      wallets: [walletA, walletB],
      cryptoAssets: [
        makeCryptoAsset({
          id: "c1",
          positions: [{ id: "p1", crypto_asset_id: "c1", wallet_id: "wa", wallet_name: "A", wallet_type: "custodial" as const, quantity: 0.1, apy: 0, acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false, updated_at: "2026-01-01T00:00:00Z", deleted_at: null }],
        }),
        makeCryptoAsset({
          id: "c2",
          positions: [{ id: "p2", crypto_asset_id: "c2", wallet_id: "wb", wallet_name: "B", wallet_type: "custodial" as const, quantity: 1, apy: 0, acquisition_method: "bought", network: null, last_was_adjustment: false, last_was_transfer: false, updated_at: "2026-01-01T00:00:00Z", deleted_at: null }],
        }),
      ],
    }));
    expect(result[0].institution.name).toBe("Beta");  // higher value first
    expect(result[1].institution.name).toBe("Alpha");
  });

  it("sorts alphabetically when values are equal", () => {
    const inst1 = makeInstitution({ id: "inst-z", name: "Zeta" });
    const inst2 = makeInstitution({ id: "inst-a", name: "Alpha" });
    // No assets → both have 0 value → alphabetical
    const result = buildInstitutionGroups(makeInput({
      institutions: [inst1, inst2],
      wallets: [],
      cryptoAssets: [],
    }));
    expect(result[0].institution.name).toBe("Alpha");
    expect(result[1].institution.name).toBe("Zeta");
  });

  it("computes 24h change from crypto price change percentage", () => {
    // BTC at €54,000 with 1.8% EUR 24h change
    // Previous value: 54000 / (1 + 1.8/100) = 54000 / 1.018 ≈ 53045
    // Change: 54000 - 53045 ≈ 955
    const result = buildInstitutionGroups(makeInput({
      cryptoAssets: [makeCryptoAsset()],
    }));
    expect(result[0].change24h.valueChange).toBeCloseTo(955, 0);
    expect(result[0].change24h.percentChange).toBeCloseTo(1.8, 1);
  });

  it("computes 24h change from stock previousClose", () => {
    // VWCE: price=120, previousClose=118, qty=10
    // Current: 10 × 120 = 1200, Previous: 10 × 118 = 1180 (EUR→EUR, no FX)
    // Change: 1200 - 1180 = 20
    const result = buildInstitutionGroups(makeInput({
      stockAssets: [makeStockAsset()],
      brokers: [makeBroker()],
    }));
    expect(result[0].change24h.valueChange).toBeCloseTo(20, 0);
  });

  it("treats cash as unchanged for 24h calculation", () => {
    const result = buildInstitutionGroups(makeInput({
      cashAccounts: [makeCashAccount({ balance: 10000 })],
    }));
    // Cash doesn't change in 24h → valueChange should be 0
    expect(result[0].change24h.valueChange).toBe(0);
    expect(result[0].change24h.percentChange).toBe(0);
  });

  it("aggregates crypto + stocks + cash in same group", () => {
    const result = buildInstitutionGroups(makeInput({
      cryptoAssets: [makeCryptoAsset()],
      stockAssets: [makeStockAsset()],
      brokers: [makeBroker()],
      cashAccounts: [
        makeCashAccount(), // bank account: 5000 EUR
        makeCashAccount({
          id: "ed1", name: null, balance: 500, apy: 0,
          wallet_id: "w1", broker_id: null,
        }), // exchange deposit: 500 EUR
      ],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].crypto).toHaveLength(1);
    expect(result[0].stocks).toHaveLength(1);
    expect(result[0].cash).toHaveLength(2); // bank + exchange deposit
    // 54000 (BTC) + 1200 (VWCE) + 5000 (bank) + 500 (exchange) = 60700
    expect(result[0].totalValue).toBeCloseTo(60700, 0);
  });

  it("converts USD stock to EUR for EUR user", () => {
    const usdStock = makeStockAsset({
      ticker: "AAPL",
      yahoo_ticker: "AAPL", kind: "yahoo" as const,
      name: "Apple",
      currency: "USD",
      positions: [{
        id: "sp2",
        stock_asset_id: "sa1",
        broker_id: "b1",
        broker_name: "DEGIRO",
        quantity: 5,
        last_was_adjustment: false,
        last_was_transfer: false,
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
      }],
    });
    const stockPrices: YahooStockPriceData = {
      AAPL: { price: 200, previousClose: 195, change24h: 2.56, currency: "USD", name: "Apple Inc." },
    };
    const result = buildInstitutionGroups(makeInput({
      stockAssets: [usdStock],
      brokers: [makeBroker()],
      stockPrices,
    }));
    // 5 × $200 = $1000 USD → EUR: $1000 / 1.11 ≈ €900.90
    expect(result[0].stocks[0].valueBase).toBeCloseTo(900.90, 0);
  });

  it("skips stock positions when no price data available", () => {
    const result = buildInstitutionGroups(makeInput({
      stockAssets: [makeStockAsset()],
      brokers: [makeBroker()],
      stockPrices: {}, // no price data
    }));
    expect(result[0].stocks).toHaveLength(0);
    expect(result[0].totalValue).toBe(0);
  });

  it("returns empty groups for institutions with no assets", () => {
    const result = buildInstitutionGroups(makeInput({
      institutions: [makeInstitution()],
    }));
    expect(result).toHaveLength(1);
    expect(result[0].crypto).toHaveLength(0);
    expect(result[0].stocks).toHaveLength(0);
    expect(result[0].cash).toHaveLength(0);
    expect(result[0].totalValue).toBe(0);
  });
});
