import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, getAdminClient } from "./setup";

/**
 * Integration tests for Task 4.1 — split legs carry a per-leg cost (DCA) +
 * a parent-derived `details.split_direction`.
 *
 * Two layers in one file:
 *   (A) The real `splitActivityEntry` / `unsplitActivityEntry` server actions,
 *       exercised against local Supabase with `createServerSupabaseClient` +
 *       price/FX modules mocked (the transactions.test.ts strategy).
 *   (B) #94 augmentation BYTE-IDENTITY: a legacy-shape split child (no
 *       split_direction) must reconstruct the SAME signed lot delta as a
 *       new-shape child, via the real `fetchHistoricalPriceInputsFor`.
 *
 * Requires local Supabase running (supabase start).
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

// Fixed FX mock: EUR/USD = 1.10 (1 EUR = 1.10 USD), USD/EUR = 0.9091.
// splitActivityEntry → toUsdAndEur → getFXRates uses this to derive the
// cross-currency cost leg.
vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (_base: string, targets: string[]) => {
    const rates: Record<string, number> = {};
    for (const t of targets) {
      if (t === "USD") rates.USD = 1.1;
      else if (t === "EUR") rates.EUR = 0.9091;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.1, EUR: 1 })),
}));

// The augmentation's external price fetchers (Yahoo/Frankfurter) — the network
// is down in this env, so return one synthetic daily row per requested window.
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(async (_symbol: string, start: string) => [
    { date: start, price: 30000 },
  ]),
  fetchFxUsdPivotHistory: vi.fn(async (_currency: string, start: string) => [
    { date: start, price: 1.1 },
  ]),
}));

// ─── Imports after mocks ─────────────────────────────────────
import { splitActivityEntry, unsplitActivityEntry } from "@/lib/actions/splits";
import { fetchHistoricalPriceInputsFor } from "@/lib/portfolio/historical-prices-augmentation";

const admin = getAdminClient();

// ─── (A) splitActivityEntry — per-leg cost + split_direction ─────────────────
describe("splitActivityEntry — per-leg cost + split_direction (Task 4.1)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let walletId: string;
  let cryptoAssetId: string;
  let positionId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error: wErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "DCA Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (wErr) throw new Error("wallet: " + wErr.message);
    walletId = wallet!.id;

    const { data: asset, error: aErr } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Bitcoin DCA",
        ticker: "BTC",
        coingecko_id: `btc-dca-${randomUUID()}`,
      })
      .select("id")
      .single();
    if (aErr) throw new Error("asset: " + aErr.message);
    cryptoAssetId = asset!.id;

    const { data: pos, error: pErr } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: cryptoAssetId, wallet_id: walletId, quantity: 2 })
      .select("id")
      .single();
    if (pErr) throw new Error("position: " + pErr.message);
    positionId = pos!.id;
  });

  afterAll(() => cleanup());

  /** Insert a fresh BUY parent (created action, +qty) for `qty` units costing the dual pair. */
  async function insertBuyParent(opts: {
    qty: number;
    cashflowUsd: number;
    cashflowEur: number;
    cashflowUserSet?: boolean;
    isYield?: boolean;
  }): Promise<string> {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_id: positionId,
        entity_name: "Bitcoin DCA",
        description: `Bought ${opts.qty} BTC`,
        is_adjustment: false,
        is_yield: opts.isYield ?? false,
        cashflow_user_set: opts.cashflowUserSet ?? false,
        cashflow_amount_usd: opts.cashflowUsd,
        cashflow_amount_eur: opts.cashflowEur,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: null,
        after_snapshot: { quantity: opts.qty },
      })
      .select("id")
      .single();
    if (error) throw new Error("parent: " + error.message);
    return data!.id;
  }

  async function childrenOf(parentId: string) {
    const { data } = await admin
      .from("activity_log")
      .select(
        "details, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield, effective_date, action",
      )
      .eq("split_from_id", parentId)
      .eq("user_id", userId)
      .order("effective_date", { ascending: true });
    return data ?? [];
  }

  it("splits 2 BTC €40k into 4k/8k/28k legs → each child carries the entered EUR cost, user_set, +1 direction", async () => {
    // €40,000 total cost (USD pair is incidental for this assertion).
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 44000,
      cashflowEur: 40000,
    });

    const res = await splitActivityEntry(parentId, [
      { effective_date: "2019-01-15", quantity: 0.5, cost: { amount: 4000, currency: "EUR" } },
      { effective_date: "2021-01-15", quantity: 0.5, cost: { amount: 8000, currency: "EUR" } },
      { effective_date: "2023-01-15", quantity: 1.0, cost: { amount: 28000, currency: "EUR" } },
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(parentId);
    expect(kids).toHaveLength(3);

    // Entered EUR cost stored verbatim, in effective_date order.
    expect(kids.map((k) => Number(k.cashflow_amount_eur))).toEqual([4000, 8000, 28000]);
    // USD leg derived via FX-at-date (EUR×1.10), round2.
    expect(kids.map((k) => Number(k.cashflow_amount_usd))).toEqual([4400, 8800, 30800]);
    // Every cost-bearing child is user-set.
    expect(kids.every((k) => k.cashflow_user_set === true)).toBe(true);
    // Not yield.
    expect(kids.every((k) => k.is_yield === false)).toBe(true);
    // Parent-derived direction = +1 (a BUY), split_quantity positive, sums to parent.
    expect(kids.every((k) => (k.details as { split_direction?: number }).split_direction === 1)).toBe(true);
    const sq = kids.map((k) => (k.details as { split_quantity: number }).split_quantity);
    expect(sq.every((q) => q > 0)).toBe(true);
    expect(sq.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 9);
  });

  it("splitting a SELL parent stamps split_direction = -1 on every child (split_quantity stays positive)", async () => {
    // A SELL: updated action, qty drops 2 → 0 (delta -2).
    const { data: sellParent, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: positionId,
        entity_name: "Bitcoin DCA",
        description: "Sold 2 BTC",
        is_adjustment: false,
        cashflow_user_set: false,
        cashflow_amount_usd: 60000,
        cashflow_amount_eur: 54000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: { quantity: 2 },
        after_snapshot: { quantity: 0 },
      })
      .select("id")
      .single();
    if (error) throw new Error("sell parent: " + error.message);

    const res = await splitActivityEntry(sellParent!.id, [
      { effective_date: "2024-02-01", quantity: 1.2 },
      { effective_date: "2024-03-01", quantity: 0.8 },
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(sellParent!.id);
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => (k.details as { split_direction?: number }).split_direction === -1)).toBe(true);
    expect(kids.every((k) => (k.details as { split_quantity: number }).split_quantity > 0)).toBe(true);
  });

  // THE SIGN CONTRACT for splits (see @/lib/activity-fx): a real SELL parent now
  // stores NEGATIVE cashflow amounts. The leg-cost feature IS reachable on a
  // disposal parent (the split modal only hides cost fields for yield +
  // adjustment), so the pool math must run in the MAGNITUDE domain and reapply
  // the parent's sign — children INHERIT the parent's negative direction.
  it("a NEGATIVE-cashflow SELL parent with per-leg costs → children NEGATIVE, Σ === parent (no clamp wipeout)", async () => {
    // Real disposal shape: proceeds left the portfolio → −€54,000 / −$59,400.
    // The split modal allows leg costs here (not yield, not adjustment).
    const { data: sellParent, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: positionId,
        entity_name: "Bitcoin DCA",
        description: "Sold 2 BTC (signed)",
        is_adjustment: false,
        cashflow_user_set: true,
        cashflow_amount_usd: -59400,
        cashflow_amount_eur: -54000,
        cashflow_asset_class: "crypto",
        cashflow_status: "complete",
        before_snapshot: { quantity: 2 },
        after_snapshot: { quantity: 0 },
      })
      .select("id")
      .single();
    if (error) throw new Error("signed sell parent: " + error.message);

    // Leg 1 costed €30,000 (a positive MAGNITUDE the user types); leg 2 absorbs
    // the no-cost remainder = |−54,000| − 30,000 = €24,000. Both inherit the
    // parent's −1 direction → stored NEGATIVE. Pre-fix the clamp Math.max(0,
    // −54,000 − 30,000) wiped leg 2 to 0 and leg 1 stored +30,000 (wrong sign).
    const res = await splitActivityEntry(sellParent!.id, [
      { effective_date: "2024-04-01", quantity: 1.2, cost: { amount: 30000, currency: "EUR" } },
      { effective_date: "2024-05-01", quantity: 0.8 },
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(sellParent!.id);
    expect(kids).toHaveLength(2);
    // Costed leg: −€30,000 (entered magnitude × parent sign); USD −30,000×1.10.
    expect(Number(kids[0].cashflow_amount_eur)).toBe(-30000);
    expect(Number(kids[0].cashflow_amount_usd)).toBe(-33000);
    expect(kids[0].cashflow_user_set).toBe(true);
    // No-cost leg: −€24,000 remainder (|parent| − |costed| = 54,000 − 30,000),
    // signed. USD remainder = −(59,400 − 33,000) = −26,400.
    expect(Number(kids[1].cashflow_amount_eur)).toBe(-24000);
    expect(Number(kids[1].cashflow_amount_usd)).toBe(-26400);
    // Children carry the parent's −1 direction; split_quantity stays positive.
    expect(kids.every((k) => (k.details as { split_direction?: number }).split_direction === -1)).toBe(true);
    expect(kids.every((k) => (k.details as { split_quantity: number }).split_quantity > 0)).toBe(true);
    // Σ(children) === parent in BOTH currencies (a disposal stays a disposal).
    const sumEur = kids.reduce((s, k) => s + Number(k.cashflow_amount_eur), 0);
    const sumUsd = kids.reduce((s, k) => s + Number(k.cashflow_amount_usd), 0);
    expect(sumEur).toBe(-54000);
    expect(sumUsd).toBe(-59400);
  });

  it("a yield parent's children inherit is_yield=true and an explicit leg-cost is REJECTED", async () => {
    const yieldParent = await insertBuyParent({
      qty: 2,
      cashflowUsd: 0,
      cashflowEur: 0,
      isYield: true,
    });

    // Attempting a leg-cost on a yield parent → rejected, no children created.
    const rejected = await splitActivityEntry(yieldParent, [
      { effective_date: "2022-05-01", quantity: 1, cost: { amount: 500, currency: "EUR" } },
      { effective_date: "2022-06-01", quantity: 1 },
    ]);
    expect(rejected.success).toBe(false);
    expect(rejected.message).toContain("Yield");
    expect(await childrenOf(yieldParent)).toHaveLength(0);

    // A cost-free split of the same yield parent → children stay is_yield=true.
    const ok = await splitActivityEntry(yieldParent, [
      { effective_date: "2022-05-01", quantity: 1 },
      { effective_date: "2022-06-01", quantity: 1 },
    ]);
    expect(ok.success).toBe(true);
    const kids = await childrenOf(yieldParent);
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.is_yield === true)).toBe(true);
    // Yield carries cost 0 (proportional split of the parent's 0/0).
    expect(kids.every((k) => Number(k.cashflow_amount_eur) === 0)).toBe(true);
  });

  it("no-cost legs fall back to the proportional split and INHERIT cashflow_user_set from the parent", async () => {
    // A user-costed parent (cashflow_user_set=true) split with NO leg costs:
    // children get proportional amounts AND inherit user_set=true (audit-3).
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 22000,
      cashflowEur: 20000,
      cashflowUserSet: true,
    });

    const res = await splitActivityEntry(parentId, [
      { effective_date: "2020-07-01", quantity: 0.5 },
      { effective_date: "2020-08-01", quantity: 1.5 },
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(parentId);
    expect(kids).toHaveLength(2);
    // Inherited user_set.
    expect(kids.every((k) => k.cashflow_user_set === true)).toBe(true);
    // Proportional: 0.25 / 0.75 of €20,000 (last leg absorbs the remainder).
    const eur = kids.map((k) => Number(k.cashflow_amount_eur));
    expect(eur[0]).toBeCloseTo(5000, 6);
    expect(eur[1]).toBeCloseTo(15000, 6);
    expect(eur[0] + eur[1]).toBeCloseTo(20000, 6);
  });

  it("a mix of one costed leg + one no-cost leg: costed leg verbatim, no-cost leg absorbs the parent remainder", async () => {
    // Parent €30k / $33k. Costed leg claims €6k / $6.6k.
    // No-cost pool = €30k − €6k = €24k / $33k − $6.6k = $26.4k.
    // Σ(children) === parent in BOTH currencies.
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 33000,
      cashflowEur: 30000,
      cashflowUserSet: false,
    });

    const res = await splitActivityEntry(parentId, [
      { effective_date: "2021-09-01", quantity: 0.5, cost: { amount: 6000, currency: "EUR" } },
      { effective_date: "2021-10-01", quantity: 1.5 }, // no cost → remainder of no-cost pool
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(parentId);
    expect(kids).toHaveLength(2);
    // Costed leg: entered verbatim + user_set true; USD derived 6000×1.10.
    expect(Number(kids[0].cashflow_amount_eur)).toBe(6000);
    expect(Number(kids[0].cashflow_amount_usd)).toBe(6600);
    expect(kids[0].cashflow_user_set).toBe(true);
    // No-cost leg: gets the no-cost pool remainder (parent − costed = €24k / $26.4k).
    // Σ(all children) === parent in both currencies.
    expect(Number(kids[1].cashflow_amount_eur)).toBe(24000);
    expect(Number(kids[1].cashflow_amount_usd)).toBe(26400);
    expect(kids[1].cashflow_user_set).toBe(false);
    // Σ === parent
    expect(Number(kids[0].cashflow_amount_eur) + Number(kids[1].cashflow_amount_eur)).toBe(30000);
    expect(Number(kids[0].cashflow_amount_usd) + Number(kids[1].cashflow_amount_usd)).toBe(33000);
  });

  it("1 costed (€6k) + 2 no-cost legs on €30k parent: no-cost children split €24k by qty, Σ=€30k", async () => {
    // Parent €30k / $33k. Costed leg: 0.5 BTC = €6k / $6.6k.
    // No-cost pool = €30k − €6k = €24k / $33k − $6.6k = $26.4k.
    // No-cost qty total = 0.75 + 0.75 = 1.5 BTC.
    // Each no-cost child = €24k × (0.75/1.5) = €12k / $26.4k × 0.5 = $13.2k.
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 33000,
      cashflowEur: 30000,
      cashflowUserSet: false,
    });

    const res = await splitActivityEntry(parentId, [
      { effective_date: "2021-09-01", quantity: 0.5, cost: { amount: 6000, currency: "EUR" } },
      { effective_date: "2021-10-01", quantity: 0.75 }, // no cost, 0.75 BTC
      { effective_date: "2021-11-01", quantity: 0.75 }, // no cost, 0.75 BTC
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(parentId);
    expect(kids).toHaveLength(3);
    // Costed child.
    expect(Number(kids[0].cashflow_amount_eur)).toBe(6000);
    expect(Number(kids[0].cashflow_amount_usd)).toBe(6600);
    // Two no-cost children split €24k / $26.4k proportionally (equal qty → equal split).
    expect(Number(kids[1].cashflow_amount_eur)).toBe(12000);
    expect(Number(kids[1].cashflow_amount_usd)).toBe(13200);
    expect(Number(kids[2].cashflow_amount_eur)).toBe(12000);
    expect(Number(kids[2].cashflow_amount_usd)).toBe(13200);
    // Σ(all 3) === parent in BOTH currencies.
    const sumEur = kids.reduce((s, k) => s + Number(k.cashflow_amount_eur), 0);
    const sumUsd = kids.reduce((s, k) => s + Number(k.cashflow_amount_usd), 0);
    expect(sumEur).toBe(30000); // Σ === parent EUR
    expect(sumUsd).toBe(33000); // Σ === parent USD
  });

  it("clamp: costed leg exceeds parent → no-cost children get 0, never negative", async () => {
    // Parent €30k / $33k. Costed leg claims €35k (over-budget).
    // No-cost pool = max(0, 30000 − 35000) = 0 in EUR; max(0, 33000 − 38500) = 0 in USD.
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 33000,
      cashflowEur: 30000,
      cashflowUserSet: false,
    });

    const res = await splitActivityEntry(parentId, [
      { effective_date: "2022-01-01", quantity: 0.5, cost: { amount: 35000, currency: "EUR" } },
      { effective_date: "2022-02-01", quantity: 1.5 }, // no cost → must get 0, not negative
    ]);
    expect(res.success).toBe(true);

    const kids = await childrenOf(parentId);
    expect(kids).toHaveLength(2);
    // Costed leg verbatim.
    expect(Number(kids[0].cashflow_amount_eur)).toBe(35000);
    // No-cost leg clamped to 0 — never negative.
    expect(Number(kids[1].cashflow_amount_eur)).toBe(0);
    expect(Number(kids[1].cashflow_amount_usd)).toBe(0);
  });

  it("unsplit restores the parent and deletes the children", async () => {
    const parentId = await insertBuyParent({
      qty: 2,
      cashflowUsd: 44000,
      cashflowEur: 40000,
    });

    const split = await splitActivityEntry(parentId, [
      { effective_date: "2019-03-01", quantity: 1, cost: { amount: 5000, currency: "EUR" } },
      { effective_date: "2019-04-01", quantity: 1, cost: { amount: 9000, currency: "EUR" } },
    ]);
    expect(split.success).toBe(true);
    expect(await childrenOf(parentId)).toHaveLength(2);

    // Parent is marked undone post-split.
    const { data: pre } = await admin
      .from("activity_log")
      .select("undone_at")
      .eq("id", parentId)
      .single();
    expect(pre!.undone_at).not.toBeNull();

    const un = await unsplitActivityEntry(parentId);
    expect(un.success).toBe(true);
    // Children gone, parent restored (undone_at cleared).
    expect(await childrenOf(parentId)).toHaveLength(0);
    const { data: post } = await admin
      .from("activity_log")
      .select("undone_at, cashflow_amount_eur")
      .eq("id", parentId)
      .single();
    expect(post!.undone_at).toBeNull();
    expect(Number(post!.cashflow_amount_eur)).toBe(40000);
  });
});

