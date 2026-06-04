import { execFileSync } from "child_process";
import { vi, describe, it, expect, beforeAll, afterEach } from "vitest";

/**
 * Integration tests for Task 3.4a-pre: widen the historical price-fetch to also
 * cover the assets of `cashflow_user_set=true` lots (the cost-basis SEED needs
 * `marketAtChartStart` for USER-COSTED lots, which are usually NON-backdated
 * normal buys — so #94 caches no price for them today).
 *
 * Three contracts (all from the 4 audit rounds):
 *   (i)   A NON-backdated user-costed lot → its asset's prices are fetched +
 *         cached back to the user's earliest relevant date, and appear in the
 *         returned `.prices` (even though the lot is NOT in `.lots`).
 *   (ii)  `.lots` is BYTE-IDENTICAL to a control stream WITHOUT the user-costed
 *         row — only `.prices` grows. (The value line is lot-driven; widening
 *         must NOT pull user-costed lots into the truth-line reconstruction.)
 *   (iii) An asset with PRE-EXISTING NARROWER cached coverage still gets the
 *         deeper range fetched (the coarse per-asset_key cache gate is defeated).
 *
 * Strategy mirrors crypto-actions.test.ts + historical-prices-cache.test.ts:
 *   - `vi.mock("@/lib/prices/historical")` so the external Yahoo/Frankfurter
 *     fetch is a controllable SPY (the network is down in this env). The mock
 *     returns one synthetic daily row per requested [start, end] window so we
 *     can assert WHAT range was requested and that the row reaches the cache.
 *   - The REAL admin Supabase client is used (env-patched from `supabase status`)
 *     so the cache write/read path is exercised end-to-end against local PG.
 *     We deliberately do NOT mock `@/lib/supabase/admin`.
 */

// ─── Hoisted spy state for the mocked price fetchers ─────────────────────────
const hoisted = vi.hoisted(() => ({
  // Records every (symbol|currency, startDate, endDate) the orchestrator asks for.
  yahooCalls: [] as Array<{ symbol: string; start: string; end: string }>,
  fxCalls: [] as Array<{ currency: string; start: string; end: string }>,
}));

// Mock the external fetch layer. Each fetcher returns a single synthetic daily
// price at its requested `start` (enough for the cache to persist + for the read
// path to surface). Returning a row AT `start` lets us prove the deep range was
// actually requested (test iii): a narrower prior fetch would never have a row
// at the deeper start.
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(
    async (symbol: string, start: string, end: string) => {
      hoisted.yahooCalls.push({ symbol, start, end });
      return [{ date: start, price: 12345 }];
    },
  ),
  fetchFxUsdPivotHistory: vi.fn(
    async (currency: string, start: string, end: string) => {
      hoisted.fxCalls.push({ currency, start, end });
      return [{ date: start, price: 1.1 }];
    },
  ),
}));

import { createTestUser, getAdminClient } from "./setup";
import { fetchHistoricalPriceInputsFor } from "@/lib/portfolio/historical-prices-augmentation";

const admin = getAdminClient();

