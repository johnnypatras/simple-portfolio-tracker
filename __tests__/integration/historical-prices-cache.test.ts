import { execFileSync } from "child_process";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import { fetchHistoricalPriceInputsFor } from "@/lib/portfolio/historical-prices-augmentation";

/**
 * Integration tests for migration 020: historical_prices cache table.
 *
 * Verifies:
 *   - Upsert idempotency: two upserts of the same (asset_kind, asset_key,
 *     price_date) with ignoreDuplicates=true → exactly one row, first write wins.
 *   - RLS write-blocked: an authenticated active user CAN select rows but
 *     CANNOT insert (no write policy on authenticated role → PostgREST error).
 *   - anon blocked: the anon client cannot read rows (REVOKE ALL from anon).
 */

const TEST_ASSET_KEY = `test-btc-${Date.now()}`;

describe("historical_prices cache — migration 020 (integration)", () => {
  const admin = getAdminClient();

  afterEach(async () => {
    // Clean up any rows written by this test run so tests are isolated.
    await admin
      .from("historical_prices")
      .delete()
      .eq("asset_key", TEST_ASSET_KEY);
  });

  it("upsert idempotency: two writes of the same (asset_kind, asset_key, price_date) → exactly one row, first write wins", async () => {
    const row = {
      asset_kind: "crypto",
      asset_key: TEST_ASSET_KEY,
      price_date: "2021-01-01",
      price: 29000,
      currency: "USD",
    };

    // First upsert — inserts the row.
    const { error: err1 } = await admin
      .from("historical_prices")
      .upsert([row], {
        onConflict: "asset_kind,asset_key,price_date",
        ignoreDuplicates: true,
      });
    expect(err1).toBeNull();

    // Second upsert — same composite key, different price. ignoreDuplicates=true
    // means ON CONFLICT DO NOTHING: the original row must survive unchanged.
    const { error: err2 } = await admin
      .from("historical_prices")
      .upsert([{ ...row, price: 99999 }], {
        onConflict: "asset_kind,asset_key,price_date",
        ignoreDuplicates: true,
      });
    expect(err2).toBeNull();

    // Exactly one row should exist.
    const { data, error: readErr } = await admin
      .from("historical_prices")
      .select("price")
      .eq("asset_kind", "crypto")
      .eq("asset_key", TEST_ASSET_KEY)
      .eq("price_date", "2021-01-01");

    expect(readErr).toBeNull();
    expect(data).toHaveLength(1);
    // First write wins — price must be 29000, not 99999.
    expect(Number(data![0].price)).toBe(29000);
  });

  it("RLS: authenticated active user can SELECT but cannot INSERT (no write policy)", async () => {
    // Seed a row via admin so there's something to read.
    await admin.from("historical_prices").upsert(
      [
        {
          asset_kind: "crypto",
          asset_key: TEST_ASSET_KEY,
          price_date: "2021-01-02",
          price: 30000,
          currency: "USD",
        },
      ],
      { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
    );

    // Create an authenticated active user.
    const { client: userClient, cleanup } = await createTestUser();

    try {
      // Authenticated user CAN select.
      const { data, error: selErr } = await userClient
        .from("historical_prices")
        .select("asset_kind, asset_key, price_date, price")
        .eq("asset_key", TEST_ASSET_KEY);

      expect(selErr).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBeGreaterThan(0);

      // Authenticated user CANNOT insert (RLS: no write policy for authenticated).
      const { error: insErr } = await userClient
        .from("historical_prices")
        .insert({
          asset_kind: "crypto",
          asset_key: TEST_ASSET_KEY,
          price_date: "2021-01-03",
          price: 31000,
          currency: "USD",
        });

      // PostgREST returns 403 or a "permission denied" / "new row violates" error
      // when authenticated has no INSERT policy.
      expect(insErr).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("anon blocked: the anon client cannot read rows (REVOKE ALL from anon)", async () => {
    // Seed a row via admin.
    await admin.from("historical_prices").upsert(
      [
        {
          asset_kind: "crypto",
          asset_key: TEST_ASSET_KEY,
          price_date: "2021-01-04",
          price: 32000,
          currency: "USD",
        },
      ],
      { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
    );

    // Build an unauthenticated (anon) client using the same local config.
    // getAdminClient() uses service_role; we need the anon key instead.
    // We spin up a fresh user client but immediately sign out to strip the
    // session — this leaves it operating as the anon role.
    const { client: anonClient, cleanup } = await createTestUser();
    await anonClient.auth.signOut();

    try {
      const { data, error } = await anonClient
        .from("historical_prices")
        .select("asset_key")
        .eq("asset_key", TEST_ASSET_KEY);

      // REVOKE ALL from anon → PostgREST returns permission error or empty.
      // Either way the anon client must NOT see the row.
      if (error) {
        // Permission denied / 403 is the expected path.
        expect(error).not.toBeNull();
      } else {
        // Some local setups return empty rows rather than an error.
        expect(data ?? []).toHaveLength(0);
      }
    } finally {
      cleanup();
    }
  });
});

/**
 * End-to-end test for fetchHistoricalPriceInputsFor (FIX 1 + FIX 2 regression guard).
 *
 * Seeds a SOFT-DELETED (fully sold) crypto position with two activity_log rows
 * (backdated buy + sell) and pre-populates historical_prices so the network is
 * never hit. Asserts that the deleted position still appears in `lots` and that
 * its deltas contain both the +2 buy and the -2 sell.
 *
 * ensureHistoricalPricesCached calls createAdminClient() internally (reads
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). We patch those env
 * vars from the local supabase status before calling the orchestrator.
 */
describe("fetchHistoricalPriceInputsFor — sold/deleted position not dropped (FIX 1)", () => {
  const admin = getAdminClient();

  // Patch env vars so createAdminClient() inside ensureHistoricalPricesCached
  // can construct a client against local Supabase.
  beforeAll(() => {
    const out = execFileSync("supabase", ["status", "--output", "json"], { encoding: "utf-8" });
    const cfg = JSON.parse(out) as { API_URL: string; SERVICE_ROLE_KEY: string };
    process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.API_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.SERVICE_ROLE_KEY;
  });

  let cleanup: (() => void) | null = null;
  let testUserId: string | null = null;

  // IDs seeded by the test — collected so afterEach can remove them precisely.
  let walletId: string | null = null;
  let assetId: string | null = null;
  let positionId: string | null = null;
  const activityIds: string[] = [];
  const priceKeys: string[] = [];

  afterEach(async () => {
    // Remove activity_log rows first (FK dependency on positions/assets).
    if (activityIds.length > 0) {
      await admin.from("activity_log").delete().in("id", activityIds);
      activityIds.length = 0;
    }
    // Remove position + asset.
    if (positionId) {
      await admin.from("crypto_positions").delete().eq("id", positionId);
      positionId = null;
    }
    if (assetId) {
      await admin.from("crypto_assets").delete().eq("id", assetId);
      assetId = null;
    }
    // Remove historical_prices rows seeded for this test run.
    for (const key of priceKeys) {
      await admin.from("historical_prices").delete().eq("asset_key", key);
    }
    priceKeys.length = 0;
    // Remove wallet.
    if (walletId) {
      await admin.from("wallets").delete().eq("id", walletId);
      walletId = null;
    }
    // Remove test user (cascades remaining data).
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    testUserId = null;
  });

  it("soft-deleted (sold) position still appears in lots, deltas contain buy + sell", async () => {
    // Create a test user.
    const setup = await createTestUser();
    cleanup = setup.cleanup;
    testUserId = setup.userId;

    // Create a wallet for the user (required FK for crypto_positions).
    const { data: walletData, error: walletErr } = await admin
      .from("wallets")
      .insert({ user_id: testUserId, name: "Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletErr).toBeNull();
    walletId = walletData!.id;

    // Use a unique coingecko_id / ticker to avoid collisions with other test runs.
    const uniqueSuffix = Date.now();
    const coingeckoId = `test-bitcoin-sold-${uniqueSuffix}`;
    const ticker = `TBTC${uniqueSuffix}`;

    // Create a crypto_asset.
    const { data: assetData, error: assetErr } = await admin
      .from("crypto_assets")
      .insert({ user_id: testUserId, name: "Test Bitcoin Sold", coingecko_id: coingeckoId, ticker })
      .select("id")
      .single();
    expect(assetErr).toBeNull();
    assetId = assetData!.id;

    // Create a crypto_position that is SOFT-DELETED (simulates a full sell).
    const { data: posData, error: posErr } = await admin
      .from("crypto_positions")
      .insert({
        crypto_asset_id: assetId,
        wallet_id: walletId,
        quantity: 0,
        deleted_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(posErr).toBeNull();
    positionId = posData!.id;

    // Backdated buy: 2 years ago, captured today.
    const buyDate = new Date();
    buyDate.setUTCFullYear(buyDate.getUTCFullYear() - 2);
    const buyEffectiveDate = buyDate.toISOString().slice(0, 10);
    // Sell: 1 year ago.
    const sellDate = new Date();
    sellDate.setUTCFullYear(sellDate.getUTCFullYear() - 1);
    const sellEffectiveDate = sellDate.toISOString().slice(0, 10);

    // Insert buy activity_log row (backdated).
    const { data: buyLog, error: buyErr } = await admin
      .from("activity_log")
      .insert({
        user_id: testUserId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionId,
        entity_name: "Test Bitcoin Sold",
        description: "Bought 2 BTC",
        effective_date: buyEffectiveDate,
        before_snapshot: null,
        after_snapshot: { quantity: 2 },
        is_adjustment: false,
      })
      .select("id")
      .single();
    expect(buyErr).toBeNull();
    activityIds.push(buyLog!.id);

    // Insert sell activity_log row.
    const { data: sellLog, error: sellErr } = await admin
      .from("activity_log")
      .insert({
        user_id: testUserId,
        action: "removed",
        entity_type: "crypto_position",
        entity_id: positionId,
        entity_name: "Test Bitcoin Sold",
        description: "Sold 2 BTC",
        effective_date: sellEffectiveDate,
        before_snapshot: { quantity: 2 },
        after_snapshot: { quantity: 0 },
        is_adjustment: false,
      })
      .select("id")
      .single();
    expect(sellErr).toBeNull();
    activityIds.push(sellLog!.id);

    // Pre-seed historical_prices for this asset and EUR FX so ensureHistoricalPricesCached
    // finds the asset already cached and skips live network calls.
    const fetchSymbol = `${ticker.toUpperCase()}-USD`;
    priceKeys.push(coingeckoId, "EUR");

    const priceRows = [
      // Crypto price rows covering the holding period.
      { asset_kind: "crypto", asset_key: coingeckoId, price_date: buyEffectiveDate, price: 30000, currency: "USD" },
      { asset_kind: "crypto", asset_key: coingeckoId, price_date: sellEffectiveDate, price: 45000, currency: "USD" },
      // FX rows for EUR.
      { asset_kind: "fx", asset_key: "EUR", price_date: buyEffectiveDate, price: 1.2, currency: "USD" },
      { asset_kind: "fx", asset_key: "EUR", price_date: sellEffectiveDate, price: 1.1, currency: "USD" },
    ];
    const { error: priceErr } = await admin
      .from("historical_prices")
      .upsert(priceRows, { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true });
    expect(priceErr).toBeNull();

    // Invoke the orchestrator using the admin client scoped to testUserId.
    // This mirrors the cross-user (share/comparison) call pattern.
    const { lots } = await fetchHistoricalPriceInputsFor(admin, testUserId);

    // FIX 1: the sold/deleted position must still appear in lots (not dropped by deleted_at).
    const soldLot = lots.find((l) => l.asset_key === coingeckoId);
    expect(soldLot).toBeDefined();

    // FIX 1: its deltas must contain both the +2 buy and the -2 sell.
    expect(soldLot!.deltas).toHaveLength(2);
    const buyDelta = soldLot!.deltas.find((d) => d.effective_date === buyEffectiveDate);
    const sellDelta = soldLot!.deltas.find((d) => d.effective_date === sellEffectiveDate);
    expect(buyDelta).toEqual({ effective_date: buyEffectiveDate, qty_delta: 2 });
    expect(sellDelta).toEqual({ effective_date: sellEffectiveDate, qty_delta: -2 });

    // Sanity: the fetch_symbol must be derived from the ticker.
    expect(soldLot!.fetch_symbol).toBe(fetchSymbol);
  });
});