// ─── (B) #94 augmentation byte-identity for legacy split children ────────────
describe("augmentation byte-identity: legacy split child vs new split child (Task 4.1)", () => {
  let userId: string;
  let cleanup: () => void;
  const activityIds: string[] = [];
  const positionIds: string[] = [];
  const assetIds: string[] = [];
  const walletIds: string[] = [];
  const histKeys: string[] = [];

  beforeAll(async () => {
    // fetchHistoricalPriceInputsFor calls createAdminClient() internally for the
    // cache WRITE path — patch the env it reads from `supabase status`.
    const out = execFileSync("supabase", ["status", "--output", "json"], { encoding: "utf-8" });
    const cfg = JSON.parse(out) as { API_URL: string; SERVICE_ROLE_KEY: string };
    process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.API_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.SERVICE_ROLE_KEY;

    const result = await createTestUser();
    userId = result.userId;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    if (activityIds.length) await admin.from("activity_log").delete().in("id", activityIds);
    if (positionIds.length) await admin.from("crypto_positions").delete().in("id", positionIds);
    if (assetIds.length) await admin.from("crypto_assets").delete().in("id", assetIds);
    for (const k of histKeys) await admin.from("historical_prices").delete().eq("asset_key", k);
    if (walletIds.length) await admin.from("wallets").delete().in("id", walletIds);
    cleanup();
  });

  /** Seed wallet + crypto asset + position; return the position id + coingecko key. */
  async function seedAsset(label: string) {
    const { data: wallet } = await admin
      .from("wallets")
      .insert({ user_id: userId, name: `W-${label}`, wallet_type: "custodial" })
      .select("id")
      .single();
    walletIds.push(wallet!.id);

    const suffix = randomUUID();
    const cgId = `bi-${label}-${suffix}`;
    const ticker = `BI${suffix.replace(/-/g, "").slice(0, 6)}`;
    const { data: asset } = await admin
      .from("crypto_assets")
      .insert({ user_id: userId, name: `Asset ${label}`, coingecko_id: cgId, ticker })
      .select("id")
      .single();
    assetIds.push(asset!.id);
    histKeys.push(cgId);

    const { data: pos } = await admin
      .from("crypto_positions")
      .insert({ crypto_asset_id: asset!.id, wallet_id: wallet!.id, quantity: 1 })
      .select("id")
      .single();
    positionIds.push(pos!.id);

    return { positionId: pos!.id, cgId };
  }

  it("a legacy child (action='updated', NO split_direction) yields the SAME qty_delta as a new child (+split_direction)", async () => {
    const effDate = "2020-05-05";

    // Parent rows (must exist so split_from_id FK resolves; marked undone so
    // they don't themselves contribute lot deltas).
    async function insertUndoneParent(positionId: string): Promise<string> {
      const { data } = await admin
        .from("activity_log")
        .insert({
          user_id: userId,
          action: "created",
          entity_type: "crypto_position",
          entity_id: positionId,
          entity_name: "BI parent",
          description: "parent",
          is_adjustment: false,
          before_snapshot: null,
          after_snapshot: { quantity: 0.75 },
          undone_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      activityIds.push(data!.id);
      return data!.id;
    }

    // ── Legacy-shape child: a #94 child has positive split_quantity, action
    // inherited from a non-removed parent ('updated'), and NO split_direction. ──
    const legacy = await seedAsset("legacy");
    const legacyParent = await insertUndoneParent(legacy.positionId);
    const { data: legacyChild } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: legacy.positionId,
        entity_name: "BI legacy child",
        description: "legacy split child",
        is_adjustment: false,
        split_from_id: legacyParent,
        effective_date: effDate,
        details: { split_quantity: 0.75 }, // NO split_direction
        before_snapshot: null,
        after_snapshot: null,
      })
      .select("id")
      .single();
    activityIds.push(legacyChild!.id);

    // ── New-shape child: identical, but WITH split_direction = +1 (the value a
    // BUY parent stamps). ──
    const fresh = await seedAsset("fresh");
    const freshParent = await insertUndoneParent(fresh.positionId);
    const { data: freshChild } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: fresh.positionId,
        entity_name: "BI fresh child",
        description: "new split child",
        is_adjustment: false,
        split_from_id: freshParent,
        effective_date: effDate,
        details: { split_quantity: 0.75, split_direction: 1 },
        before_snapshot: null,
        after_snapshot: null,
      })
      .select("id")
      .single();
    activityIds.push(freshChild!.id);

    const { lots } = await fetchHistoricalPriceInputsFor(admin, userId);

    const legacyLot = lots.find((l) => l.asset_key === legacy.cgId);
    const freshLot = lots.find((l) => l.asset_key === fresh.cgId);
    expect(legacyLot).toBeDefined();
    expect(freshLot).toBeDefined();

    const legacyDelta = legacyLot!.deltas.find((d) => d.effective_date === effDate);
    const freshDelta = freshLot!.deltas.find((d) => d.effective_date === effDate);
    expect(legacyDelta).toBeDefined();
    expect(freshDelta).toBeDefined();

    // BYTE-IDENTITY: legacy (+1 default) == new (+1 explicit) == +0.75.
    expect(legacyDelta!.qty_delta).toBe(0.75);
    expect(legacyDelta!.qty_delta).toBe(freshDelta!.qty_delta);
  });

  it("a SELL parent's child (split_direction = -1) yields a NEGATIVE qty_delta via the augmentation", async () => {
    // End-to-end: insert a split child with split_direction = −1 (the value a
    // SELL parent stamps), run through the real fetchHistoricalPriceInputsFor,
    // and assert the lot's qty_delta is negative — mirroring the +1 byte-identity
    // test's structure but for the disposal path.
    const effDate = "2021-03-10";

    const sell = await seedAsset("sell");
    const { data: sellParent } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: sell.positionId,
        entity_name: "BI sell parent",
        description: "sell parent",
        is_adjustment: false,
        before_snapshot: { quantity: 1 },
        after_snapshot: { quantity: 0 },
        undone_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    activityIds.push(sellParent!.id);

    const { data: sellChild } = await admin
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: sell.positionId,
        entity_name: "BI sell child",
        description: "sell split child",
        is_adjustment: false,
        split_from_id: sellParent!.id,
        effective_date: effDate,
        details: { split_quantity: 0.6, split_direction: -1 },
        before_snapshot: null,
        after_snapshot: null,
      })
      .select("id")
      .single();
    activityIds.push(sellChild!.id);

    const { lots } = await fetchHistoricalPriceInputsFor(admin, userId);
    const sellLot = lots.find((l) => l.asset_key === sell.cgId);
    expect(sellLot).toBeDefined();

    const sellDelta = sellLot!.deltas.find((d) => d.effective_date === effDate);
    expect(sellDelta).toBeDefined();
    // split_direction = −1 → qty_delta must be NEGATIVE (−0.60).
    expect(sellDelta!.qty_delta).toBe(-0.6);
  });
});