describe("fetchHistoricalPriceInputsFor — user-costed price coverage (Task 3.4a-pre)", () => {
  beforeAll(() => {
    const out = execFileSync("supabase", ["status", "--output", "json"], {
      encoding: "utf-8",
    });
    const cfg = JSON.parse(out) as { API_URL: string; SERVICE_ROLE_KEY: string };
    process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.API_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.SERVICE_ROLE_KEY;
  });

  // Per-test cleanup tracking.
  let cleanupFns: Array<() => void> = [];
  let activityIds: string[] = [];
  let positionIds: string[] = [];
  let assetIds: string[] = [];
  let walletIds: string[] = [];
  let histPriceKeys: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    hoisted.yahooCalls = [];
    hoisted.fxCalls = [];
    if (activityIds.length > 0) {
      await admin.from("activity_log").delete().in("id", activityIds);
      activityIds = [];
    }
    if (positionIds.length > 0) {
      await admin.from("crypto_positions").delete().in("id", positionIds);
      positionIds = [];
    }
    if (assetIds.length > 0) {
      await admin.from("crypto_assets").delete().in("id", assetIds);
      assetIds = [];
    }
    for (const key of histPriceKeys) {
      await admin.from("historical_prices").delete().eq("asset_key", key);
    }
    histPriceKeys = [];
    if (walletIds.length > 0) {
      await admin.from("wallets").delete().in("id", walletIds);
      walletIds = [];
    }
    for (const fn of cleanupFns) fn();
    cleanupFns = [];
  });

  /** Insert a wallet + crypto asset + position; return the ids, coingecko key, and Yahoo fetch symbol. */
  async function seedAsset(userId: string, label: string) {
    const { data: wallet, error: walletErr } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: `W-${label}`, wallet_type: "custodial" })
      .select("id")
      .single();
    expect(walletErr).toBeNull();
    walletIds.push(wallet!.id);

    const suffix = crypto.randomUUID();
    const cgId = `uc-${label}-${suffix}`;
    const ticker = `UC${suffix.replace(/-/g, "").slice(0, 6)}`;
    // Mirrors the fetch_symbol derivation in fetchHistoricalPriceInputsFor (crypto).
    const fetchSymbol = `${ticker.toUpperCase()}-USD`;

    const { data: asset, error: assetErr } = await admin
      .from("crypto_assets")
      .insert({ user_id: userId, name: `Asset ${label}`, coingecko_id: cgId, ticker })
      .select("id")
      .single();
    expect(assetErr).toBeNull();
    assetIds.push(asset!.id);
    histPriceKeys.push(cgId);

    const { data: position, error: posErr } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: asset!.id, wallet_id: wallet!.id, quantity: 1 })
      .select("id")
      .single();
    expect(posErr).toBeNull();
    positionIds.push(position!.id);

    return { positionId: position!.id, cgId, fetchSymbol };
  }

  /** YYYY-MM-DD `years` years ago (UTC). */
  function yearsAgo(years: number): string {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return d.toISOString().slice(0, 10);
  }

  // ── (i) NON-backdated user-costed lot → its asset is price-covered ──────────
  it("(i) caches + returns prices for a NON-backdated user-costed lot's asset", async () => {
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    const { cgId } = await seedAsset(userId, "costed");

    // A NON-backdated buy (no effective_date → COALESCE falls back to today's
    // created_at) with cashflow_user_set=true. buildHistoricalLots DROPS this
    // (not backdated) → it is NOT a value-line lot → #94 caches no price for it.
    const { data: buy, error: buyErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Asset costed",
        description: "User-costed buy",
        is_adjustment: false,
        cashflow_user_set: true,
        cashflow_amount_usd: 50000,
        cashflow_amount_eur: 46000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    expect(buyErr).toBeNull();
    activityIds.push(buy!.id);

    // To make the orchestrator do ANY work it needs at least one backdated lot
    // (lots.length === 0 short-circuits). Seed a SEPARATE backdated lot on a
    // different asset so the orchestrator proceeds and the costed asset rides
    // the widening (not the value-line path).
    const { cgId: backCg } = await seedAsset(userId, "backdated");
    const backStart = yearsAgo(2);
    const { data: backBuy, error: backErr } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Asset backdated",
        description: "Backdated buy",
        effective_date: backStart,
        is_adjustment: false,
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    expect(backErr).toBeNull();
    activityIds.push(backBuy!.id);

    const { lots, prices } = await fetchHistoricalPriceInputsFor(admin, userId);

    // The user-costed asset is NOT a value-line lot.
    expect(lots.some((l) => l.asset_key === cgId)).toBe(false);
    // The backdated asset IS a value-line lot.
    expect(lots.some((l) => l.asset_key === backCg)).toBe(true);

    // The COSTED asset's prices landed in the RETURNED index (widened .prices),
    // even though it is NOT a value-line lot.
    expect(prices.some((p) => p.asset_key === cgId)).toBe(true);
    // The row was actually cached in historical_prices, and the coverage reached
    // back to the user's earliest relevant date (~the backdated lot's start, the
    // All-period start) — the mock returns a row AT the requested start, so an
    // at-or-before-backStart row proves the deep range was fetched, not just today.
    const { data: cached } = await admin
      .from("historical_prices")
      .select("asset_key, price_date")
      .eq("asset_key", cgId)
      .order("price_date", { ascending: true });
    expect((cached ?? []).length).toBeGreaterThan(0);
    expect(cached![0].price_date <= backStart).toBe(true);
  });

  // ── (ii) BYTE-IDENTITY: `.lots` unchanged by the widening ───────────────────
  it("(ii) .lots is byte-identical with vs without the user-costed row (only .prices grows)", async () => {
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    // Control: a single backdated lot, NO user-costed row.
    const { cgId: backCg } = await seedAsset(userId, "ctrlback");
    const backStart = yearsAgo(2);
    const { data: backBuy } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Ctrl backdated",
        description: "Backdated buy",
        effective_date: backStart,
        is_adjustment: false,
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    activityIds.push(backBuy!.id);

    const control = await fetchHistoricalPriceInputsFor(admin, userId);

    // Now ADD a NON-backdated user-costed row on a different asset.
    const { cgId: costedCg } = await seedAsset(userId, "ctrlcosted");
    const { data: costedBuy } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Ctrl costed",
        description: "User-costed buy",
        is_adjustment: false,
        cashflow_user_set: true,
        cashflow_amount_usd: 50000,
        cashflow_amount_eur: 46000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    activityIds.push(costedBuy!.id);

    const widened = await fetchHistoricalPriceInputsFor(admin, userId);

    // BYTE-IDENTITY: the value-line lots are exactly the control's lots — the
    // user-costed row added ZERO lots (only the backdated lot, exactly as before).
    expect(widened.lots).toEqual(control.lots);
    expect(widened.lots.every((l) => l.asset_key === backCg)).toBe(true);

    // Only `.prices` grew: the costed asset's prices appear ONLY in the widened set.
    expect(control.prices.some((p) => p.asset_key === costedCg)).toBe(false);
    expect(widened.prices.some((p) => p.asset_key === costedCg)).toBe(true);
  });

  // ── (iii) Pre-existing NARROWER coverage still triggers the deeper fetch ─────
  it("(iii) re-fetches the deeper range when prior cached coverage starts later than needed", async () => {
    const { userId, cleanup } = await createTestUser();
    cleanupFns.push(cleanup);

    const { cgId, fetchSymbol: narrowFetchSymbol } = await seedAsset(userId, "narrow");

    // Pre-seed NARROW coverage: a single recent row (1 month ago). The needed
    // start (the user's earliest relevant date below) is ~3 years ago — strictly
    // EARLIER than this cached row. The coarse per-asset_key gate would see the
    // key "already cached" and skip → null prices at the deep start (silent gap).
    const narrowStart = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    const { error: seedErr } = await admin
      .from("historical_prices")
      .upsert(
        [{ asset_kind: "crypto", asset_key: cgId, price_date: narrowStart, price: 999, currency: "USD" }],
        { onConflict: "asset_kind,asset_key,price_date", ignoreDuplicates: true },
      );
    expect(seedErr).toBeNull();

    // A NON-backdated user-costed buy on this same narrow asset.
    const { data: buy } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Asset narrow",
        description: "User-costed buy",
        is_adjustment: false,
        cashflow_user_set: true,
        cashflow_amount_usd: 50000,
        cashflow_amount_eur: 46000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    activityIds.push(buy!.id);

    // A separate backdated lot ~3 years ago so (a) the orchestrator proceeds and
    // (b) the user's earliest relevant date is ~3y ago (well before narrowStart).
    await seedAsset(userId, "narrowback");
    const deepStart = yearsAgo(3);
    const { data: backBuy } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionIdsLast(),
        entity_name: "Asset narrowback",
        description: "Backdated buy",
        effective_date: deepStart,
        is_adjustment: false,
        before_snapshot: null,
        after_snapshot: { quantity: 1 },
      })
      .select("id")
      .single();
    activityIds.push(backBuy!.id);

    await fetchHistoricalPriceInputsFor(admin, userId);

    // GATE DEFEAT: despite the narrow pre-existing coverage, the deep range was
    // fetched for the narrow asset — the spy saw a fetch scoped to THIS asset's
    // symbol whose start is at/near the deep start (well before narrowStart).
    // Symbol-scoped so a coincidentally-deep fetch on the other fixture can't match.
    const narrowAssetFetch = hoisted.yahooCalls.find(
      (c) => c.symbol === narrowFetchSymbol && (c.start <= deepStart || c.start < narrowStart),
    );
    expect(narrowAssetFetch).toBeDefined();

    // And the deeper row is now cached (price_date earlier than the narrow seed).
    const { data: cached } = await admin
      .from("historical_prices")
      .select("price_date")
      .eq("asset_key", cgId)
      .order("price_date", { ascending: true });
    expect((cached ?? []).length).toBeGreaterThan(0);
    expect(cached![0].price_date < narrowStart).toBe(true);
  });

  // Helper: the most-recently-pushed positionId (seedAsset pushes onto the array).
  function positionIdsLast(): string {
    return positionIds[positionIds.length - 1];
  }
});
