import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for Task 1.4b — cost-override threading.
 *
 * Verifies that:
 *   (a) upsertPosition / upsertStockPosition / createCashAccount, each WITH a
 *       cashflowOverride, persist the override amounts and set cashflow_user_set=true.
 *   (b) Without an override → market-value cashflow, cashflow_user_set=false.
 *   (c) isYield=true → activity_log row has is_yield=true.
 *   (d) Caller supplies a pre-computed { usd, eur } pair; the primitive persists
 *       both currency columns verbatim (no FX derivation at this layer).
 *       Note: the single-currency-input → FX-at-date derivation (the real
 *       "case 16") is the upstream addTransaction action's responsibility and
 *       is tested in Task 2.5.
 *
 * Strategy: mock createServerSupabaseClient + price APIs to avoid real network
 * calls, then call the actual server actions against local Supabase.
 */

// ─── Hoisted mock state ─────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
}));

// ─── Module mocks ────────────────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

// Fixed FX mock: EUR/USD = 1.10 (1 EUR = 1.10 USD), USD/EUR = 0.9091
vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (_base: string, targets: string[]) => {
    const rates: Record<string, number> = {};
    for (const t of targets) {
      if (t === "USD") rates.USD = 1.10;
      else if (t === "EUR") rates.EUR = 0.9091;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.10, EUR: 1 })),
}));

// Fixed historical price mock: BTC at $30,000 at backdated date
// Used by backdateActivityEntry → computeDeltaFromSnapshots for crypto recompute.
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(async (_symbol: string, startDate: string) => [
    { date: startDate, price: 30000 },
  ]),
  fetchFxUsdPivotHistory: vi.fn(async () => []),
}));

// ─── Imports after mocks ─────────────────────────────────────
import { upsertPosition, createCryptoAsset } from "@/lib/actions/crypto";
import { upsertStockPosition, createStockAsset } from "@/lib/actions/stocks";
import { createCashAccount } from "@/lib/actions/cash-accounts";
import { backdateActivityEntry } from "@/lib/actions/splits";

