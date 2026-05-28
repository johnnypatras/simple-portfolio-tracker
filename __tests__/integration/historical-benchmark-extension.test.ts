import { execFileSync } from "child_process";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import { getHistoricalBenchmarkExtension } from "@/lib/actions/benchmark";

/**
 * Integration tests for getHistoricalBenchmarkExtension (Phase 2, Task 3).
 *
 * Verifies that:
 *   1. A backdated is_adjustment lot with cached historical_prices produces a
 *      non-null earliestDate and a synthetic benchmark cash flow.
 *   2. A user with no positions returns { earliestDate: null, syntheticCashFlows: [] }.
 */
describe("getHistoricalBenchmarkExtension (Phase 2 Task 3)", () => {
  const admin = getAdminClient();

  // Patch env vars so createAdminClient() inside getHistoricalBenchmarkExtension
  // works against local Supabase (same pattern as adjustment-deltas-exclusion.test.ts).
  beforeAll(() => {
    const out = execFileSync("supabase", ["status", "--output", "json"], {
      encoding: "utf-8",
    });
    const cfg = JSON.parse(out) as { API_URL: string; SERVICE_ROLE_KEY: string };
    process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.API_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.SERVICE_ROLE_KEY;
  });

  // IDs to clean up per test — collected during seeding.
  let cleanupFns: Array<() => void> = [];
  let activityIds: string[] = [];
  let positionIds: string[] = [];
  let assetIds: string[] = [];
  let walletIds: string[] = [];
  let histPriceKeys: string[] = [];
  let histPriceFxDates: string[] = [];

  afterEach(async () => {
    // Remove activity_log rows first (FK deps).
    if (activityIds.length > 0) {
      await admin.from("activity_log").delete().in("id", activityIds);
      activityIds = [];
    }
    // Remove positions.
    if (positionIds.length > 0) {
      await admin.from("crypto_positions").delete().in("id", positionIds);
      positionIds = [];
    }
    // Remove assets.
    if (assetIds.length > 0) {
      await admin.from("crypto_assets").delete().in("id", assetIds);
      assetIds = [];
    }
    // Remove historical_prices rows by asset_key (crypto).
    for (const key of histPriceKeys) {
      await admin.from("historical_prices").delete().eq("asset_key", key);
    }
    histPriceKeys = [];
    // Remove FX historical_prices rows by date (scoped to seeded dates only).
    for (const date of histPriceFxDates) {
      await admin
        .from("historical_prices")
        .delete()
        .eq("asset_kind", "fx")
        .eq("asset_key", "EUR")
        .eq("price_date", date);
    }
    histPriceFxDates = [];
    // Remove wallets.
    if (walletIds.length > 0) {
      await admin.from("wallets").delete().in("id", walletIds);
      walletIds = [];
    }
    // Remove test users (cascades remaining data).
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  });

  it("returns earliestDate and 1 synthetic cash flow for a backdated is_adjustment lot", async () => {
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    // Create a wallet (required FK for crypto_positions).
    const { data: wallet, error: walletErr } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: "Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletErr).toBeNull();
    walletIds.push(wallet!.id);

    const suffix = crypto.randomUUID();
    const cgId = `test-bench-${suffix}`;
    const ticker = `BNCH${suffix.replace(/-/g, "").slice(0, 8)}`;

    // Create crypto asset.
    const { data: asset, error: assetErr } = await admin
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Test Bench Coin",
        coingecko_id: cgId,
        ticker,
      })
      .select("id")
      .single();
    expect(assetErr).toBeNull();
    assetIds.push(asset!.id);

    // Create crypto position (qty 2).
    const { data: position, error: posErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: asset!.id, wallet_id: wallet!.id, quantity: 2 })
      .select("id")
      .single();
    expect(posErr).toBeNull();
    positionIds.push(position!.id);

    // Seed activity_log: backdated is_adjustment creation ~2 years ago.
    // The created_at must be AFTER effective_date so the lot is considered backdated
    // (capture_date = created_at date > effective_date). We rely on insertion
    // created_at being today; effective_date is 2023-06-01.
    const { data: log, error: logErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: position!.id,
        entity_name: "Test Bench Coin",
        description: "Backdated adjustment lot",
        effective_date: "2023-06-01",
        is_adjustment: true,
        before_snapshot: null,
        after_snapshot: { quantity: 2 },
      })
      .select("id")
      .single();
    expect(logErr).toBeNull();
    activityIds.push(log!.id);

    // Seed historical_prices for the crypto asset — asset_key MUST match coingecko_id.
    histPriceKeys.push(cgId);
    const { error: priceErr } = await admin
      .from("historical_prices")
      .upsert(
        [
          {
            asset_kind: "crypto",
            asset_key: cgId,
            price_date: "2023-06-01",
            price: 27000,
            currency: "USD",
          },
        ],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(priceErr).toBeNull();

    // Seed FX row: EUR on 2023-06-01 (USD per 1 EUR ≈ 1.08).
    histPriceFxDates.push("2023-06-01");
    const { error: fxErr } = await admin
      .from("historical_prices")
      .upsert(
        [
          {
            asset_kind: "fx",
            asset_key: "EUR",
            price_date: "2023-06-01",
            price: 1.08,
            currency: "USD",
          },
        ],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(fxErr).toBeNull();

    // Call the function under test (admin path via explicit userId).
    const result = await getHistoricalBenchmarkExtension(userId);

    // earliestDate must be the seeded effective_date.
    expect(result.earliestDate).toBe("2023-06-01");

    // Must produce exactly 1 synthetic cash flow.
    expect(result.syntheticCashFlows.length).toBe(1);

    const flow = result.syntheticCashFlows[0];
    // amount_usd = qty_delta(2) × price(27000) = 54000.
    expect(flow.amount_usd).toBeCloseTo(54000, 0);
    expect(flow.amount_usd).toBeGreaterThan(0);
    expect(flow.asset_class).toBe("crypto");
  });

  it("returns { earliestDate: null, syntheticCashFlows: [] } when user has no positions", async () => {
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    const result = await getHistoricalBenchmarkExtension(userId);

    expect(result.earliestDate).toBeNull();
    expect(result.syntheticCashFlows).toEqual([]);
  });
});
