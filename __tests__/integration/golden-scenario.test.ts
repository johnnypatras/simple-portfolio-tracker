import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  GOLDEN-SCENARIO INVARIANT SUITE — the permanent semantic anchor
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Walks ONE synthetic portfolio through the ENTIRE "one rule v3" rulebook via the
 * REAL server actions against the REAL local database, asserting HAND-COMPUTED
 * values at every step. If any future change breaks the accounting philosophy,
 * this file fails.
 *
 * THE ONE RULE (participation): money STARTS counting toward the S&P benchmark
 * when it enters (deposit / new-money buy / yield at market value on receipt —
 * Model B), KEEPS counting through every internal change (tracked-account
 * buys/sells route through S&P-neutral two-leg transfers), STOPS counting when
 * it leaves (withdrawal / sell-that-exits).
 *
 * Cost basis: average-cost engine; yield cost = 0; sell-to-tracked books realized
 * P&L; corrections (is_adjustment without a transfer group) are off-book.
 *
 * CARDINAL RULE OF THIS FILE: every expected value is a literal number derived by
 * visible arithmetic in a comment. No expectation is ever computed by calling the
 * code under test (that would be circular). If hand arithmetic and the system
 * disagree, the test FAILS — we never bend the expectation to match.
 *
 * ── Clean numbers (the fixed mock economy) ─────────────────────────────────
 *   FX:                 1 EUR = 1.10 USD (USD→EUR = 1/1.10, internally exact)
 *   Current BTC price:  $44,000  →  €40,000  (44000 / 1.10)
 *   Historical BTC:     default $30,000; "2026-02-01" → $20,000 (revaluation)
 *
 * Strategy mirrors transactions.test.ts: mock createServerSupabaseClient + the
 * price/FX/historical modules, then call the actual server actions against local
 * Supabase. No historical_prices table seeding is needed — the backdate/heal
 * recompute reads through the mocked fetchYahooDailyHistory, not the DB cache.
 *
 * Requires local Supabase running (supabase start).
 */

// ─── Hoisted mock state ──────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
  // Date-dependent historical BTC price map (USD). Demonstrates that a backdate
  // REVALUES: the heal (today) reads the default $30,000; the step-7 backdate to
  // "2026-02-01" reads $20,000.
  histPriceByDate: { "2026-02-01": 20000 } as Record<string, number>,
  histPriceDefault: 30000,
}));

// ─── Module mocks ────────────────────────────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => hoisted.testClient),
}));

// CoinGecko current-price mock: BTC = $44,000 / €40,000. executeTransfer's
// fetchPrices() reads this for the destination/source crypto leg's delta.
vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({
    "__BTC__": { usd: 44000, eur: 40000 },
  })),
  getCoinImage: vi.fn(async () => null),
  // fetchCoinHistory is the obscure-coin fallback inside computeDeltaFromSnapshots;
  // Yahoo (below) always answers first, so this is never the source of truth here.
  fetchCoinHistory: vi.fn(async () => []),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

// Fixed FX mock: 1 EUR = 1.10 USD, internally EXACT (USD→EUR = 1/1.10).
// getFXRates(base, targets, date?) returns the base at rate 1 plus each cross.
vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (base: string, targets: string[]) => {
    const rates: Record<string, number> = { [base]: 1 };
    for (const t of targets) {
      if (t === base) continue;
      if (base === "EUR" && t === "USD") rates.USD = 1.1;
      else if (base === "USD" && t === "EUR") rates.EUR = 1 / 1.1;
      else if (t === "USD") rates.USD = 1.1;
      else if (t === "EUR") rates.EUR = 1 / 1.1;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.1, EUR: 1 })),
}));

// Date-dependent historical price mock. computeDeltaFromSnapshots (crypto path)
// calls fetchYahooDailyHistory(symbol, txDate, txDate); we key the returned price
// on the requested date so the heal ($30,000 today) and the backdate ($20,000 at
// 2026-02-01) are both hand-computable. fetchFxUsdPivotHistory is unused here
// (no chart augmentation read in this suite) — returns [].
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(
    async (_symbol: string, startDate: string) => {
      const day = startDate.split("T")[0];
      const price = hoisted.histPriceByDate[day] ?? hoisted.histPriceDefault;
      return [{ date: day, price }];
    },
  ),
  fetchFxUsdPivotHistory: vi.fn(async () => []),
}));

// ─── Imports after mocks ─────────────────────────────────────
import { addTransaction, markAsYield } from "@/lib/actions/transactions";
import { backfillCashflowsAndDeltas } from "@/lib/actions/backfill";
import { executeTransfer } from "@/lib/actions/transfers";
import { backdateActivityEntry, splitActivityEntry } from "@/lib/actions/splits";
import { undoActivity } from "@/lib/actions/undo";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import { getAssetTransactions } from "@/lib/portfolio/asset-transactions";
import { computeAssetPnL } from "@/lib/portfolio/cost-basis";
import type { AssetRef, CashFlowEvent, RealCashFlowEvent } from "@/lib/types";

