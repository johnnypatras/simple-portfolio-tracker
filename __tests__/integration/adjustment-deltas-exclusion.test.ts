import { execFileSync } from "child_process";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import { getAdjustmentDeltas } from "@/lib/actions/activity-log";

/**
 * Integration tests for getAdjustmentDeltas back-fill exclusion of
 * historically-priced lots (Task 7).
 *
 * When a crypto or stock position's asset has cached rows in `historical_prices`,
 * its is_adjustment activity_log entries must be excluded from the flat back-fill
 * `value + (finalCumDelta - cumDelta)` — those lots are valued by
 * augmentAndExtendSnapshots (qty × historical-price) and including them in the
 * back-fill would double-count.
 *
 * The predicate is "asset has cached historical_prices". Consistent with the
 * augmentation gate in getSnapshots: both key off the same condition.
 */
describe("getAdjustmentDeltas — historical-price back-fill exclusion (Task 7)", () => {
  const admin = getAdminClient();

  // Patch env vars so createAdminClient() inside getAdjustmentDeltas works
  // against local Supabase (same pattern as historical-prices-cache.test.ts).
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
  let cashAccountIds: string[] = [];

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
    // Remove cash accounts.
    if (cashAccountIds.length > 0) {
      await admin.from("cash_accounts").delete().in("id", cashAccountIds);
      cashAccountIds = [];
    }
    // Remove assets.
    if (assetIds.length > 0) {
      await admin.from("crypto_assets").delete().in("id", assetIds);
      assetIds = [];
    }
    // Remove historical_prices rows.
    for (const key of histPriceKeys) {
      await admin.from("historical_prices").delete().eq("asset_key", key);
    }
    histPriceKeys = [];
    // Remove wallets.
    if (walletIds.length > 0) {
      await admin.from("wallets").delete().in("id", walletIds);
      walletIds = [];
    }
    // Remove test users (cascades remaining data).
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  });

  it("excludes crypto lots with cached historical_prices; retains lots without", async () => {
    // Create a test user.
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

    // --- Asset A: ethereum-like — HAS cached historical_prices ---
    const cgIdA = `test-ethereum-excl-${suffix}`;
    const { data: assetA, error: assetAErr } = await admin
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Test Ethereum",
        coingecko_id: cgIdA,
        ticker: `ETH${suffix}`,
      })
      .select("id")
      .single();
    expect(assetAErr).toBeNull();
    assetIds.push(assetA!.id);

    const { data: posA, error: posAErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: assetA!.id, wallet_id: wallet!.id, quantity: 1 })
      .select("id")
      .single();
    expect(posAErr).toBeNull();
    positionIds.push(posA!.id);

    // Backdated is_adjustment entry with delta_usd = 500 for asset A.
    const { data: logA, error: logAErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: posA!.id,
        entity_name: "Test Ethereum",
        description: "Backdated adjustment",
        effective_date: "2024-01-15",
        is_adjustment: true,
        delta_usd: 500,
        delta_eur: 460,
      })
      .select("id")
      .single();
    expect(logAErr).toBeNull();
    activityIds.push(logA!.id);

    // Seed historical_prices for asset A (ethereum) → marks it as covered.
    histPriceKeys.push(cgIdA);
    const { error: priceAErr } = await admin
      .from("historical_prices")
      .upsert(
        [
          {
            asset_kind: "crypto",
            asset_key: cgIdA,
            price_date: "2024-01-15",
            price: 2000,
            currency: "USD",
          },
        ],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(priceAErr).toBeNull();

    // --- Asset B: dogecoin-like — NO cached historical_prices ---
    const cgIdB = `test-dogecoin-retain-${suffix}`;
    const { data: assetB, error: assetBErr } = await admin
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Test Dogecoin",
        coingecko_id: cgIdB,
        ticker: `DOGE${suffix}`,
      })
      .select("id")
      .single();
    expect(assetBErr).toBeNull();
    assetIds.push(assetB!.id);

    const { data: posB, error: posBErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: assetB!.id, wallet_id: wallet!.id, quantity: 1000 })
      .select("id")
      .single();
    expect(posBErr).toBeNull();
    positionIds.push(posB!.id);

    // Backdated is_adjustment entry with delta_usd = 200 for asset B.
    const { data: logB, error: logBErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: posB!.id,
        entity_name: "Test Dogecoin",
        description: "Backdated adjustment",
        effective_date: "2024-02-10",
        is_adjustment: true,
        delta_usd: 200,
        delta_eur: 185,
      })
      .select("id")
      .single();
    expect(logBErr).toBeNull();
    activityIds.push(logB!.id);
    // NOTE: No historical_prices rows seeded for cgIdB — stays on back-fill.

    // Call getAdjustmentDeltas via admin path (userId param).
    const deltas = await getAdjustmentDeltas(userId);

    // Asset B (dogecoin, no cached prices) must appear in the cumulative total.
    // Asset A (ethereum, cached prices) must NOT contribute.
    //
    // The final cumulative_usd across all dates must equal only the dogecoin
    // delta (200), not 500 (ethereum) or 700 (both).
    const maxCumulativeUsd = Math.max(...deltas.map((d) => d.cumulative_usd));
    expect(maxCumulativeUsd).toBe(200);

    // Also verify that the dogecoin entry date is present.
    const dogecoinEntry = deltas.find((d) => d.date === "2024-02-10");
    expect(dogecoinEntry).toBeDefined();
    expect(dogecoinEntry!.cumulative_usd).toBe(200);

    // The ethereum entry date must either be absent or show 0 cumulative_usd
    // (excluded entirely from the back-fill).
    const ethereumEntry = deltas.find((d) => d.date === "2024-01-15");
    // Either the date is absent (ideal) or it has cumulative_usd = 0 (no contribution).
    if (ethereumEntry !== undefined) {
      expect(ethereumEntry.cumulative_usd).toBe(0);
    }
  });

  it("cross-wallet same-asset: excludes backdated wallet but retains today-dated wallet", async () => {
    // Reviewer's edge case: same crypto_asset in two wallets.
    //   Wallet A, position A: BACKDATED is_adjustment → asset cached → excluded.
    //   Wallet B, position B: TODAY-dated is_adjustment → same asset_key cached,
    //     but NOT backdated → NOT augmented by buildHistoricalLots → must NOT be
    //     excluded from back-fill (old coarse gate would exclude it; lot-level
    //     gate correctly retains it).
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    const suffix = crypto.randomUUID();

    // Two wallets for the same user.
    const { data: walletA, error: walletAErr } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: "Wallet A", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletAErr).toBeNull();
    walletIds.push(walletA!.id);

    const { data: walletB, error: walletBErr } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: "Wallet B", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletBErr).toBeNull();
    walletIds.push(walletB!.id);

    // One shared crypto_asset for both wallets.
    const cgIdShared = `test-cross-${suffix}`;
    const { data: sharedAsset, error: sharedAssetErr } = await admin
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Test Cross Wallet",
        coingecko_id: cgIdShared,
        ticker: `XW${suffix}`,
      })
      .select("id")
      .single();
    expect(sharedAssetErr).toBeNull();
    assetIds.push(sharedAsset!.id);

    // Position A in wallet A.
    const { data: posA, error: posAErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: sharedAsset!.id, wallet_id: walletA!.id, quantity: 1 })
      .select("id")
      .single();
    expect(posAErr).toBeNull();
    positionIds.push(posA!.id);

    // Position B in wallet B.
    const { data: posB, error: posBErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: sharedAsset!.id, wallet_id: walletB!.id, quantity: 1 })
      .select("id")
      .single();
    expect(posBErr).toBeNull();
    positionIds.push(posB!.id);

    const today = new Date().toISOString().slice(0, 10);

    // Position A: BACKDATED activity (effective ~2 years ago, created today).
    // effective_date (2024-01-15) < created_at (today) → backdated → excluded.
    const { data: logA, error: logAErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: posA!.id,
        entity_name: "Test Cross Wallet",
        description: "Backdated adjustment wallet A",
        effective_date: "2024-01-15",
        is_adjustment: true,
        delta_usd: 500,
        delta_eur: 460,
      })
      .select("id")
      .single();
    expect(logAErr).toBeNull();
    activityIds.push(logA!.id);

    // Position B: TODAY-dated activity (effective = today, created today).
    // effective_date (today) >= created_at (today) → NOT backdated → NOT excluded.
    const { data: logB, error: logBErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: posB!.id,
        entity_name: "Test Cross Wallet",
        description: "Today adjustment wallet B",
        effective_date: today,
        is_adjustment: true,
        delta_usd: 700,
        delta_eur: 640,
      })
      .select("id")
      .single();
    expect(logBErr).toBeNull();
    activityIds.push(logB!.id);

    // Seed historical_prices for the shared coingecko_id → marks the asset as covered.
    histPriceKeys.push(cgIdShared);
    const { error: priceErr } = await admin
      .from("historical_prices")
      .upsert(
        [
          {
            asset_kind: "crypto",
            asset_key: cgIdShared,
            price_date: "2024-01-15",
            price: 42000,
            currency: "USD",
          },
        ],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(priceErr).toBeNull();

    const deltas = await getAdjustmentDeltas(userId);

    // Position A (backdated, $500) must be EXCLUDED (handled by augmentation).
    // Position B (today-dated, $700) must be RETAINED in the back-fill.
    // Final maxCumulativeUsd = 700 (only position B contributes).
    const maxCumulativeUsd =
      deltas.length > 0 ? Math.max(...deltas.map((d) => d.cumulative_usd)) : 0;
    expect(maxCumulativeUsd).toBe(700);

    // Position B entry must appear on today's date.
    const todayEntry = deltas.find((d) => d.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.cumulative_usd).toBe(700);
  });

  it("excludes a soft-deleted (sold) crypto position if its asset has cached prices", async () => {
    // A position with deleted_at set (fully sold) whose asset has historical_prices
    // is still reconstructed by synthesis — it must also be excluded from back-fill.
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    const { data: wallet, error: walletErr } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: "Test Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletErr).toBeNull();
    walletIds.push(wallet!.id);

    const suffix = crypto.randomUUID();
    const cgIdSold = `test-sold-excl-${suffix}`;

    const { data: assetSold, error: assetSoldErr } = await admin
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Test Sold Coin",
        coingecko_id: cgIdSold,
        ticker: `SOLD${suffix}`,
      })
      .select("id")
      .single();
    expect(assetSoldErr).toBeNull();
    assetIds.push(assetSold!.id);

    // Position is soft-deleted (quantity=0, deleted_at set).
    const { data: posSold, error: posSoldErr } = await admin
      .from("crypto_positions")
      .insert({
        crypto_asset_id: assetSold!.id,
        wallet_id: wallet!.id,
        quantity: 0,
        deleted_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(posSoldErr).toBeNull();
    positionIds.push(posSold!.id);

    // Backdated is_adjustment entry for the sold position.
    const { data: logSold, error: logSoldErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: posSold!.id,
        entity_name: "Test Sold Coin",
        description: "Backdated adjustment on sold position",
        effective_date: "2023-06-01",
        is_adjustment: true,
        delta_usd: 300,
        delta_eur: 275,
      })
      .select("id")
      .single();
    expect(logSoldErr).toBeNull();
    activityIds.push(logSold!.id);

    // Seed historical_prices — triggers exclusion even for the deleted position.
    histPriceKeys.push(cgIdSold);
    const { error: priceErr } = await admin
      .from("historical_prices")
      .upsert(
        [
          {
            asset_kind: "crypto",
            asset_key: cgIdSold,
            price_date: "2023-06-01",
            price: 1.5,
            currency: "USD",
          },
        ],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(priceErr).toBeNull();

    const deltas = await getAdjustmentDeltas(userId);

    // The sold/deleted position's adjustment must be excluded (historical prices present).
    // cumulative_usd must be 0 (no retained entries).
    const maxCumulativeUsd =
      deltas.length > 0 ? Math.max(...deltas.map((d) => d.cumulative_usd)) : 0;
    expect(maxCumulativeUsd).toBe(0);
  });

  it("CASH: excludes a backdated cash_account from back-fill (augmented by face value); retains today-dated", async () => {
    // Cash augmentation (Phase 1 extension): a backdated is_adjustment cash
    // entry is now contributed to past snapshots by augmentAndExtendSnapshots
    // as face_value × FX. Including its delta_usd in the back-fill would
    // double-count. A NON-backdated (today-dated) cash adjustment stays on
    // the back-fill — same lot-level granularity as crypto/stock.
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    // Cash account A: BACKDATED adjustment (~2 years ago, created today).
    // effective_date < created_at → backdated → excluded from back-fill.
    const { data: cashA, error: cashAErr } = await admin
      .from("cash_accounts")
      .insert({
        user_id: userId,
        currency: "EUR",
        balance: 1000,
        name: `Backdated Cash ${crypto.randomUUID()}`,
      })
      .select("id")
      .single();
    expect(cashAErr).toBeNull();
    cashAccountIds.push(cashA!.id);

    const { data: logBackdated, error: logBackdatedErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "cash_account",
        entity_id: cashA!.id,
        entity_table: "cash_accounts",
        entity_name: "Backdated Cash",
        description: "Backdated cash adjustment",
        effective_date: "2024-01-15",
        is_adjustment: true,
        after_snapshot: { balance: 1000, currency: "EUR" },
        delta_usd: 1080, // 1000 EUR × ~1.08 USD/EUR
        delta_eur: 1000,
      })
      .select("id")
      .single();
    expect(logBackdatedErr).toBeNull();
    activityIds.push(logBackdated!.id);

    // Cash account B: TODAY-dated adjustment.
    // effective_date == created_at::date → NOT backdated → stays on back-fill.
    const today = new Date().toISOString().slice(0, 10);
    const { data: cashB, error: cashBErr } = await admin
      .from("cash_accounts")
      .insert({
        user_id: userId,
        currency: "EUR",
        balance: 500,
        name: `Today Cash ${crypto.randomUUID()}`,
      })
      .select("id")
      .single();
    expect(cashBErr).toBeNull();
    cashAccountIds.push(cashB!.id);

    const { data: logToday, error: logTodayErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "cash_account",
        entity_id: cashB!.id,
        entity_table: "cash_accounts",
        entity_name: "Today Cash",
        description: "Today cash adjustment",
        effective_date: today,
        is_adjustment: true,
        after_snapshot: { balance: 500, currency: "EUR" },
        delta_usd: 540, // 500 EUR × ~1.08 USD/EUR
        delta_eur: 500,
      })
      .select("id")
      .single();
    expect(logTodayErr).toBeNull();
    activityIds.push(logToday!.id);

    const deltas = await getAdjustmentDeltas(userId);

    // Backdated cash A ($1080) is augmented → must NOT appear in back-fill.
    // Today-dated cash B ($540) is NOT augmented → must STAY in back-fill.
    // Final maxCumulativeUsd = 540 (only B contributes).
    const maxCumulativeUsd =
      deltas.length > 0 ? Math.max(...deltas.map((d) => d.cumulative_usd)) : 0;
    expect(maxCumulativeUsd).toBe(540);

    // Today's entry must be present with cash B's delta.
    const todayEntry = deltas.find((d) => d.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.cumulative_usd).toBe(540);

    // The backdated 2024-01-15 entry must either be absent (ideal — it was
    // skipped entirely) or have cumulative_usd 0 (no contribution).
    const backdatedEntry = deltas.find((d) => d.date === "2024-01-15");
    if (backdatedEntry !== undefined) {
      expect(backdatedEntry.cumulative_usd).toBe(0);
    }
  });
});
