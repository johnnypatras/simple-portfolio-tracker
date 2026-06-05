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
import { loadLastChangeDate } from "@/lib/actions/transactions";

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

  // ─── Task 3.3b — single-currency `cost` opt → FX-derived dual override ────────
  //
  // upsertStockPosition's new `cost` opt mirrors addTransaction: a single-currency
  // amount is converted to a dual { usd, eur } pair via toUsdAndEur (FX-at-date),
  // the typed currency stored verbatim, the derived leg round2'd, and
  // cashflow_user_set flipped true. This is the manual-NAV/position cost spine.
  it("(a2) upsertStockPosition with single-currency cost {1000, EUR} derives the USD leg and sets cashflow_user_set=true", async () => {
    // Fresh broker so the "most recent" log row is unambiguously this write.
    const { data: costBroker, error: cbErr } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Cost Spine Broker" })
      .select("id")
      .single();
    if (cbErr) throw new Error("Failed to create broker: " + cbErr.message);

    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: costBroker!.id, quantity: 10 },
      {
        // No cashflowOverride — the single-currency cost drives the derivation.
        cost: { amount: 1000, currency: "EUR" },
        currentPriceNative: 350, // market price — IGNORED once a cost is present
        assetCurrency: "USD",
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
    // EUR is the input currency → stored verbatim.
    expect(Number(log!.cashflow_amount_eur)).toBe(1000);
    // USD is FX-derived: round2(1000 × 1.10) = 1100 (NOT qty × price = 3500).
    expect(Number(log!.cashflow_amount_usd)).toBe(1100);
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

  // ── Model B (C1): a yield row ALWAYS recomputes on backdate ──────────────────
  //
  // Pre-Model-B the gate skipped yield rows (is_yield was a hard exclusion). Under
  // Model B a yield row's S&P flow IS its market value on the receipt date, so a
  // backdate MUST revalue cashflow_amount_* to the historical price at the new
  // date — exactly like an auto-priced non-yield row.
  it("yield row (cashflow_user_set=false): backdating recomputes cashflow_amount_* to the historical price", async () => {
    // Insert a yield row directly with snapshots the recompute can price:
    // before qty 1 → after qty 1.5 ⇒ qtyDelta 0.5; crypto_asset_id drives the
    // (mocked) $30,000 historical lookup. cashflow_user_set=false (auto).
    const { data: row, error: insErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: walletId, // any non-null id; the recompute reads snapshots, not this
        entity_name: "Bitcoin Backdate Test",
        description: "Yield 0.5 units",
        is_adjustment: false,
        is_yield: true,
        cashflow_user_set: false,
        cashflow_amount_usd: 9000, // stale pre-backdate amount
        cashflow_amount_eur: 8000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: { crypto_asset_id: cryptoAssetId, quantity: 1 },
        after_snapshot: { crypto_asset_id: cryptoAssetId, quantity: 1.5 },
      })
      .select("id")
      .single();
    if (insErr) throw new Error("Failed to insert yield row: " + insErr.message);

    const result = await backdateActivityEntry(row!.id, "2023-06-01");
    expect(result.success).toBe(true);

    const { data: after } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, effective_date, cashflow_user_set, is_yield")
      .eq("id", row!.id)
      .single();

    expect(after).not.toBeNull();
    expect(after!.effective_date).toBe("2023-06-01");
    // Recomputed: qtyDelta(0.5) × $30,000 = $15,000; EUR = 15000 × 0.9091 ≈ 13636.5.
    expect(Number(after!.cashflow_amount_usd)).toBeCloseTo(15000, 0);
    expect(Number(after!.cashflow_amount_eur)).toBeCloseTo(13636.5, 1);
    // Still a yield row; provenance stays auto.
    expect(after!.is_yield).toBe(true);
    expect(after!.cashflow_user_set).toBe(false);
  });

  // ── Model B (C1): a USER-SET yield row recomputes AND clears cashflow_user_set ─
  //
  // A "cost" on a yield row is meaningless (cost is 0 by definition). When such a
  // row is backdated it is revalued to market-at-date AND its provenance is reset
  // to auto (cashflow_user_set=false) — the amount is now machine-derived, so the
  // flag must tell the truth. This is the ONE place Model B overrides the user-set
  // protection, and only because the row is yield.
  it("yield row (cashflow_user_set=true): backdating recomputes AND clears cashflow_user_set", async () => {
    const { data: row, error: insErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: walletId,
        entity_name: "Bitcoin Backdate Test",
        description: "User-set yield 0.5 units",
        is_adjustment: false,
        is_yield: true,
        cashflow_user_set: true, // a (meaningless) user-set amount on a yield row
        cashflow_amount_usd: 7777,
        cashflow_amount_eur: 6666,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: { crypto_asset_id: cryptoAssetId, quantity: 1 },
        after_snapshot: { crypto_asset_id: cryptoAssetId, quantity: 1.5 },
      })
      .select("id")
      .single();
    if (insErr) throw new Error("Failed to insert user-set yield row: " + insErr.message);

    const result = await backdateActivityEntry(row!.id, "2023-06-01");
    expect(result.success).toBe(true);

    const { data: after } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, effective_date, cashflow_user_set, is_yield")
      .eq("id", row!.id)
      .single();

    expect(after).not.toBeNull();
    expect(after!.effective_date).toBe("2023-06-01");
    // Revalued to market-at-date despite the prior user-set amount.
    expect(Number(after!.cashflow_amount_usd)).toBeCloseTo(15000, 0);
    expect(Number(after!.cashflow_amount_eur)).toBeCloseTo(13636.5, 1);
    expect(after!.is_yield).toBe(true);
    // Provenance flipped to auto — the amount is now machine-derived.
    expect(after!.cashflow_user_set).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 1.6 — addTransaction / editTransaction skeleton
// ─────────────────────────────────────────────────────────────────────────────

// Import after mocks (mocks are already declared at the top of this file)
import {
  addTransaction,
  editTransaction,
  markAsYield,
  loadAssetTransactions,
} from "@/lib/actions/transactions";

describe("addTransaction — cost capture (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  // Crypto path
  let walletId: string;
  let cryptoAssetId: string;
  const coingeckoId = `bitcoin-add-txn-test-${randomUUID()}`;

  // Stock path
  let brokerId: string;
  let stockAssetId: string;
  const stockTicker = `ADD${randomUUID().slice(0, 4).toUpperCase()}`;

  // Cash path
  let institutionId: string;

  /**
   * Read the most-recent activity_log row for a given entity_type, scoped to
   * the test user — the standard idiom this file uses to assert on the write.
   */
  async function latestLog(entityType: string) {
    const { data } = await client
      .from("activity_log")
      .select(
        "cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield",
      )
      .eq("entity_type", entityType)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    return data;
  }

  /** Read a crypto position's current absolute quantity (RLS-scoped). */
  async function cryptoQty(assetId: string, wallet: string): Promise<number | null> {
    const { data } = await client
      .from("crypto_positions")
      .select("quantity")
      .eq("crypto_asset_id", assetId)
      .eq("wallet_id", wallet)
      .is("deleted_at", null)
      .maybeSingle();
    return data ? Number(data.quantity) : null;
  }

  /** Read a stock position's current absolute quantity (RLS-scoped). */
  async function stockQty(assetId: string, broker: string): Promise<number | null> {
    const { data } = await client
      .from("stock_positions")
      .select("quantity")
      .eq("stock_asset_id", assetId)
      .eq("broker_id", broker)
      .is("deleted_at", null)
      .maybeSingle();
    return data ? Number(data.quantity) : null;
  }

  /** Read a cash account's current balance (RLS-scoped). */
  async function cashBalance(accountId: string): Promise<number | null> {
    const { data } = await client
      .from("cash_accounts")
      .select("balance")
      .eq("id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    return data ? Number(data.balance) : null;
  }

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

    const { data: broker, error: brokerErr } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "AddTxn Broker" })
      .select("id")
      .single();
    if (brokerErr) throw new Error("Failed to create broker: " + brokerErr.message);
    brokerId = broker!.id;

    const { data: inst, error: instErr } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "AddTxn Bank" })
      .select("id")
      .single();
    if (instErr) throw new Error("Failed to create institution: " + instErr.message);
    institutionId = inst!.id;

    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin AddTxn Test",
      coingecko_id: coingeckoId,
    });

    stockAssetId = await createStockAsset({
      ticker: stockTicker,
      name: "AddTxn Stock Test",
      kind: "yahoo",
      currency: "USD",
    });
  });

  afterAll(() => cleanup());

  // ─── (1) Delta-resolve a Buy on an EXISTING position ────────────────────────
  //
  // The MODAL emits the quantity TRANSACTED (a delta). A buy of +5 on a
  // position of 10 must resolve to upsertPosition(quantity: 15) — NOT 5.
  it("(1) Buy on an existing position delta-resolves to the new absolute (10 + 5 = 15)", async () => {
    // Seed: position at qty 10 via a direct primitive call (market-priced).
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: 10 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );
    expect(await cryptoQty(cryptoAssetId, walletId)).toBe(10);

    // Buy +5 with a user cost of €1000.
    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 5,
        walletId,
        cost: { amount: 1000, currency: "EUR" },
        currentPriceUsd: 60000,
        currentPriceEur: 54545,
      },
    );

    // The position is now 15 (10 + 5), NOT 5.
    expect(await cryptoQty(cryptoAssetId, walletId)).toBe(15);

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    expect(log!.cashflow_user_set).toBe(true);
    // EUR is the input currency → stored verbatim.
    expect(Number(log!.cashflow_amount_eur)).toBe(1000);
    // USD is FX-derived: 1000 EUR × 1.10 USD/EUR = 1100.
    expect(Number(log!.cashflow_amount_usd)).toBe(1100);
  });

  // ─── (2) First Buy (no prior position) creates the position at qty=delta ────
  it("(2) First Buy with no prior position creates the position at the transaction quantity", async () => {
    const { data: wallet2, error: w2Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "FirstBuy Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w2Err) throw new Error("Failed to create wallet2: " + w2Err.message);

    // No prior position in this wallet.
    expect(await cryptoQty(cryptoAssetId, wallet2!.id)).toBeNull();

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.3,
        walletId: wallet2!.id,
        cost: { amount: 9000, currency: "USD" },
      },
    );

    // First buy → position created at exactly the transacted quantity.
    expect(await cryptoQty(cryptoAssetId, wallet2!.id)).toBe(0.3);
  });

  // ─── (3) Sell reduces the absolute (10 − 3 = 7) ─────────────────────────────
  it("(3) Sell delta-resolves down: position 10, sell 3 → 7", async () => {
    const { data: wallet3, error: w3Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Sell Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (w3Err) throw new Error("Failed to create wallet3: " + w3Err.message);

    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: wallet3!.id, quantity: 10 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );
    expect(await cryptoQty(cryptoAssetId, wallet3!.id)).toBe(10);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "sell",
        quantity: 3,
        walletId: wallet3!.id,
        currentPriceUsd: 60000,
        currentPriceEur: 54545,
      },
    );

    expect(await cryptoQty(cryptoAssetId, wallet3!.id)).toBe(7);
  });

  // ─── (3s) Stock Buy delta-resolves on an existing position (cost override) ───
  it("(3s) Stock Buy delta-resolves the absolute and stores the cost override", async () => {
    // Seed a stock position at 10 shares (market-priced).
    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: brokerId, quantity: 10 },
      { currentPriceNative: 100, assetCurrency: "USD" },
    );
    expect(await stockQty(stockAssetId, brokerId)).toBe(10);

    // Buy +4 shares with a USD cost. The override bypasses qty × native price,
    // so the native price is irrelevant here.
    await addTransaction(
      { class: "stock", assetId: stockAssetId },
      {
        type: "buy",
        quantity: 4,
        brokerId,
        cost: { amount: 1000, currency: "USD" },
      },
    );

    // 10 + 4 = 14, NOT 4.
    expect(await stockQty(stockAssetId, brokerId)).toBe(14);

    const log = await latestLog("stock_position");
    expect(log).not.toBeNull();
    expect(log!.cashflow_user_set).toBe(true);
    expect(Number(log!.cashflow_amount_usd)).toBe(1000);
    // EUR derived: 1000 × 0.9091 = 909.1.
    expect(Number(log!.cashflow_amount_eur)).toBe(909.1);
  });

  // ─── (4) case-16 FX derivation, both directions ─────────────────────────────
  it("(4a) EUR cost → eur stored verbatim, usd = round2(amount × USD-per-EUR)", async () => {
    const { data: w, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "FX-EUR Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create wallet: " + error.message);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.1,
        walletId: w!.id,
        cost: { amount: 1000, currency: "EUR" },
      },
    );

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    // EUR is the input → exact.
    expect(Number(log!.cashflow_amount_eur)).toBe(1000);
    // USD derived: 1000 × 1.10 = 1100 (mock EUR→USD rate is 1.10).
    expect(Number(log!.cashflow_amount_usd)).toBe(1100);
    // Relationship holds regardless of the specific rate.
    expect(Number(log!.cashflow_amount_usd)).toBeGreaterThan(
      Number(log!.cashflow_amount_eur),
    );
    expect(log!.cashflow_user_set).toBe(true);
  });

  it("(4b) USD cost → usd stored verbatim, eur = round2(amount × EUR-per-USD)", async () => {
    const { data: w, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "FX-USD Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create wallet: " + error.message);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.1,
        walletId: w!.id,
        cost: { amount: 1000, currency: "USD" },
      },
    );

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    // USD is the input → exact.
    expect(Number(log!.cashflow_amount_usd)).toBe(1000);
    // EUR derived: 1000 × 0.9091 = 909.1 → round2 = 909.1.
    expect(Number(log!.cashflow_amount_eur)).toBe(909.1);
    expect(log!.cashflow_user_set).toBe(true);
  });

  // ─── (5) No cost → market fallback, cashflow_user_set=false ──────────────────
  it("(5) Buy without a cost uses the market price and cashflow_user_set=false", async () => {
    const { data: w, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "NoCost Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create wallet: " + error.message);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.1,
        walletId: w!.id,
        currentPriceUsd: 50000,
        currentPriceEur: 45454,
        // cost deliberately absent
      },
    );

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    // Market fallback: qty=0.1 × $50,000 = $5,000.
    expect(Number(log!.cashflow_amount_usd)).toBeCloseTo(5000, 0);
    expect(log!.cashflow_user_set).toBe(false);
  });

  // ─── (6) Yield → quantity-UP, is_yield=true, NO cost override ────────────────
  it("(6) Yield increases qty, sets is_yield=true, and does NOT set a cost override", async () => {
    const { data: w, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Yield Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create wallet: " + error.message);

    // Seed position at 1.0.
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: w!.id, quantity: 1.0 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "yield",
        quantity: 0.05,
        walletId: w!.id,
        currentPriceUsd: 60000,
        currentPriceEur: 54545,
      },
    );

    // Yield is a quantity-UP acquisition: 1.0 + 0.05 = 1.05.
    expect(await cryptoQty(cryptoAssetId, w!.id)).toBe(1.05);

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    expect(log!.is_yield).toBe(true);
    // Yield carries no cost override — amount is the market value, not user-set.
    expect(log!.cashflow_user_set).toBe(false);
  });

  // ─── (7) Cash deposit → balance up, cost override carried ────────────────────
  it("(7) Cash deposit raises the balance and records the cost override", async () => {
    // Create the account at balance 500 (in EUR).
    const { data: acct, error } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        currency: "EUR",
        balance: 500,
        name: "Deposit Test Account",
      })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create cash account: " + error.message);

    await addTransaction(
      { class: "cash", accountId: acct!.id },
      {
        type: "deposit",
        quantity: 200,
        cost: { amount: 200, currency: "EUR" },
      },
    );

    // Balance 500 + 200 = 700.
    expect(await cashBalance(acct!.id)).toBe(700);

    const log = await latestLog("cash_account");
    expect(log).not.toBeNull();
    expect(log!.cashflow_user_set).toBe(true);
    expect(Number(log!.cashflow_amount_eur)).toBe(200);
    // USD derived: 200 × 1.10 = 220.
    expect(Number(log!.cashflow_amount_usd)).toBe(220);
  });

  // ─── (8) Ownership / validation guards ──────────────────────────────────────
  it("(8a) Crypto buy with no walletId throws", async () => {
    await expect(
      addTransaction(
        { class: "crypto", assetId: cryptoAssetId },
        { type: "buy", quantity: 0.05, currentPriceUsd: 60000 },
      ),
    ).rejects.toThrow(/walletId/i);
  });

  it("(8c) Stock buy with no brokerId throws", async () => {
    await expect(
      addTransaction(
        { class: "stock", assetId: stockAssetId },
        { type: "buy", quantity: 1, cost: { amount: 100, currency: "USD" } },
      ),
    ).rejects.toThrow(/brokerId/i);
  });

  it("(8b) A future effectiveDate throws (validatePastOrTodayDate)", async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    await expect(
      addTransaction(
        { class: "crypto", assetId: cryptoAssetId },
        {
          type: "buy",
          quantity: 0.05,
          walletId,
          effectiveDate: future,
          cost: { amount: 100, currency: "EUR" },
        },
      ),
    ).rejects.toThrow(/future/i);
  });

  // ─── H1 — Oversell guards ────────────────────────────────────────────────────

  it("(H1-crypto) Oversell on a crypto position is rejected; position unchanged", async () => {
    // Fresh wallet so the seed qty is known precisely.
    const { data: wOvr, error: wOvrErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Oversell Crypto Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (wOvrErr) throw new Error("Failed to create wallet: " + wOvrErr.message);
    const oversellWalletId = wOvr!.id;

    // Seed the position at qty 10.
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: oversellWalletId, quantity: 10 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );
    expect(await cryptoQty(cryptoAssetId, oversellWalletId)).toBe(10);

    // Attempt to sell 15 (more than held) — must throw.
    await expect(
      addTransaction(
        { class: "crypto", assetId: cryptoAssetId },
        { type: "sell", quantity: 15, walletId: oversellWalletId, currentPriceUsd: 60000 },
      ),
    ).rejects.toThrow(/only 10 held/i);

    // Position must be unchanged.
    expect(await cryptoQty(cryptoAssetId, oversellWalletId)).toBe(10);
  });

  it("(H1-stock) Oversell on a stock position is rejected with 'broker' in message; position unchanged", async () => {
    // Fresh broker so the seed qty is known precisely.
    const { data: bOvr, error: bOvrErr } = await client
      .from("brokers")
      .insert({ user_id: userId, name: "Oversell Broker" })
      .select("id")
      .single();
    if (bOvrErr) throw new Error("Failed to create broker: " + bOvrErr.message);
    const oversellBrokerId = bOvr!.id;

    // Seed the stock position at qty 10.
    await upsertStockPosition(
      { stock_asset_id: stockAssetId, broker_id: oversellBrokerId, quantity: 10 },
      { currentPriceNative: 100, assetCurrency: "USD" },
    );
    expect(await stockQty(stockAssetId, oversellBrokerId)).toBe(10);

    // Attempt to sell 15 (more than held) — must throw mentioning "broker".
    await expect(
      addTransaction(
        { class: "stock", assetId: stockAssetId },
        { type: "sell", quantity: 15, brokerId: oversellBrokerId },
      ),
    ).rejects.toThrow(/only 10 held.*broker|broker.*only 10 held/i);

    // Position must be unchanged.
    expect(await stockQty(stockAssetId, oversellBrokerId)).toBe(10);
  });

  it("(H1-zero) Full sell to exactly 0 is allowed (clean exit, no oversell guard)", async () => {
    // Fresh wallet for a clean isolated test.
    const { data: wExit, error: wExitErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Full Exit Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (wExitErr) throw new Error("Failed to create wallet: " + wExitErr.message);
    const exitWalletId = wExit!.id;

    // Seed at qty 10.
    await upsertPosition(
      { crypto_asset_id: cryptoAssetId, wallet_id: exitWalletId, quantity: 10 },
      { currentPriceUsd: 60000, currentPriceEur: 54545 },
    );
    expect(await cryptoQty(cryptoAssetId, exitWalletId)).toBe(10);

    // Sell exactly 10 — must NOT throw; position is soft-deleted (reads null).
    await expect(
      addTransaction(
        { class: "crypto", assetId: cryptoAssetId },
        { type: "sell", quantity: 10, walletId: exitWalletId, currentPriceUsd: 60000 },
      ),
    ).resolves.not.toThrow();

    // Soft-deleted position → returns null (no live row).
    expect(await cryptoQty(cryptoAssetId, exitWalletId)).toBeNull();
  });

  // ─── M1 — Cash overdraft guard ──────────────────────────────────────────────

  it("(M1-overdraft) Withdrawal exceeding balance is rejected; balance unchanged", async () => {
    // Create cash account with balance 500.
    const { data: acctOvr, error: acctOvrErr } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        currency: "EUR",
        balance: 500,
        name: "Overdraft Test Account",
      })
      .select("id")
      .single();
    if (acctOvrErr) throw new Error("Failed to create cash account: " + acctOvrErr.message);
    const overdraftAccountId = acctOvr!.id;

    // Attempt to withdraw 600 from a 500-balance account — must throw.
    await expect(
      addTransaction(
        { class: "cash", accountId: overdraftAccountId },
        { type: "withdrawal", quantity: 600 },
      ),
    ).rejects.toThrow(/only 500 available/i);

    // Balance must still be 500.
    expect(await cashBalance(overdraftAccountId)).toBe(500);
  });

  it("(M1-zero) Withdrawal to exactly 0 is allowed (empty account, no overdraft guard)", async () => {
    // Create cash account with balance 500.
    const { data: acctZero, error: acctZeroErr } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        currency: "EUR",
        balance: 500,
        name: "Empty Account Test",
      })
      .select("id")
      .single();
    if (acctZeroErr) throw new Error("Failed to create cash account: " + acctZeroErr.message);
    const zeroAccountId = acctZero!.id;

    // Withdraw exactly 500 — must NOT throw; balance becomes 0.
    await expect(
      addTransaction(
        { class: "cash", accountId: zeroAccountId },
        { type: "withdrawal", quantity: 500 },
      ),
    ).resolves.not.toThrow();

    expect(await cashBalance(zeroAccountId)).toBe(0);
  });

  // ─── L1 — Cost provenance: verbatim input, rounded derived leg ───────────────

  it("(L1) EUR cost: input leg NOT pre-rounded by code; derived USD leg = round2(verbatim × rate)", async () => {
    // DB column cashflow_amount_* is NUMERIC(18,2) — it always stores 2 dp.
    // L1's invariant is that the CODE does not call round2() on the EUR input
    // before computing the USD derived leg, so the cross-currency result is
    // round2(100.555 × 1.10) = round2(110.6105) = 110.61 — NOT the double-
    // rounded value round2(round2(100.555) × 1.10) = round2(100.56 × 1.10)
    //   = round2(110.616) = 110.62.
    //
    // FX mock: EUR→USD = 1.10.
    const { data: wL1, error: wL1Err } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "L1 Provenance Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (wL1Err) throw new Error("Failed to create wallet: " + wL1Err.message);

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.01,
        walletId: wL1!.id,
        cost: { amount: 100.555, currency: "EUR" },
      },
    );

    const log = await latestLog("crypto_position");
    expect(log).not.toBeNull();
    // DB rounds EUR to 2 dp: 100.555 → 100.56 (standard DB rounding).
    // This confirms the code passed the verbatim value (not a pre-rounded one).
    expect(Number(log!.cashflow_amount_eur)).toBe(100.56);
    // USD = round2(100.555 × 1.10) = round2(110.6105) = 110.61.
    // If code had pre-rounded EUR first: round2(100.56 × 1.10) = round2(110.616) = 110.62 — WRONG.
    // 110.61 proves the verbatim 100.555 was used for the cross-rate computation.
    expect(Number(log!.cashflow_amount_usd)).toBe(110.61);
    expect(log!.cashflow_user_set).toBe(true);
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

    // Snapshot the amount columns BEFORE the cross-user attempt so we can prove
    // the guarded fetch rejected before any 8-column write touched the row.
    const { data: before } = await userA.client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("id", userAEntryId)
      .single();

    // A cost edit (not just a date edit) — the most damaging cross-user write.
    const result = await editTransaction(userAEntryId, {
      effectiveDate: "2024-01-01",
      cost: { amount: 99999, currency: "USD" },
    });

    // Must return a not-found result — no cross-user write
    expect(result.success).toBe(false);
    expect(result.notFound).toBe(true);

    // Verify userA's row is unchanged — date AND amount columns intact.
    const { data: row } = await userA.client
      .from("activity_log")
      .select("effective_date, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set")
      .eq("id", userAEntryId)
      .single();

    expect(row).not.toBeNull();
    expect(row!.effective_date).toBe(userAOriginalDate);
    expect(Number(row!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(row!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
    expect(row!.cashflow_user_set).toBe(before!.cashflow_user_set);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2.5 — editTransaction: guarded 8-column amount edit
// ─────────────────────────────────────────────────────────────────────────────

import { COST_COPY } from "@/lib/cost-basis-copy";
import { round2 } from "@/lib/format";

describe("editTransaction — guarded 8-column amount edit (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let cryptoAssetId: string; // non-stable (BTC)
  let stableAssetId: string; // subcategory = "stablecoin"
  const coingeckoId = `bitcoin-edit-txn-${randomUUID()}`;
  const stableCoingeckoId = `usdc-edit-txn-${randomUUID()}`;

  /**
   * Read the FULL set of amount/status columns for a row — the 8-column
   * invariant is asserted against this shape repeatedly.
   */
  async function readAmounts(entryId: string) {
    const { data } = await client
      .from("activity_log")
      .select(
        "cashflow_amount_usd, cashflow_amount_eur, cashflow_status, cashflow_asset_class, cashflow_user_set, delta_usd, delta_eur, delta_status, effective_date, is_adjustment",
      )
      .eq("id", entryId)
      .single();
    return data;
  }

  /**
   * Create the activity_log entry for a fresh crypto position and return its id.
   * `isAdjustment` selects the real-flow (false) vs adjustment (true) branch.
   * Each call uses a brand-new wallet so the "most recent" log row is
   * unambiguously the one we just created.
   */
  async function seedCryptoEntry(opts: {
    assetId: string;
    isAdjustment?: boolean;
  }): Promise<string> {
    const { data: wallet, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: `Edit Wallet ${randomUUID()}`, wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create wallet: " + error.message);

    await upsertPosition(
      { crypto_asset_id: opts.assetId, wallet_id: wallet!.id, quantity: 1.0 },
      { currentPriceUsd: 60000, currentPriceEur: 54545, isAdjustment: opts.isAdjustment },
    );

    const { data: log } = await client
      .from("activity_log")
      .select("id")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!log) throw new Error("Failed to find seeded activity_log entry");
    return log.id;
  }

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin EditTxn Test",
      coingecko_id: coingeckoId,
    });

    // Stablecoin asset — subcategory drives classifyAssetClass → "cash".
    stableAssetId = await createCryptoAsset({
      ticker: "USDC",
      name: "USDC EditTxn Test",
      coingecko_id: stableCoingeckoId,
      subcategory: "stablecoin",
    });
  });

  afterAll(() => cleanup());

  // ─── (1) Real-flow amount edit — the 8-column invariant ─────────────────────
  it("(1) real-flow edit writes cashflow side complete + nulls the delta side entirely", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });

    const result = await editTransaction(entryId, {
      cost: { amount: 1234, currency: "EUR" },
    });
    expect(result.success).toBe(true);

    const a = await readAmounts(entryId);
    expect(a).not.toBeNull();
    // New side populated:
    expect(Number(a!.cashflow_amount_eur)).toBe(1234); // EUR input verbatim
    expect(Number(a!.cashflow_amount_usd)).toBe(round2(1234 * 1.1)); // FX-derived
    expect(a!.cashflow_status).toBe("complete");
    expect(a!.cashflow_asset_class).toBe("crypto"); // non-stable crypto
    expect(a!.cashflow_user_set).toBe(true);
    // Old side fully nulled — amount AND status (no phantom contribution):
    expect(a!.delta_usd).toBeNull();
    expect(a!.delta_eur).toBeNull();
    expect(a!.delta_status).toBeNull();
  });

  // ─── (2) Adjustment amount edit — mirror invariant on the delta side ────────
  it("(2) adjustment edit writes delta side complete + nulls the cashflow side entirely", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId, isAdjustment: true });

    const result = await editTransaction(entryId, {
      cost: { amount: 500, currency: "USD" },
    });
    expect(result.success).toBe(true);

    const a = await readAmounts(entryId);
    expect(a).not.toBeNull();
    // Delta side populated:
    expect(Number(a!.delta_usd)).toBe(500); // USD input verbatim
    expect(Number(a!.delta_eur)).toBe(round2(500 * 0.9091)); // FX-derived = 454.55
    expect(a!.delta_status).toBe("complete");
    // Cashflow side fully nulled — amount AND status AND asset_class:
    expect(a!.cashflow_amount_usd).toBeNull();
    expect(a!.cashflow_amount_eur).toBeNull();
    expect(a!.cashflow_status).toBeNull();
    expect(a!.cashflow_asset_class).toBeNull();
    // is_adjustment is NOT toggled by editTransaction:
    expect(a!.is_adjustment).toBe(true);
  });

  // ─── (3) Stablecoin classification → "cash"; non-stable → "crypto" ──────────
  it("(3) stablecoin crypto classifies cashflow_asset_class as 'cash'", async () => {
    const entryId = await seedCryptoEntry({ assetId: stableAssetId });

    const result = await editTransaction(entryId, {
      cost: { amount: 100, currency: "USD" },
    });
    expect(result.success).toBe(true);

    const a = await readAmounts(entryId);
    expect(a!.cashflow_asset_class).toBe("cash");
  });

  it("(3b) non-stable crypto classifies cashflow_asset_class as 'crypto'", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });

    const result = await editTransaction(entryId, {
      cost: { amount: 100, currency: "USD" },
    });
    expect(result.success).toBe(true);

    const a = await readAmounts(entryId);
    expect(a!.cashflow_asset_class).toBe("crypto");
  });

  // ─── (4) Guards — each rejects BEFORE writing; row columns UNCHANGED ─────────

  it("(4a) transfer leg (transfer_group_id set) is rejected; row unchanged", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    // Tag the row as a transfer leg.
    await client
      .from("activity_log")
      .update({ transfer_group_id: randomUUID() })
      .eq("id", entryId);
    const before = await readAmounts(entryId);

    const result = await editTransaction(entryId, { cost: { amount: 777, currency: "EUR" } });
    expect(result.success).toBe(false);
    expect(result.message).toBe(COST_COPY.transferLegLocked);

    // Row's amount columns untouched (guard rejected before the write).
    const after = await readAmounts(entryId);
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
    expect(after!.cashflow_user_set).toBe(before!.cashflow_user_set);
  });

  it("(4b) split child (split_from_id set) is rejected; row unchanged", async () => {
    // A split child references a parent activity_log row (self-FK).
    const parentId = await seedCryptoEntry({ assetId: cryptoAssetId });
    const childId = await seedCryptoEntry({ assetId: cryptoAssetId });
    await client
      .from("activity_log")
      .update({ split_from_id: parentId })
      .eq("id", childId);
    const before = await readAmounts(childId);

    const result = await editTransaction(childId, { cost: { amount: 777, currency: "EUR" } });
    expect(result.success).toBe(false);
    expect(result.message).toBe(COST_COPY.splitChildLocked);

    const after = await readAmounts(childId);
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
  });

  it("(4c) undone row (undone_at set) is rejected; row unchanged", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    await client
      .from("activity_log")
      .update({ undone_at: new Date().toISOString() })
      .eq("id", entryId);
    const before = await readAmounts(entryId);

    const result = await editTransaction(entryId, { cost: { amount: 777, currency: "EUR" } });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/undone/i);

    const after = await readAmounts(entryId);
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
  });

  it("(4d) compensation row (compensates_for set) is rejected; row unchanged", async () => {
    // compensates_for references a parent activity_log row (self-FK).
    const targetId = await seedCryptoEntry({ assetId: cryptoAssetId });
    const reversalId = await seedCryptoEntry({ assetId: cryptoAssetId });
    await client
      .from("activity_log")
      .update({ compensates_for: targetId })
      .eq("id", reversalId);
    const before = await readAmounts(reversalId);

    const result = await editTransaction(reversalId, { cost: { amount: 777, currency: "EUR" } });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/reversal/i);

    const after = await readAmounts(reversalId);
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
  });

  // ─── (6) Date-only edit leaves ALL 8 amount/status columns untouched ────────
  it("(6) date-only edit changes effective_date and touches no amount/status column", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    const before = await readAmounts(entryId);

    const newDate = "2023-03-14";
    const result = await editTransaction(entryId, { effectiveDate: newDate });
    expect(result.success).toBe(true);

    const after = await readAmounts(entryId);
    expect(after!.effective_date).toBe(newDate);
    // All 8 amount/status columns identical to before.
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
    expect(after!.cashflow_status).toBe(before!.cashflow_status);
    expect(after!.cashflow_asset_class).toBe(before!.cashflow_asset_class);
    expect(after!.cashflow_user_set).toBe(before!.cashflow_user_set);
    expect(after!.delta_usd).toBe(before!.delta_usd);
    expect(after!.delta_eur).toBe(before!.delta_eur);
    expect(after!.delta_status).toBe(before!.delta_status);
  });

  // ─── (7) case-16 in edit: EUR exact, USD FX-derived ─────────────────────────
  it("(7) EUR cost stored verbatim; USD = round2(amount × USD-per-EUR)", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });

    const result = await editTransaction(entryId, {
      cost: { amount: 2500, currency: "EUR" },
    });
    expect(result.success).toBe(true);

    const a = await readAmounts(entryId);
    expect(Number(a!.cashflow_amount_eur)).toBe(2500); // exact
    expect(Number(a!.cashflow_amount_usd)).toBe(round2(2500 * 1.1)); // = 2750
    expect(Number(a!.cashflow_amount_usd)).toBeGreaterThan(
      Number(a!.cashflow_amount_eur),
    );
  });

  // ─── (8) Validation ─────────────────────────────────────────────────────────
  it("(8a) malformed UUID is rejected by validateUUID", async () => {
    await expect(
      editTransaction("not-a-uuid", { cost: { amount: 100, currency: "USD" } }),
    ).rejects.toThrow(/UUID/i);
  });

  it("(8b) a future effectiveDate is rejected; row unchanged", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    const before = await readAmounts(entryId);
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    await expect(
      editTransaction(entryId, { effectiveDate: future }),
    ).rejects.toThrow(/future/i);

    const after = await readAmounts(entryId);
    expect(after!.effective_date).toBe(before!.effective_date);
  });

  // ─── No-op: neither cost nor effectiveDate ──────────────────────────────────
  it("(9) no-op edit (neither cost nor effectiveDate) returns 'Nothing to update'", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    const result = await editTransaction(entryId, {});
    expect(result.success).toBe(true);
    expect(result.message).toBe("Nothing to update");
  });

  // ─── H1 — Yield cost guard ───────────────────────────────────────────────────

  it("(H1-yield-cost) cost edit on a yield row is rejected; amount columns unchanged", async () => {
    // Seed a yield entry by upsertPosition with isYield=true.
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    // Mark the row as yield directly (simulates a prior markAsYield call).
    await client.from("activity_log").update({ is_yield: true }).eq("id", entryId);

    const before = await readAmounts(entryId);

    const result = await editTransaction(entryId, {
      cost: { amount: 100, currency: "EUR" },
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe(COST_COPY.yieldHasNoCost);

    // Amount + provenance columns must be UNCHANGED.
    const after = await readAmounts(entryId);
    expect(Number(after!.cashflow_amount_usd)).toBe(Number(before!.cashflow_amount_usd));
    expect(Number(after!.cashflow_amount_eur)).toBe(Number(before!.cashflow_amount_eur));
    expect(after!.cashflow_user_set).toBe(before!.cashflow_user_set);
  });

  it("(H1-yield-date) date-only edit on a yield row succeeds (guard is cost-gated)", async () => {
    // Seed another yield entry.
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    await client.from("activity_log").update({ is_yield: true }).eq("id", entryId);

    // DATE-ONLY edit — no cost → guard must not fire.
    const result = await editTransaction(entryId, { effectiveDate: "2026-01-15" });

    expect(result.success).toBe(true);

    const after = await readAmounts(entryId);
    expect(after!.effective_date).toBe("2026-01-15");
  });

  // ─── H2 — Clear-date FX uses created_at ──────────────────────────────────────
  //
  // The FX mock returns a fixed EUR→USD rate of 1.10 regardless of the date
  // argument, so we cannot differentiate "today" from "created_at" via the
  // derived amount alone. Instead we assert that clearing the date + supplying
  // a cost SUCCEEDS without throwing, and that the stored amounts are consistent
  // with the mock rate (proving the FX path ran without error and the clear-date
  // branch is exercised). If the bug were still present (fxDate=undefined →
  // getFXRates called with undefined date) the real FX client would behave
  // differently, but the mock is date-agnostic so we validate path correctness
  // + amount consistency as the best feasible assertion in this harness.
  it("(H2-clear-date) clearing effectiveDate + new cost succeeds; amounts consistent with mock FX", async () => {
    const entryId = await seedCryptoEntry({ assetId: cryptoAssetId });
    // Set an effective_date on the row first (so clearing it is meaningful).
    await client
      .from("activity_log")
      .update({ effective_date: "2025-06-01" })
      .eq("id", entryId);

    // Clear the date (null) AND provide a cost — exercises the H2 branch.
    const result = await editTransaction(entryId, {
      effectiveDate: null,
      cost: { amount: 500, currency: "EUR" },
    });

    expect(result.success).toBe(true);

    const after = await readAmounts(entryId);
    // effective_date cleared to null.
    expect(after!.effective_date).toBeNull();
    // EUR stored verbatim, USD = round2(500 × 1.10) = 550.
    expect(Number(after!.cashflow_amount_eur)).toBe(500);
    expect(Number(after!.cashflow_amount_usd)).toBe(round2(500 * 1.1));
    expect(after!.cashflow_user_set).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2.6 — markAsYield: guarded bulk reclassify (acquisition-only)
// ─────────────────────────────────────────────────────────────────────────────

describe("markAsYield — guarded bulk reclassify (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  /**
   * Insert an activity_log row directly with full control over the guard columns
   * + snapshots — far cleaner than routing through a primitive for the edge
   * cases. Defaults model an ELIGIBLE acquisition: a qty-UP crypto_position
   * (before 1 → after 2 ⇒ quantityDelta = +1), is_adjustment=false, no
   * transfer / split / undo / compensation, cashflow_status='complete',
   * is_yield=false. Each test overrides only the column under test.
   */
  async function insertRow(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const base = {
      user_id: userId,
      entity_type: "crypto_position",
      entity_name: "MAY Test Asset",
      action: "updated",
      description: "markAsYield test row",
      is_adjustment: false,
      is_yield: false,
      transfer_group_id: null,
      split_from_id: null,
      undone_at: null,
      compensates_for: null,
      cashflow_status: "complete",
      cashflow_amount_usd: 1100,
      cashflow_amount_eur: 1000,
      before_snapshot: { quantity: 1 },
      after_snapshot: { quantity: 2 },
    };
    const { data, error } = await client
      .from("activity_log")
      .insert({ ...base, ...overrides })
      .select("id")
      .single();
    if (error) throw new Error("Failed to insert activity_log row: " + error.message);
    return data!.id;
  }

  /** Reads is_yield, cashflow_amount_usd, cashflow_amount_eur for a row. */
  async function readRow(id: string) {
    const { data } = await client
      .from("activity_log")
      .select("is_yield, cashflow_amount_usd, cashflow_amount_eur")
      .eq("id", id)
      .single();
    return data;
  }

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;
  });

  afterAll(() => cleanup());

  // ─── (1) Eligible acquisition → flipped; amount columns UNCHANGED (lossless) ─
  it("(1) eligible interest row is flipped to is_yield=true; cashflow amount columns unchanged", async () => {
    const id = await insertRow();

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 1, skipped: 0 });

    const after = await readRow(id);
    expect(after!.is_yield).toBe(true);
    // Amount columns intact — un-yield is lossless, is_yield is the only SOT.
    expect(Number(after!.cashflow_amount_usd)).toBe(1100);
    expect(Number(after!.cashflow_amount_eur)).toBe(1000);
  });

  // ─── (2) THE audit-r6 case: a disposal (quantityDelta <= 0) is SKIPPED ───────
  //
  // This is the most important test. The row passes EVERY SQL predicate term
  // (is_adjustment=false, no transfer/split/undo/compensation,
  // cashflow_status='complete', is_yield=false) — the ONLY thing rejecting it is
  // quantityDelta <= 0 (before 10 → after 7 ⇒ delta = −3). Without the
  // `quantityDelta > 0` guard this sell would be wrongly marked as yield, zeroing
  // its cost and dropping a real outflow from the S&P benchmark.
  it("(2) a Sell/Withdrawal disposal (quantityDelta <= 0) is skipped; is_yield stays false", async () => {
    const id = await insertRow({
      before_snapshot: { quantity: 10 },
      after_snapshot: { quantity: 7 }, // delta = 7 - 10 = -3 (a disposal)
    });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });

    const after = await readRow(id);
    expect(after!.is_yield).toBe(false);
  });

  // ─── (2b) A "removed" full sell (null after_snapshot, delta < 0) is skipped ──
  it("(2b) a 'removed' full disposal (null after_snapshot) is skipped", async () => {
    const id = await insertRow({
      action: "removed",
      before_snapshot: { quantity: 5 },
      after_snapshot: null, // val(after)=0 ⇒ delta = 0 - 5 = -5
    });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (3) Transfer leg (transfer_group_id set) → skipped ──────────────────────
  it("(3) a transfer leg (transfer_group_id set) is skipped; is_yield unchanged", async () => {
    const id = await insertRow({ transfer_group_id: randomUUID() });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (4) Adjustment correction (is_adjustment=true) → skipped ────────────────
  it("(4) an is_adjustment correction is skipped; is_yield unchanged", async () => {
    const id = await insertRow({ is_adjustment: true });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (5) Compensation row (compensates_for set) → skipped ────────────────────
  it("(5) a compensation row (compensates_for set) is skipped; is_yield unchanged", async () => {
    // compensates_for is a self-FK → point it at a real eligible row.
    const targetId = await insertRow();
    const id = await insertRow({ compensates_for: targetId });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (6) Split child (split_from_id set) → skipped ───────────────────────────
  it("(6) a split child (split_from_id set) is skipped; is_yield unchanged", async () => {
    // split_from_id is a self-FK → point it at a real parent row.
    const parentId = await insertRow();
    const id = await insertRow({ split_from_id: parentId });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (7) Already-yield row (is_yield=true) → skipped, not double-counted ──────
  it("(7) an already-yield row is skipped (updated stays 0)", async () => {
    const id = await insertRow({ is_yield: true });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    // Still yield (unchanged) — and crucially NOT counted toward `updated`.
    expect((await readRow(id))!.is_yield).toBe(true);
  });

  // ─── (8) Undone row (undone_at set) → skipped ────────────────────────────────
  it("(8) an undone row (undone_at set) is skipped; is_yield unchanged", async () => {
    const id = await insertRow({ undone_at: new Date().toISOString() });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (9) Non-complete cashflow (pending / null) → skipped ────────────────────
  it("(9a) a pending-cashflow row (cashflow_status='pending') is skipped", async () => {
    const id = await insertRow({ cashflow_status: "pending" });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  it("(9b) a null-cashflow-status row is skipped", async () => {
    const id = await insertRow({ cashflow_status: null });

    const result = await markAsYield([id]);
    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect((await readRow(id))!.is_yield).toBe(false);
  });

  // ─── (10) Mixed batch → eligible flip, ineligible don't; counts are honest ───
  it("(10) mixed batch [eligible, ineligible, eligible] → updated:2, skipped:1", async () => {
    const eligibleA = await insertRow();
    const ineligible = await insertRow({ is_adjustment: true }); // skipped
    const eligibleB = await insertRow();

    const result = await markAsYield([eligibleA, ineligible, eligibleB]);
    expect(result).toEqual({ updated: 2, skipped: 1 });

    expect((await readRow(eligibleA))!.is_yield).toBe(true);
    expect((await readRow(eligibleB))!.is_yield).toBe(true);
    expect((await readRow(ineligible))!.is_yield).toBe(false);
  });

  // ─── (11) Ownership (#97): A cannot mark B's row ─────────────────────────────
  it("(11) user A calling markAsYield on user B's row → skipped; B's row unchanged", async () => {
    // Create user B and an eligible row owned by B (direct insert as B).
    const userB = await createTestUser();
    try {
      const { data: bRow, error: bErr } = await userB.client
        .from("activity_log")
        .insert({
          user_id: userB.userId,
          entity_type: "crypto_position",
          entity_name: "B's Asset",
          action: "updated",
          description: "B's eligible row",
          is_adjustment: false,
          is_yield: false,
          cashflow_status: "complete",
          before_snapshot: { quantity: 1 },
          after_snapshot: { quantity: 2 },
        })
        .select("id")
        .single();
      if (bErr) throw new Error("Failed to insert B's row: " + bErr.message);
      const bId = bRow!.id;

      // markAsYield runs as user A (hoisted.testClient is A's client). B's row is
      // not returned by A's `.eq("user_id", A)` fetch → counted as skipped.
      const result = await markAsYield([bId]);
      expect(result).toEqual({ updated: 0, skipped: 1 });

      // B's row must be untouched — verified via B's own RLS client.
      const { data: bAfter } = await userB.client
        .from("activity_log")
        .select("is_yield")
        .eq("id", bId)
        .single();
      expect(bAfter!.is_yield).toBe(false);
    } finally {
      userB.cleanup();
    }
  });

  // ─── (12) Empty / malformed ──────────────────────────────────────────────────
  it("(12a) empty ids → { updated: 0, skipped: 0 } (no DB contact)", async () => {
    const result = await markAsYield([]);
    expect(result).toEqual({ updated: 0, skipped: 0 });
  });

  it("(12b) a malformed UUID throws (validateUUID)", async () => {
    await expect(markAsYield(["not-a-uuid"])).rejects.toThrow(/UUID/i);
  });

  // ─── (13) Duplicate ids collapse — counts are honest ─────────────────────────
  it("(13) duplicate ids in input collapse to one; updated=1, skipped=0, is_yield=true", async () => {
    const id = await insertRow();

    const result = await markAsYield([id, id]);
    expect(result).toEqual({ updated: 1, skipped: 0 });

    const after = await readRow(id);
    expect(after!.is_yield).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2.x (UI wiring) — loadAssetTransactions wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAssetTransactions — owner read + lock-flag enrichment (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let walletId: string;
  let cryptoAssetId: string;
  const coingeckoId = `bitcoin-load-txn-${randomUUID()}`;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "LoadTxn Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("Failed to create wallet: " + walletErr.message);
    walletId = wallet!.id;

    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin LoadTxn Test",
      coingecko_id: coingeckoId,
    });
  });

  afterAll(() => cleanup());

  it("returns a normal buy + a transfer-leg row, each with the correct lock flags + display fields", async () => {
    // A normal buy with a user cost of €1000 → cashflow_user_set, not a leg/child.
    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 1,
        walletId,
        cost: { amount: 1000, currency: "EUR" },
        currentPriceUsd: 60000,
        currentPriceEur: 54545,
      },
    );

    // Grab the buy entry, then add a SECOND entry on the same position and tag it
    // as a transfer leg (the direct-update idiom this file uses for guard tests).
    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      {
        type: "buy",
        quantity: 0.5,
        walletId,
        cost: { amount: 500, currency: "EUR" },
        currentPriceUsd: 60000,
        currentPriceEur: 54545,
      },
    );
    const { data: latest } = await client
      .from("activity_log")
      .select("id")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const legId = latest!.id;
    await client
      .from("activity_log")
      .update({ transfer_group_id: randomUUID() })
      .eq("id", legId);

    // Read in EUR.
    const rows = await loadAssetTransactions({ class: "crypto", assetId: cryptoAssetId }, "EUR");

    // Both rows present.
    expect(rows.length).toBe(2);

    const legRow = rows.find((r) => r.id === legId);
    const buyRow = rows.find((r) => r.id !== legId);
    expect(legRow).toBeDefined();
    expect(buyRow).toBeDefined();

    // The transfer leg carries isTransferLeg=true; the buy has both flags false.
    expect(legRow!.isTransferLeg).toBe(true);
    expect(legRow!.isSplitChild).toBe(false);
    expect(buyRow!.isTransferLeg).toBe(false);
    expect(buyRow!.isSplitChild).toBe(false);

    // Display fields are populated in the requested currency.
    expect(buyRow!.kind).toBe("buy");
    expect(buyRow!.currency).toBe("EUR");
    expect(buyRow!.quantity).toBeGreaterThan(0); // signed +1 acquisition
    expect(buyRow!.amount).toBe(1000); // EUR cost stored verbatim
    expect(typeof buyRow!.date).toBe("string");
  });

  it("reflects the requested currency in the amount column (USD)", async () => {
    const rows = await loadAssetTransactions({ class: "crypto", assetId: cryptoAssetId }, "USD");
    const buyRow = rows.find((r) => r.amount != null && r.kind === "buy");
    expect(buyRow).toBeDefined();
    expect(buyRow!.currency).toBe("USD");
    // USD leg was FX-derived at 1.10: €1000 → $1100.
    expect(buyRow!.amount).toBe(1100);
  });

  it("throws when unauthenticated (owner path requires a user)", async () => {
    // Swap the mock client to one whose auth.getUser() returns no user.
    const prev = hoisted.testClient;
    hoisted.testClient = {
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as unknown as SupabaseClient;
    try {
      await expect(
        loadAssetTransactions({ class: "crypto", assetId: cryptoAssetId }, "EUR"),
      ).rejects.toThrow(/not authenticated/i);
    } finally {
      hoisted.testClient = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadLastChangeDate — correction-date chip backing read
// ─────────────────────────────────────────────────────────────────────────────

describe("loadLastChangeDate — last-change date for the suggest chip (integration)", () => {
  let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
  let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
  // A synthetic entity id (activity_log.entity_id is a free uuid — no FK).
  const entityId = randomUUID();

  beforeAll(async () => {
    userA = await createTestUser();
    userB = await createTestUser();

    // userA's history for the entity:
    //   • a plain row created+effective Apr 10
    //   • a BACKDATED row claiming May 20 but recorded (created_at) in June —
    //     it must WIN by its effective date, not its recorded instant
    //   • an UNDONE row claiming Dec 31 — excluded by the .is("undone_at", null)
    //     server-side filter, so it must NOT win despite the latest claimed date
    const rows = [
      {
        user_id: userA.userId,
        action: "created" as const,
        entity_type: "crypto_position",
        entity_name: "ChipCoin",
        description: "plain buy",
        entity_id: entityId,
        after_snapshot: { quantity: 1 },
        effective_date: "2026-04-10",
        created_at: "2026-04-10T09:00:00Z",
      },
      {
        user_id: userA.userId,
        action: "updated" as const,
        entity_type: "crypto_position",
        entity_name: "ChipCoin",
        description: "backdated correction recorded later",
        entity_id: entityId,
        before_snapshot: { quantity: 1 },
        after_snapshot: { quantity: 2 },
        effective_date: "2026-05-20",
        created_at: "2026-06-01T09:00:00Z",
      },
      {
        user_id: userA.userId,
        action: "updated" as const,
        entity_type: "crypto_position",
        entity_name: "ChipCoin",
        description: "undone row with the latest claimed date",
        entity_id: entityId,
        before_snapshot: { quantity: 2 },
        after_snapshot: { quantity: 3 },
        effective_date: "2026-12-31",
        created_at: "2026-12-31T09:00:00Z",
        undone_at: "2027-01-01T00:00:00Z",
      },
    ];
    const { error } = await userA.client.from("activity_log").insert(rows);
    if (error) throw new Error("Failed to seed activity_log: " + error.message);
  });

  afterAll(() => {
    userA.cleanup();
    userB.cleanup();
  });

  it("returns the backdated effective_date (recorded later, wins), excluding the undone row", async () => {
    hoisted.testClient = userA.client;
    const date = await loadLastChangeDate(entityId);
    // May 20 (backdated, recorded in June) beats Apr 10; Dec 31 is undone → excluded.
    expect(date).toBe("2026-05-20");
  });

  it("a foreign user cannot see another user's entity history (returns null)", async () => {
    hoisted.testClient = userB.client;
    const date = await loadLastChangeDate(entityId);
    expect(date).toBeNull();
  });

  it("returns null for an entity with no rows", async () => {
    hoisted.testClient = userA.client;
    const date = await loadLastChangeDate(randomUUID());
    expect(date).toBeNull();
  });
});