// ─── Test suite ──────────────────────────────────────────────
describe("cost-override threading (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  // IDs for crypto path
  let walletId: string;
  let cryptoAssetId: string;
  const coingeckoId = `bitcoin-override-test-${randomUUID()}`;

  // IDs for stocks path
  let brokerId: string;
  let stockAssetId: string;
  const stockTicker = `OVR${randomUUID().slice(0, 4).toUpperCase()}`;

  // IDs for cash path
  let institutionId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // Create wallet for crypto
    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("Failed to create wallet: " + walletErr.message);
    walletId = wallet!.id;

    // Create broker for stocks
    const { data: broker, error: brokerErr } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Test Broker" })
      .select("id")
      .single();
    if (brokerErr) throw new Error("Failed to create broker: " + brokerErr.message);
    brokerId = broker!.id;

    // Create institution for cash
    const { data: inst, error: instErr } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Test Bank" })
      .select("id")
      .single();
    if (instErr) throw new Error("Failed to create institution: " + instErr.message);
    institutionId = inst!.id;

    // Create crypto asset
    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin Override Test",
      coingecko_id: coingeckoId,
    });

    // Create stock asset
    stockAssetId = await createStockAsset({
      ticker: stockTicker,
      name: "Override Stock Test",
      kind: "yahoo",
      currency: "USD",
    });
  });

  afterAll(() => cleanup());

  // ─── (a) WITH override → override amounts persisted, cashflow_user_set=true ──

  it("(a) upsertPosition with cashflowOverride stores override amounts and cashflow_user_set=true", async () => {
    const override = { usd: 5000, eur: 4545 };

    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: 0.1 },
      {
        currentPriceUsd: 60000, // market price — should be IGNORED
        currentPriceEur: 54545,
        cashflowOverride: override,
      },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // Override amounts must be stored (NOT qty × price = 0.1 × 60000 = 6000)
    expect(Number(log!.cashflow_amount_usd)).toBe(5000);
    expect(Number(log!.cashflow_amount_eur)).toBe(4545);
    expect(log!.cashflow_user_set).toBe(true);
    expect(log!.is_yield).toBe(false);
  });

  it("(a) upsertStockPosition with cashflowOverride stores override amounts and cashflow_user_set=true", async () => {
    const override = { usd: 3000, eur: 2727 };

    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: brokerId, quantity: 10 },
      {
        currentPriceNative: 350, // market price — should be IGNORED
        assetCurrency: "USD",
        cashflowOverride: override,
      },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield")
      .eq("entity_type", "stock_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // Override amounts must be stored (NOT qty × price = 10 × 350 = 3500)
    expect(Number(log!.cashflow_amount_usd)).toBe(3000);
    expect(Number(log!.cashflow_amount_eur)).toBe(2727);
    expect(log!.cashflow_user_set).toBe(true);
    expect(log!.is_yield).toBe(false);
  });

  it("(a) createCashAccount with cashflowOverride stores override amounts and cashflow_user_set=true", async () => {
    const override = { usd: 1100, eur: 1000 };

    await createCashAccount(
      { institution_id: institutionId, currency: "EUR", balance: 1000, name: "Override Test Account" },
      { cashflowOverride: override },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield")
      .eq("entity_type", "cash_account")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // Override amounts must be stored (NOT computed from balance via FX)
    expect(Number(log!.cashflow_amount_usd)).toBe(1100);
    expect(Number(log!.cashflow_amount_eur)).toBe(1000);
    expect(log!.cashflow_user_set).toBe(true);
    expect(log!.is_yield).toBe(false);
  });

  // ─── (b) WITHOUT override → market-value cashflow, cashflow_user_set=false ──

  it("(b) upsertPosition without override uses market price and cashflow_user_set=false", async () => {
    // Update existing position to a new quantity — no override
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: 0.2 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // qtyDelta = 0.2 - 0.1 = 0.1; valUsd = 0.1 × 60000 = 6000
    expect(Number(log!.cashflow_amount_usd)).toBeCloseTo(6000, 0);
    expect(Number(log!.cashflow_amount_eur)).toBeCloseTo(5454.5, 0);
    expect(log!.cashflow_user_set).toBe(false);
  });

  it("(b) upsertStockPosition without override uses market price and cashflow_user_set=false", async () => {
    // Update existing position — no override
    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: brokerId, quantity: 20 },
      { currentPriceNative: 350, assetCurrency: "USD" },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "stock_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // qtyDelta = 20 - 10 = 10; deltaNative = 10 × 350 = 3500
    // computeActivityFxWithConversion: toUsdAndEur(3500, "USD") → usd=3500, eur=3500×0.9091≈3181.85
    expect(Number(log!.cashflow_amount_usd)).toBeCloseTo(3500, 0);
    expect(Number(log!.cashflow_amount_eur)).toBeCloseTo(3181.85, 0);
    expect(log!.cashflow_user_set).toBe(false);
  });

  // ─── (c) isYield=true → activity_log row has is_yield=true ──────────────────

  it("(c) upsertPosition with isYield=true stores is_yield=true", async () => {
    // Create a second wallet to get a fresh "created" log entry
    const { data: wallet2, error: w2Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Yield Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w2Err) throw new Error("Failed to create yield wallet: " + w2Err.message);

    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: wallet2!.id, quantity: 0.05 },
      { currentPriceUsd: 60000, currentPriceEur: 54545, isYield: true },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("is_yield, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    expect(log!.is_yield).toBe(true);
    expect(log!.cashflow_user_set).toBe(false); // no override was passed
  });

  it("(c) upsertStockPosition with isYield=true stores is_yield=true", async () => {
    // Create a second broker to get a fresh "created" log entry
    const { data: broker2, error: b2Err } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Yield Broker" })
      .select("id")
      .single();
    if (b2Err) throw new Error("Failed to create yield broker: " + b2Err.message);

    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: broker2!.id, quantity: 5 },
      { currentPriceNative: 350, assetCurrency: "USD", isYield: true },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("is_yield, cashflow_user_set")
      .eq("entity_type", "stock_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    expect(log!.is_yield).toBe(true);
    expect(log!.cashflow_user_set).toBe(false);
  });

  it("(c) createCashAccount with isYield=true stores is_yield=true", async () => {
    // Create a second institution to get a fresh "created" log entry
    const { data: inst2, error: i2Err } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Yield Bank" })
      .select("id")
      .single();
    if (i2Err) throw new Error("Failed to create yield institution: " + i2Err.message);

    await createCashAccount(
      { institution_id: inst2!.id, currency: "EUR", balance: 500, name: "Yield Savings" },
      { isYield: true },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("is_yield, cashflow_user_set")
      .eq("entity_type", "cash_account")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    expect(log!.is_yield).toBe(true);
    expect(log!.cashflow_user_set).toBe(false); // no override was passed
  });

  // ─── (d) Pre-computed { usd, eur } pair → both columns persisted verbatim ─────
  //
  // The primitive layer accepts a fully-populated UsdEurAmount override and
  // stores both currency columns as-is. The caller is responsible for
  // deriving the second currency before calling the action (e.g. via
  // toUsdAndEur). This test verifies the pass-through: the test body
  // pre-computes both values and asserts they land in the DB unchanged.

  it("(d) upsertPosition with pre-computed { usd, eur } override persists both columns verbatim", async () => {
    // Create a third wallet for a clean entry
    const { data: wallet3, error: w3Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "FX Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w3Err) throw new Error("Failed to create FX wallet: " + w3Err.message);

    // Both amounts are pre-computed by the caller (usd = eur × 1.10 in this example)
    const override = { usd: 1000 * 1.10, eur: 1000 }; // caller pre-computes both

    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: wallet3!.id, quantity: 0.02 },
      { cashflowOverride: override },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    expect(Number(log!.cashflow_amount_eur)).toBe(1000);
    expect(Number(log!.cashflow_amount_usd)).toBeCloseTo(1100, 1);
    expect(log!.cashflow_user_set).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 1.5 — backdate-recompute fix
// ─────────────────────────────────────────────────────────────────────────────

describe("backdateActivityEntry — cashflow recompute on backdate (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let walletId: string;
  let cryptoAssetId: string;
  const coingeckoId = `bitcoin-backdate-test-${randomUUID()}`;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // Create wallet
    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Backdate Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("Failed to create wallet: " + walletErr.message);
    walletId = wallet!.id;

    // Create crypto asset
    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin Backdate Test",
      coingecko_id: coingeckoId,
    });
  });

  afterAll(() => cleanup());

  it("auto-priced entry (cashflow_user_set=false): backdating recomputes cashflow_amount_* to historical price", async () => {
    // Create a position with market price at write time: qty=0.1 @ $60,000 = $6,000
    // cashflow_user_set defaults to false → no override
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: 0.1 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );

    const { data: logBefore } = await client
      .from("activity_log")
      .select("id, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(logBefore).not.toBeNull();
    // Before backdate: market price at upsert time
    expect(Number(logBefore!.cashflow_amount_usd)).toBeCloseTo(6000, 0);
    expect(logBefore!.cashflow_user_set).toBe(false);

    const entryId = logBefore!.id;
    const newDate = "2023-01-15";

    // Backdate to 2023-01-15 — historical mock returns $30,000 at that date
    // Expected recompute: qtyDelta=0.1, price=$30,000 → usd=3000
    // EUR: 3000 × 0.9091 = 2727.27
    const result = await backdateActivityEntry(entryId, newDate);
    expect(result.success).toBe(true);

    const { data: logAfter } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, effective_date, cashflow_user_set")
      .eq("id", entryId)
      .single();

    expect(logAfter).not.toBeNull();
    expect(logAfter!.effective_date).toBe(newDate);
    // Recomputed: 0.1 × $30,000 = $3,000
    expect(Number(logAfter!.cashflow_amount_usd)).toBeCloseTo(3000, 0);
    // EUR: $3,000 × 0.9091 ≈ $2,727
    expect(Number(logAfter!.cashflow_amount_eur)).toBeCloseTo(2727, 0);
    // cashflow_user_set must remain false — we didn't flip provenance
    expect(logAfter!.cashflow_user_set).toBe(false);
  });

  it("user-set entry (cashflow_user_set=true): backdating preserves cashflow_amount_* unchanged", async () => {
    // Create a second wallet for a clean, isolated entry
    const { data: wallet2, error: w2Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Override Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w2Err) throw new Error("Failed to create wallet2: " + w2Err.message);

    const override = { usd: 9999, eur: 8888 };

    // Create with explicit override → cashflow_user_set=true
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: wallet2!.id, quantity: 0.5 },
      { currentPriceUsd: 60000, currentPriceEur: 54545, cashflowOverride: override },
    );

    const { data: logBefore } = await client
      .from("activity_log")
      .select("id, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(logBefore).not.toBeNull();
    expect(Number(logBefore!.cashflow_amount_usd)).toBe(9999);
    expect(Number(logBefore!.cashflow_amount_eur)).toBe(8888);
    expect(logBefore!.cashflow_user_set).toBe(true);

    const entryId = logBefore!.id;

    // Backdate — cashflow_user_set=true → amounts must NOT change
    const result = await backdateActivityEntry(entryId, "2023-06-01");
    expect(result.success).toBe(true);

    const { data: logAfter } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("id", entryId)
      .single();

    expect(logAfter).not.toBeNull();
    // Must be unchanged — user's intentional cost basis preserved
    expect(Number(logAfter!.cashflow_amount_usd)).toBe(9999);
    expect(Number(logAfter!.cashflow_amount_eur)).toBe(8888);
    expect(logAfter!.cashflow_user_set).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 1.6 — addTransaction / editTransaction skeleton
// ─────────────────────────────────────────────────────────────────────────────

// Import after mocks (mocks are already declared at the top of this file)
import { addTransaction, editTransaction } from "@/lib/actions/transactions";

describe("addTransaction — cost capture (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let walletId: string;
  let cryptoAssetId: string;
  const coingeckoId = `bitcoin-add-txn-test-${randomUUID()}`;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "AddTxn Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("Failed to create wallet: " + walletErr.message);
    walletId = wallet!.id;

    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin AddTxn Test",
      coingecko_id: coingeckoId,
    });
  });

  afterAll(() => cleanup());

  // (a) Buy WITH a user cost amount → stores override amounts, cashflow_user_set=true
  it("(a) addTransaction Buy with costAmount stores override amounts and cashflow_user_set=true", async () => {
    const cost = { usd: 7500, eur: 6818 };

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        action: "buy",
        quantity: 0.15,
        currentPriceUsd: 60000, // market price — should be IGNORED
        currentPriceEur: 54545,
        costAmount: cost,
        walletId,
      },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // Must store the caller-supplied cost, NOT qty × price = 0.15 × 60000 = 9000
    expect(Number(log!.cashflow_amount_usd)).toBe(7500);
    expect(Number(log!.cashflow_amount_eur)).toBe(6818);
    expect(log!.cashflow_user_set).toBe(true);
  });

  // (b) Buy with BLANK/absent costAmount → market fallback, cashflow_user_set=false
  it("(b) addTransaction Buy without costAmount uses market price and cashflow_user_set=false", async () => {
    // Create a second wallet for a clean, isolated entry
    const { data: wallet2, error: w2Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "NoOverride Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w2Err) throw new Error("Failed to create wallet2: " + w2Err.message);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        action: "buy",
        quantity: 0.1,
        currentPriceUsd: 50000,
        currentPriceEur: 45454,
        walletId: wallet2!.id,
        // costAmount deliberately absent
      },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(log).not.toBeNull();
    // Market fallback: qty=0.1, price=$50,000 → usd ≈ 5000
    expect(Number(log!.cashflow_amount_usd)).toBeCloseTo(5000, 0);
    expect(log!.cashflow_user_set).toBe(false);
  });

  // (e) Missing walletId → throws before any DB write
  it("(e) addTransaction with class=crypto and no walletId rejects with walletId error", async () => {
    await expect(
      addTransaction(
        { class: "crypto", assetId: cryptoAssetId },
        {
          action: "buy",
          quantity: 0.05,
          currentPriceUsd: 60000,
          // walletId deliberately absent
        },
      ),
    ).rejects.toThrow(/walletId/i);
  });
});