// deriveCashFlows only ever emits REAL flows (it reads the activity log; synthetic
// benchmark flows come from buildBenchmarkCashFlows). Narrow the union via the
// documented `!e.synthetic` guard so the is_yield field (RealCashFlowEvent-only)
// is type-visible — same pattern as cost-basis-benchmark.test.ts.
const isReal = (e: CashFlowEvent): e is RealCashFlowEvent => !e.synthetic;

/** Final cash-flow stream, narrowed to RealCashFlowEvent[] (the only kind
 *  deriveCashFlows produces). One call site = one DB read of the live stream. */
async function realEvents(): Promise<RealCashFlowEvent[]> {
  const { events } = await deriveCashFlows();
  return events.filter(isReal);
}

// ─── Constants for the scenario economy ──────────────────────
const BTC_USD = 44000; // current market price
const BTC_EUR = 40000; // 44000 / 1.10
const YIELD_BACKDATE = "2026-02-01"; // step 7 target — mock price $20,000
const SPLIT_LEG1_DATE = "2026-03-01";
const SPLIT_LEG2_DATE = "2026-04-01";

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Read the live balance of a cash account (RLS client). Used to assert the Alpha
 * Bank running ledger after each step that touches it.
 */
async function alphaBalance(client: SupabaseClient, accountId: string): Promise<number> {
  const { data, error } = await client
    .from("cash_accounts")
    .select("balance")
    .eq("id", accountId)
    .single();
  if (error) throw new Error("alphaBalance read failed: " + error.message);
  return Number(data!.balance);
}

/**
 * Read the live (non-deleted) BTC position quantity for the asset+wallet.
 */