describe("editTransaction — cross-user ownership (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userAEntryId: string;
  let userAOriginalDate: string | null;

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();

    // Set testClient to userA so createCryptoAsset / upsertPosition run as userA
    hoisted.testClient = userA.client;

    const walletARes = await userA.client
      .from("wallets")
      .insert({ user_id: userA.userId, name: "OwnershipTest Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletARes.error) throw new Error("wallet: " + walletARes.error.message);
    const walletAId = walletARes.data!.id;

    const coinId = `bitcoin-ownership-${randomUUID()}`;
    const assetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin Ownership Test",
      coingecko_id: coinId,
    });

    await upsertPosition(
      { crypto_asset_id: assetId, wallet_id: walletAId, quantity: 1.0 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );

    // Fetch the activity_log entry created for userA's position
    const { data: entry } = await userA.client
      .from("activity_log")
      .select("id, effective_date")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userA.userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!entry) throw new Error("Failed to find userA activity_log entry");
    userAEntryId = entry.id;
    userAOriginalDate = entry.effective_date;
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("(c) editTransaction as userB on userA's entry returns not-found and does NOT mutate the row", async () => {
    // Switch mock client to userB so editTransaction runs as userB
    hoisted.testClient = userB.client;

    const result = await editTransaction(userAEntryId, { effectiveDate: "2024-01-01" });

    // Must return a not-found result — no cross-user write
    expect(result.success).toBe(false);
    expect(result.notFound).toBe(true);

    // Verify userA's row is unchanged
    const { data: row } = await userA.client
      .from("activity_log")
      .select("effective_date")
      .eq("id", userAEntryId)
      .single();

    expect(row).not.toBeNull();
    expect(row!.effective_date).toBe(userAOriginalDate);
  });
});