async function btcQty(
  client: SupabaseClient,
  assetId: string,
  walletId: string,
): Promise<number> {
  const { data } = await client
    .from("crypto_positions")
    .select("quantity")
    .eq("crypto_asset_id", assetId)
    .eq("wallet_id", walletId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? Number(data.quantity) : 0;
}

describe("golden-scenario invariant suite (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let walletId: string;
  let alphaId: string; // Alpha Bank cash account (EUR)
  let institutionId: string;
  let btcAssetId: string;
  const coingeckoId = `btc-golden-${randomUUID()}`;

  let btcRef: AssetRef;

  // IDs captured during the walk for later steps.
  let yieldRowId = ""; // step 3 yield activity_log row → backdated (7)
  let buyRowId = ""; // step 2 buy activity_log row → split (8)
  let withdrawalRowId = ""; // step 6 withdrawal activity_log row → undone (10)
  let interestRowId = ""; // step 9 €50 interest deposit → marked-as-yield

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    // Institution (Alpha Bank) — direct insert (no activity_log noise).
    const { data: inst, error: instErr } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Alpha Bank" })
      .select("id")
      .single();
    if (instErr) throw new Error("institution: " + instErr.message);
    institutionId = inst!.id;

    // Wallet (Main Wallet) — direct insert.
    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Main Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("wallet: " + walletErr.message);
    walletId = wallet!.id;

    // Alpha Bank cash account (EUR), balance 0 — DIRECT insert so account
    // creation contributes NO 0-amount cashflow row to the stream (keeps every
    // flow hand-computable). The deposit in step 1 then drives the first flow.
    const { data: alpha, error: alphaErr } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        name: "Alpha Bank",
        currency: "EUR",
        balance: 0,
      })
      .select("id")
      .single();
    if (alphaErr) throw new Error("alpha cash account: " + alphaErr.message);
    alphaId = alpha!.id;

    // BTC-like crypto asset (ticker BTC drives the Yahoo BTC-USD symbol the
    // recompute uses). coingecko_id is the CoinGecko mock key — we patch the
    // mock's return to this id below so transfer prices resolve.
    const { data: asset, error: assetErr } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        name: "Bitcoin Golden",
        ticker: "BTC",
        coingecko_id: coingeckoId,
      })
      .select("id")
      .single();
    if (assetErr) throw new Error("crypto asset: " + assetErr.message);
    btcAssetId = asset!.id;
    btcRef = { class: "crypto", assetId: btcAssetId };

    // Re-point the CoinGecko price mock at THIS asset's coingecko_id so
    // executeTransfer's fetchPrices() resolves BTC = $44,000 / €40,000.
    const { getPrices } = await import("@/lib/prices/coingecko");
    (getPrices as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({ [coingeckoId]: { usd: BTC_USD, eur: BTC_EUR } }),
    );
  });

  afterAll(() => cleanup());

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1 — Deposit €10,000 to Alpha (cash IN → starts counting)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 1 — deposit €10,000 to Alpha: flow +€10,000 / +$11,000, cash class, not yield", async () => {
    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "deposit", quantity: 10000 },
    );

    // Alpha balance: 0 + 10,000 = €10,000.
    expect(await alphaBalance(client, alphaId)).toBe(10000);

    // The cash path computes the cashflow DIRECTLY at write time (no backfill):
    //   eur = +10,000 (native), usd = 10,000 × 1.10 = +11,000.
    const { data: row } = await client
      .from("activity_log")
      .select(
        "cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_status, is_yield, is_adjustment",
      )
      .eq("entity_id", alphaId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(row).not.toBeNull();
    expect(Number(row!.cashflow_amount_eur)).toBe(10000);
    expect(Number(row!.cashflow_amount_usd)).toBe(11000); // 10000 × 1.10
    expect(row!.cashflow_asset_class).toBe("cash");
    expect(row!.cashflow_status).toBe("complete");
    expect(row!.is_yield).toBe(false);
    expect(row!.is_adjustment).toBe(false);

    // The flow stream so far contains exactly this one deposit.
    const events = await realEvents();
    expect(events).toHaveLength(1);
    expect(events[0].amount_eur).toBe(10000);
    expect(events[0].amount_usd).toBe(11000);
    expect(events[0].asset_class).toBe("cash");
    expect(events[0].is_yield).toBeUndefined(); // not a yield
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2 — New-money Buy 0.2 BTC, user cost €5,000 (cash IN → starts counting)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 2 — buy 0.2 BTC cost €5,000: flow +€5,000/+$5,500 user-set, avg €25,000/BTC", async () => {
    await addTransaction(btcRef, {
      type: "buy",
      quantity: 0.2,
      cost: { amount: 5000, currency: "EUR" },
      walletId,
    });

    // BTC position: 0 + 0.2 = 0.2 BTC.
    expect(await btcQty(client, btcAssetId, walletId)).toBeCloseTo(0.2, 12);

    // Cost €5,000 EUR → dual override: eur = 5,000 (verbatim),
    //   usd = round2(5,000 × 1.10) = 5,500.  cashflow_user_set = true.
    const { data: row } = await client
      .from("activity_log")
      .select(
        "id, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, cashflow_status, is_yield, is_adjustment",
      )
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(row).not.toBeNull();
    buyRowId = row!.id as string;
    expect(Number(row!.cashflow_amount_eur)).toBe(5000);
    expect(Number(row!.cashflow_amount_usd)).toBe(5500); // 5000 × 1.10
    expect(row!.cashflow_user_set).toBe(true);
    expect(row!.cashflow_status).toBe("complete");
    expect(row!.is_yield).toBe(false);
    expect(row!.is_adjustment).toBe(false);

    // Cost basis after the buy: avg = 5,000 / 0.2 = €25,000/BTC.
    const txns = await getAssetTransactions(client, userId, btcRef);
    const pnl = computeAssetPnL(txns, {
      valueEur: 0.2 * BTC_EUR, // 0.2 × 40,000 = 8,000 (market value of held units)
      valueUsd: 0.2 * BTC_USD, // 0.2 × 44,000 = 8,800
    });
    // avg = costBasis / units = 5,000 / 0.2 = 25,000.00
    expect(pnl.eur.avgCost).toBeCloseTo(25000, 6);
    expect(pnl.eur.costBasis).toBeCloseTo(5000, 6);
    expect(pnl.eur.realized).toBe(0); // no disposals yet

    // Flow stream: deposit (€10,000) + buy (€5,000) = 2 real flows.
    const events = await realEvents();
    expect(events).toHaveLength(2);
    // Σ amount_eur = 10,000 + 5,000 = 15,000.
    const sumEur = events.reduce((s, e) => s + (e.amount_eur ?? 0), 0);
    expect(sumEur).toBeCloseTo(15000, 6);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3 — Yield 0.01 BTC (earned income IN → Model B: counts at market-on-receipt)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 3 — yield 0.01 BTC heals to market ($30,000): flow +$300/+€272.73 is_yield, cost +0", async () => {
    // Yield carries NO cost and NO prices → the row is written with
    // cashflow_status = null (engine emptyFx). The backfill then heals it via
    // computeDeltaFromSnapshots at the CURRENT date's mock price ($30,000).
    await addTransaction(btcRef, { type: "yield", quantity: 0.01, walletId });

    // BTC position: 0.2 + 0.01 = 0.21 BTC.
    expect(await btcQty(client, btcAssetId, walletId)).toBeCloseTo(0.21, 12);

    // Capture the freshly-written yield row (pre-heal: status null, is_yield true).
    const { data: pre } = await client
      .from("activity_log")
      .select("id, is_yield, cashflow_status, cashflow_user_set")
      .eq("entity_type", "crypto_position")
      .eq("user_id", userId)
      .eq("is_yield", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(pre).not.toBeNull();
    yieldRowId = pre!.id as string;
    expect(pre!.is_yield).toBe(true);
    // Written with no prices/cost → emptyFx → cashflow_status is null (NOT yet a
    // flow). The backfill below is what makes it count.
    expect(pre!.cashflow_status).toBeNull();
    expect(pre!.cashflow_user_set).toBe(false);

    // Run the backfill action exactly as the dashboard does.
    await backfillCashflowsAndDeltas();

    // Healed at today's mock price $30,000:
    //   usd = 0.01 × 30,000 = 300.00
    //   eur = 300 / 1.10     = 272.7272…  → round2 = 272.73
    const { data: healed } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_status, is_yield")
      .eq("id", yieldRowId)
      .single();
    expect(healed!.cashflow_status).toBe("complete");
    expect(Number(healed!.cashflow_amount_usd)).toBeCloseTo(300, 6);
    expect(Number(healed!.cashflow_amount_eur)).toBeCloseTo(272.73, 2);
    expect(healed!.is_yield).toBe(true);

    // The flow stream NOW carries the yield WITH is_yield: true (Model B!).
    const events = await realEvents();
    expect(events).toHaveLength(3); // deposit + buy + yield
    const yieldEvent = events.find((e) => e.is_yield === true);
    expect(yieldEvent).toBeDefined();
    expect(yieldEvent!.amount_usd).toBeCloseTo(300, 6); // 0.01 × 30,000
    expect(yieldEvent!.amount_eur).toBeCloseTo(272.73, 2);

    // Engine cost contribution of the yield = 0 → average cost DROPS:
    //   units 0.21, cost still €5,000 → avg = 5,000 / 0.21 = 23,809.5238…
    const txns = await getAssetTransactions(client, userId, btcRef);
    const pnl = computeAssetPnL(txns, {
      valueEur: 0.21 * BTC_EUR, // 0.21 × 40,000 = 8,400
      valueUsd: 0.21 * BTC_USD, // 0.21 × 44,000 = 9,240
    });
    expect(pnl.eur.costBasis).toBeCloseTo(5000, 6); // unchanged by yield
    expect(pnl.eur.avgCost).toBeCloseTo(23809.52, 2); // 5000 / 0.21
    expect(pnl.eur.realized).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4 — Buy-from-tracked (Alpha −€2,000 → +0.05 BTC): internal, S&P-NEUTRAL
  // ═══════════════════════════════════════════════════════════════════════
  it("step 4 — buy 0.05 BTC from Alpha (−€2,000): two adjustment legs, flow UNCHANGED, cost +€2,000", async () => {
    // Capture the flow stream BEFORE — it must NOT move (money already counted
    // when it entered Alpha in step 1; routing it into BTC is internal).
    const before = await realEvents();
    const beforeCount = before.length; // 3
    const beforeSumUsd = before.reduce((s, e) => s + e.amount_usd, 0);

    const result = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: alphaId, amount: 2000 },
      destination: {
        type: "crypto_position",
        assetId: btcAssetId,
        walletId,
        quantity: 0.05,
      },
    });
    expect(result.success).toBe(true);
    const groupId = result.success ? result.transferGroupId : "";
    expect(groupId).not.toBe("");

    // TWO legs share the transfer_group_id; BOTH are is_adjustment=true with
    // cashflow_status NULL (delta-only) → the S&P-neutral signature.
    const { data: legs } = await client
      .from("activity_log")
      .select("entity_type, is_adjustment, transfer_group_id, cashflow_status, delta_usd, delta_eur")
      .eq("transfer_group_id", groupId)
      .eq("user_id", userId);
    expect(legs).toHaveLength(2);
    for (const leg of legs!) {
      expect(leg.is_adjustment).toBe(true);
      expect(leg.transfer_group_id).toBe(groupId);
      expect(leg.cashflow_status).toBeNull(); // never a cashflow → never in deriveCashFlows
    }

    // Alpha balance: 10,000 − 2,000 = €8,000.
    expect(await alphaBalance(client, alphaId)).toBe(8000);
    // BTC position: 0.21 + 0.05 = 0.26 BTC.
    expect(await btcQty(client, btcAssetId, walletId)).toBeCloseTo(0.26, 12);

    // INVARIANT: the flow stream is UNCHANGED (no new rows, same Σ).
    const after = await realEvents();
    expect(after.length).toBe(beforeCount); // still 3
    const afterSumUsd = after.reduce((s, e) => s + e.amount_usd, 0);
    expect(afterSumUsd).toBeCloseTo(beforeSumUsd, 6);

    // Cost: the BTC transfer leg folds as a normal acquisition valued at the
    // MOVED value |delta_eur| (C3 rule: an is_adjustment leg carries its value in
    // delta_*, not cashflow_*). delta_eur = 0.05 × €40,000 = €2,000.
    //   cost basis: 5,000 + 2,000 = €7,000 over units 0.26 → avg = 7,000 / 0.26
    const txns = await getAssetTransactions(client, userId, btcRef);
    const pnl = computeAssetPnL(txns, {
      valueEur: 0.26 * BTC_EUR, // 0.26 × 40,000 = 10,400
      valueUsd: 0.26 * BTC_USD, // 0.26 × 44,000 = 11,440
    });
    expect(pnl.eur.costBasis).toBeCloseTo(7000, 6); // 5000 + 2000
    expect(pnl.eur.avgCost).toBeCloseTo(26923.08, 2); // 7000 / 0.26 = 26923.0769…
    expect(pnl.eur.realized).toBe(0); // an acquisition books no realized
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5 — Sell-to-tracked (0.1 BTC → Alpha +€4,000): internal, S&P-NEUTRAL, realizes P&L
  // ═══════════════════════════════════════════════════════════════════════
  it("step 5 — sell 0.1 BTC to Alpha (+€4,000): flow UNCHANGED, Alpha €12,000, BTC 0.16, realized €1,307.69", async () => {
    const before = await realEvents();
    const beforeCount = before.length; // 3
    const beforeSumUsd = before.reduce((s, e) => s + e.amount_usd, 0);

    const result = await executeTransfer({
      mode: "sell",
      source: {
        type: "crypto_position",
        assetId: btcAssetId,
        walletId,
        quantity: 0.1,
      },
      // 0.1 × €40,000 = €4,000 to Alpha.
      destination: { type: "cash_account", accountId: alphaId, amount: 4000 },
    });
    expect(result.success).toBe(true);
    const groupId = result.success ? result.transferGroupId : "";

    // Two adjustment legs again — S&P-neutral.
    const { data: legs } = await client
      .from("activity_log")
      .select("is_adjustment, cashflow_status")
      .eq("transfer_group_id", groupId)
      .eq("user_id", userId);
    expect(legs).toHaveLength(2);
    for (const leg of legs!) {
      expect(leg.is_adjustment).toBe(true);
      expect(leg.cashflow_status).toBeNull();
    }

    // Alpha balance: 8,000 + 4,000 = €12,000.
    expect(await alphaBalance(client, alphaId)).toBe(12000);
    // BTC position: 0.26 − 0.1 = 0.16 BTC.
    expect(await btcQty(client, btcAssetId, walletId)).toBeCloseTo(0.16, 12);

    // INVARIANT: flow stream UNCHANGED (the disposal stays inside the tracked
    // perimeter — money did not leave the portfolio).
    const after = await realEvents();
    expect(after.length).toBe(beforeCount); // still 3
    const afterSumUsd = after.reduce((s, e) => s + e.amount_usd, 0);
    expect(afterSumUsd).toBeCloseTo(beforeSumUsd, 6);

    // Realized P&L of the disposal via the PUBLIC read path (computeAssetPnL fed
    // the production way: getAssetTransactions rows + current market value).
    //
    // Running fold (EUR), stream order buy → yield → buy-in → sell:
    //   buy   +0.20 @ €5,000  → units 0.20, cost 5,000
    //   yield +0.01 (cost 0)  → units 0.21, cost 5,000
    //   buyin +0.05 @ €2,000  → units 0.26, cost 7,000
    //   sell  −0.10           → avg = 7,000 / 0.26 = 26,923.076923…
    //                           realized = proceeds − avg × out
    //                                    = 4,000 − 26,923.076923 × 0.10
    //                                    = 4,000 − 2,692.307692 = 1,307.692307…
    //   → round to 2dp = €1,307.69 ; remaining cost = 7,000 − 2,692.31 = 4,307.69
    //     remaining units 0.16 → avg = 4,307.69 / 0.16 = €26,923.08
    const txns = await getAssetTransactions(client, userId, btcRef);
    const pnl = computeAssetPnL(txns, {
      valueEur: 0.16 * BTC_EUR, // 0.16 × 40,000 = 6,400 (held units' market value)
      valueUsd: 0.16 * BTC_USD, // 0.16 × 44,000 = 7,040
    });
    expect(pnl.eur.realized).toBeCloseTo(1307.69, 2);
    expect(pnl.eur.costBasis).toBeCloseTo(4307.69, 2);
    expect(pnl.eur.avgCost).toBeCloseTo(26923.08, 2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 6 — Withdrawal €1,000 from Alpha (cash OUT → stops counting)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 6 — withdraw €1,000 from Alpha: flow −€1,000/−$1,100, Alpha €11,000", async () => {
    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "withdrawal", quantity: 1000 },
    );

    // Alpha balance: 12,000 − 1,000 = €11,000.
    expect(await alphaBalance(client, alphaId)).toBe(11000);

    // The withdrawal is a real OUTFLOW: cashDelta = 11,000 − 12,000 = −1,000.
    //   eur = −1,000 ; usd = −1,000 × 1.10 = −1,100. cashflow_status complete.
    const { data: row } = await client
      .from("activity_log")
      .select("id, cashflow_amount_usd, cashflow_amount_eur, cashflow_status, is_adjustment, is_yield")
      .eq("entity_id", alphaId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(row).not.toBeNull();
    withdrawalRowId = row!.id as string;
    expect(Number(row!.cashflow_amount_eur)).toBe(-1000);
    expect(Number(row!.cashflow_amount_usd)).toBe(-1100); // −1000 × 1.10
    expect(row!.cashflow_status).toBe("complete");
    expect(row!.is_adjustment).toBe(false);
    expect(row!.is_yield).toBe(false);

    // The flow stream now carries the negative withdrawal among the 4 real flows.
    const events = await realEvents();
    expect(events).toHaveLength(4); // deposit + buy + yield + withdrawal
    const withdrawal = events.find((e) => e.amount_usd === -1100);
    expect(withdrawal).toBeDefined();
    expect(withdrawal!.amount_eur).toBe(-1000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 7 — Backdate the yield row → REVALUE at the new date's price ($20,000)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 7 — backdate yield to 2026-02-01: dated AND revalued to +$200 (0.01 × 20,000), user-set false", async () => {
    const res = await backdateActivityEntry(yieldRowId, YIELD_BACKDATE);
    expect(res.success).toBe(true);

    // Model B receipt-date valuation: a yield flow IS its market value on the
    // receipt date, so a backdate MUST revalue it at the new date's mock price
    // $20,000 (not the prior $30,000):
    //   usd = 0.01 × 20,000 = 200.00
    //   eur = 200 / 1.10     = 181.8181…  → round2 = 181.82
    // and cashflow_user_set must be (stay) false — a "cost" on a yield row is
    // meaningless, so the revalue clears it.
    const { data: row } = await client
      .from("activity_log")
      .select("effective_date, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, is_yield")
      .eq("id", yieldRowId)
      .single();
    expect(row!.effective_date).toBe(YIELD_BACKDATE);
    expect(Number(row!.cashflow_amount_usd)).toBeCloseTo(200, 6); // 0.01 × 20,000
    expect(Number(row!.cashflow_amount_eur)).toBeCloseTo(181.82, 2);
    expect(row!.cashflow_user_set).toBe(false);
    expect(row!.is_yield).toBe(true); // still earned income

    // The flow stream's yield event is now DATED at 2026-02-01 and revalued.
    const events = await realEvents();
    const yieldEvent = events.find((e) => e.is_yield === true);
    expect(yieldEvent).toBeDefined();
    expect(yieldEvent!.date).toBe(YIELD_BACKDATE);
    expect(yieldEvent!.amount_usd).toBeCloseTo(200, 6);
    expect(yieldEvent!.amount_eur).toBeCloseTo(181.82, 2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 8 — Split the step-2 buy into two dated legs (shape, not economics)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 8 — split the €5,000 buy into 0.12 (cost €3,200) + 0.08 (remainder €1,800): legs sum to €5,000, avg UNCHANGED", async () => {
    // Capture the BTC average cost BEFORE the split (after steps 5–7; the cash
    // withdrawal and the yield backdate did not change BTC units or cost). This
    // is the "before" half of the split-is-shape invariant.
    const txnsBefore = await getAssetTransactions(client, userId, btcRef);
    const pnlBefore = computeAssetPnL(txnsBefore, {
      valueEur: 0.16 * BTC_EUR,
      valueUsd: 0.16 * BTC_USD,
    });
    // avg = remaining cost / remaining units = 4,307.69 / 0.16 = €26,923.08
    expect(pnlBefore.eur.avgCost).toBeCloseTo(26923.08, 2);

    // The parent buy created the position 0 → 0.2, so extractQuantity = 0.2; legs
    // must sum to 0.2. Leg 1 carries an explicit cost €3,200 EUR; leg 2 carries
    // no cost and ABSORBS the remainder of the parent's amounts.
    const res = await splitActivityEntry(buyRowId, [
      { effective_date: SPLIT_LEG1_DATE, quantity: 0.12, cost: { amount: 3200, currency: "EUR" } },
      { effective_date: SPLIT_LEG2_DATE, quantity: 0.08 },
    ]);
    expect(res.success).toBe(true);

    // Parent is now undone; two children exist.
    const { data: parent } = await client
      .from("activity_log")
      .select("undone_at")
      .eq("id", buyRowId)
      .single();
    expect(parent!.undone_at).not.toBeNull();

    const { data: children } = await client
      .from("activity_log")
      .select("effective_date, cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, details")
      .eq("split_from_id", buyRowId)
      .eq("user_id", userId)
      .order("effective_date", { ascending: true });
    expect(children).toHaveLength(2);

    // Leg 1 (0.12, costed €3,200): eur = 3,200 (verbatim), usd = round2(3,200 ×
    //   1.10) = 3,520. cashflow_user_set = true. date 2026-03-01.
    const leg1 = children!.find((c) => c.effective_date === SPLIT_LEG1_DATE)!;
    expect(Number(leg1.cashflow_amount_eur)).toBe(3200);
    expect(Number(leg1.cashflow_amount_usd)).toBe(3520); // 3200 × 1.10
    expect(leg1.cashflow_user_set).toBe(true);
    // Leg 2 (0.08, remainder): eur = 5,000 − 3,200 = 1,800 ; usd = 5,500 − 3,520
    //   = 1,980. date 2026-04-01.
    const leg2 = children!.find((c) => c.effective_date === SPLIT_LEG2_DATE)!;
    expect(Number(leg2.cashflow_amount_eur)).toBe(1800); // 5000 − 3200
    expect(Number(leg2.cashflow_amount_usd)).toBe(1980); // 5500 − 3520

    // Σ over the legs equals the original buy in BOTH currencies (the split moved
    // shape, not money): eur 3,200 + 1,800 = 5,000 ; usd 3,520 + 1,980 = 5,500.
    const sumEur = children!.reduce((s, c) => s + Number(c.cashflow_amount_eur), 0);
    const sumUsd = children!.reduce((s, c) => s + Number(c.cashflow_amount_usd), 0);
    expect(sumEur).toBeCloseTo(5000, 6);
    expect(sumUsd).toBeCloseTo(5500, 6);

    // The engine's average cost is UNCHANGED by the split: the two legs fold to
    // the SAME total acquisition (units +0.12 +0.08 = +0.20, cost €3,200 + €1,800
    // = €5,000) the parent contributed, so the running state at the sell is
    // identical and the final avg stays €26,923.08. (The yield's reorder ahead of
    // the legs is cost-neutral — yield contributes 0 cost — so it cannot move it.)
    const txnsAfter = await getAssetTransactions(client, userId, btcRef);
    const pnlAfter = computeAssetPnL(txnsAfter, {
      valueEur: 0.16 * BTC_EUR,
      valueUsd: 0.16 * BTC_USD,
    });
    expect(pnlAfter.eur.avgCost).toBeCloseTo(pnlBefore.eur.avgCost, 6);
    expect(pnlAfter.eur.avgCost).toBeCloseTo(26923.08, 2);
    expect(pnlAfter.eur.costBasis).toBeCloseTo(4307.69, 2);
    expect(pnlAfter.eur.realized).toBeCloseTo(1307.69, 2); // disposal P&L unchanged
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 9 — Mark-as-Yield a fresh €50 interest deposit (Model B: it already counted)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 9 — €50 interest deposit then markAsYield: is_yield true, amounts byte-identical, stream total unchanged", async () => {
    // First create a plain cash interest deposit of €50 into Alpha.
    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "deposit", quantity: 50 },
    );
    // Alpha balance: 11,000 + 50 = €11,050.
    expect(await alphaBalance(client, alphaId)).toBe(11050);

    const { data: dep } = await client
      .from("activity_log")
      .select("id, cashflow_amount_usd, cashflow_amount_eur, is_yield, cashflow_status")
      .eq("entity_id", alphaId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    interestRowId = dep!.id as string;
    // Plain deposit: eur = 50, usd = 50 × 1.10 = 55, is_yield = false.
    expect(Number(dep!.cashflow_amount_eur)).toBe(50);
    expect(Number(dep!.cashflow_amount_usd)).toBe(55);
    expect(dep!.is_yield).toBe(false);
    expect(dep!.cashflow_status).toBe("complete");

    // Capture the stream total BEFORE the flag flip — Model B says the amount
    // never changes (it counted as a deposit; it still counts, only the flag +
    // cost semantics change).
    const beforeFlip = await realEvents();
    const beforeSumUsd = beforeFlip.reduce((s, e) => s + e.amount_usd, 0);
    const beforeSumEur = beforeFlip.reduce((s, e) => s + (e.amount_eur ?? 0), 0);

    const result = await markAsYield([interestRowId]);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);

    // is_yield flipped true; cashflow amounts are BYTE-IDENTICAL (never zeroed —
    // un-yield must be lossless).
    const { data: after } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, is_yield")
      .eq("id", interestRowId)
      .single();
    expect(after!.is_yield).toBe(true);
    expect(Number(after!.cashflow_amount_eur)).toBe(50); // unchanged
    expect(Number(after!.cashflow_amount_usd)).toBe(55); // unchanged

    // The flow stream TOTAL is unchanged by the flag flip (Model B).
    const afterFlip = await realEvents();
    const afterSumUsd = afterFlip.reduce((s, e) => s + e.amount_usd, 0);
    const afterSumEur = afterFlip.reduce((s, e) => s + (e.amount_eur ?? 0), 0);
    expect(afterSumUsd).toBeCloseTo(beforeSumUsd, 6);
    expect(afterSumEur).toBeCloseTo(beforeSumEur, 6);
    // The €50 row now reads is_yield in the stream.
    const flipped = afterFlip.find((e) => e.amount_usd === 55);
    expect(flipped).toBeDefined();
    expect(flipped!.is_yield).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 10 — Undo the step-6 withdrawal (flow disappears, balance restored)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 10 — undo the €1,000 withdrawal: its flow disappears, Alpha back to €12,050", async () => {
    const res = await undoActivity(withdrawalRowId);
    expect(res.success).toBe(true);

    // The withdrawal row is now tombstoned (undone_at set) → excluded from
    // deriveCashFlows; the compensation row carries cashflow_status null → also
    // excluded. Net: the −€1,000 / −$1,100 flow is GONE, with no new flow added.
    const { data: undoneRow } = await client
      .from("activity_log")
      .select("undone_at")
      .eq("id", withdrawalRowId)
      .single();
    expect(undoneRow!.undone_at).not.toBeNull();

    // Alpha ledger (running): after step 6 = 11,000; step 9 deposit +50 = 11,050;
    // undo reverses the −1,000 delta on the CURRENT balance:
    //   new = current + (before − after) = 11,050 + (12,000 − 11,000) = €12,050.
    expect(await alphaBalance(client, alphaId)).toBe(12050);

    // The withdrawal flow is no longer present in the stream.
    const events = await realEvents();
    const stillThere = events.find((e) => e.amount_usd === -1100);
    expect(stillThere).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 11 — Final flow stream = the S&P-replay contract (full hand-computed Σ)
  // ═══════════════════════════════════════════════════════════════════════
  it("step 11 — final deriveCashFlows stream matches the hand-computed pipeline contract", async () => {
    // FALLBACK TAKEN (documented per the task): rather than drive the pure
    // enrichChartData, we assert the EXACT final flow stream that the S&P replay
    // consumes. Rationale: enrichChartData's benchmark path re-seeds the S&P
    // units against the portfolio's value at chartStart (firstSliceUsd) AND
    // applies the Task-3.4f cost-basis re-anchor, so the final sp500 value is NOT
    // simply Σ(signed USD flows) / price — constructing a synthetic ChartPoint[]
    // that neutralises the seed (and the cost-basis gap) to recover a clean
    // hand-computable identity is disproportionate. The flow stream IS the
    // benchmark's sole input (post-Phase-4), so asserting it verbatim — every
    // event's date/sign/amount/is_yield plus the exact Σ in both currencies — is
    // the strongest hand-computable contract on the replay.
    //
    // FINAL stream after all 10 steps (what counts / what was removed):
    //   IN  step 1  deposit  Alpha   +€10,000.00 / +$11,000.00  (not yield)
    //   IN  step 2  buy 0.2 BTC  →  SPLIT into:
    //         leg1 (0.12, 2026-03-01)  +€3,200.00 / +$3,520.00   (user-set)
    //         leg2 (0.08, 2026-04-01)  +€1,800.00 / +$1,980.00
    //   IN  step 3  yield  →  BACKDATED+REVALUED (2026-02-01)
    //         +€181.82 / +$200.00   (is_yield)
    //   OUT step 4  buy-from-tracked   → two adjustment legs → NOT in stream
    //   OUT step 5  sell-to-tracked    → two adjustment legs → NOT in stream
    //   GONE step 6 withdrawal −€1,000 → UNDONE → NOT in stream
    //   IN  step 9  interest €50  →  marked-as-yield
    //         +€50.00 / +$55.00   (is_yield)
    //
    //   Σ amount_usd = 11,000 + 3,520 + 1,980 + 200 + 55 = 16,755.00
    //   Σ amount_eur = 10,000 + 3,200 + 1,800 + 181.82 + 50 = 15,231.82
    const { events: rawEvents, pendingCount, failedCount } = await deriveCashFlows();
    const events = rawEvents.filter(isReal);

    // Exactly 5 real flows survive (deposit + 2 split legs + yield + interest).
    expect(events).toHaveLength(5);
    expect(pendingCount).toBe(0);
    expect(failedCount).toBe(0);

    // ── Σ over the whole stream (the replay's signed-amount input) ──
    const sumUsd = events.reduce((s, e) => s + e.amount_usd, 0);
    const sumEur = events.reduce((s, e) => s + (e.amount_eur ?? 0), 0);
    expect(sumUsd).toBeCloseTo(16755, 2); // 11000 + 3520 + 1980 + 200 + 55
    expect(sumEur).toBeCloseTo(15231.82, 2); // 10000 + 3200 + 1800 + 181.82 + 50

    // ── Every event identified by its hand-computed amount, then asserted ──
    // (order-independent: each flow is unique by amount in this scenario.)
    const byUsd = (usd: number) => {
      const found = events.filter((e) => Math.abs(e.amount_usd - usd) < 1e-6);
      expect(found).toHaveLength(1);
      return found[0];
    };

    const deposit = byUsd(11000); // step 1
    expect(deposit.amount_eur).toBeCloseTo(10000, 6);
    expect(deposit.asset_class).toBe("cash");
    expect(deposit.is_yield).toBeUndefined();

    const leg1 = byUsd(3520); // step 2 → split leg 1
    expect(leg1.amount_eur).toBeCloseTo(3200, 6);
    expect(leg1.date).toBe(SPLIT_LEG1_DATE);
    expect(leg1.is_yield).toBeUndefined();

    const leg2 = byUsd(1980); // step 2 → split leg 2
    expect(leg2.amount_eur).toBeCloseTo(1800, 6);
    expect(leg2.date).toBe(SPLIT_LEG2_DATE);
    expect(leg2.is_yield).toBeUndefined();

    const yieldEvent = byUsd(200); // step 3 → backdated + revalued
    expect(yieldEvent.amount_eur).toBeCloseTo(181.82, 2);
    expect(yieldEvent.date).toBe(YIELD_BACKDATE);
    expect(yieldEvent.is_yield).toBe(true);

    const interest = byUsd(55); // step 9 → marked-as-yield
    expect(interest.amount_eur).toBeCloseTo(50, 6);
    expect(interest.is_yield).toBe(true);

    // ── No outflow / internal-leg residue ──
    // The withdrawal (−$1,100), the buy-from-tracked, and the sell-to-tracked
    // legs are all absent: no negative flow survives, and no transfer-leg value
    // leaked into the stream.
    expect(events.every((e) => e.amount_usd > 0)).toBe(true);
  });
});
