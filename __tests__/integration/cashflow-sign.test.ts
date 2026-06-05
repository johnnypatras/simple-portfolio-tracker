import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for THE SIGN CONTRACT (see @/lib/activity-fx).
 *
 * A user-supplied amount (the typed cost) is a MAGNITUDE; its stored sign comes
 * from the OPERATION, never from the override itself. These tests drive the REAL
 * server actions against local Supabase and assert the SIGNED stored amounts +
 * the SIGNED flow the benchmark's deriveCashFlows emits:
 *
 *   (a) plain SELL with a cost override        → stored NEGATIVE pair; flow negative
 *   (b) WITHDRAWAL with a cost override        → stored NEGATIVE pair
 *   (c) BUY / DEPOSIT with a cost override     → stored POSITIVE pair (regression)
 *   (d) editTransaction cost edit on a SELL    → magnitude updated, sign STAYS negative
 *   (e) editor adjustment override on a qty-DECREASE → delta_* NEGATIVE
 *
 * The zero-price trap: addTransaction passes NO prices to the position primitive
 * (val* is 0/-0), so the sign cannot come from Math.sign(val) — it must come from
 * the qty/balance delta. These tests exercise exactly that path.
 *
 * Strategy mirrors transactions.test.ts: mock createServerSupabaseClient + the
 * price/FX modules, then call the actual server actions.
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
  createAdminClient: vi.fn(() => hoisted.testClient),
}));

vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
  fetchCoinHistory: vi.fn(async () => []),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

// Fixed FX mock: 1 EUR = 1.10 USD.
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

vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(async (_symbol: string, startDate: string) => [
    { date: startDate, price: 30000 },
  ]),
  fetchFxUsdPivotHistory: vi.fn(async () => []),
}));

// ─── Imports after mocks ─────────────────────────────────────
import { createCryptoAsset } from "@/lib/actions/crypto";
import { addTransaction, editTransaction } from "@/lib/actions/transactions";
import { deriveCashFlows } from "@/lib/actions/benchmark";
import type { RealCashFlowEvent } from "@/lib/types";

// ─── Test suite ──────────────────────────────────────────────
describe("cashflow sign contract (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  let walletId: string;
  let cryptoAssetId: string;
  let alphaId: string;
  let institutionId: string;
  const coingeckoId = `btc-sign-${randomUUID()}`;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Sign Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("wallet: " + walletErr.message);
    walletId = wallet!.id;

    const { data: inst, error: instErr } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Sign Bank" })
      .select("id")
      .single();
    if (instErr) throw new Error("institution: " + instErr.message);
    institutionId = inst!.id;

    // Alpha cash account, balance 0 — direct insert (no activity_log noise).
    const { data: alpha, error: alphaErr } = await client
      .from("cash_accounts")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        name: "Sign Alpha",
        currency: "EUR",
        balance: 0,
      })
      .select("id")
      .single();
    if (alphaErr) throw new Error("alpha: " + alphaErr.message);
    alphaId = alpha!.id;

    cryptoAssetId = await createCryptoAsset({
      ticker: "BTC",
      name: "Bitcoin Sign Test",
      coingecko_id: coingeckoId,
    });
  });

  afterAll(() => cleanup());

  // Most-recent activity_log row by entity_type (the just-written one). Crypto
  // position rows carry entity_id = position.id (not the asset id), so we key on
  // entity_type + recency exactly like the golden-scenario suite. Cash rows can
  // additionally be pinned by entity_id = account id.
  const ROW_COLS =
    "id, cashflow_amount_usd, cashflow_amount_eur, delta_usd, delta_eur, cashflow_user_set, cashflow_status, delta_status, is_adjustment, is_yield";

  async function latestByType(entityType: string) {
    const { data } = await client
      .from("activity_log")
      .select(ROW_COLS)
      .eq("entity_type", entityType)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    return data!;
  }

  async function latestByEntity(entityId: string) {
    const { data } = await client
      .from("activity_log")
      .select(ROW_COLS)
      .eq("entity_id", entityId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    return data!;
  }

  async function realEvents(): Promise<RealCashFlowEvent[]> {
    const { events } = await deriveCashFlows();
    return events.filter((e): e is RealCashFlowEvent => !e.synthetic);
  }

  // ─── (c) BUY with a cost override → POSITIVE (regression — runs first to
  //         establish the position the sell in (a)/(d) disposes from) ──────────
  it("(c) BUY 0.16 BTC, cost €5,000 → stored POSITIVE pair, cashflow_user_set", async () => {
    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      { type: "buy", quantity: 0.16, cost: { amount: 5000, currency: "EUR" }, walletId },
    );
    // Position 0 → 0.16.
    const { data: pos } = await client
      .from("crypto_positions")
      .select("quantity")
      .eq("crypto_asset_id", cryptoAssetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBeCloseTo(0.16, 12);

    // eur = 5,000 (verbatim) ; usd = round2(5,000 × 1.10) = 5,500. POSITIVE.
    const row = await latestByType("crypto_position");
    expect(Number(row.cashflow_amount_eur)).toBe(5000);
    expect(Number(row.cashflow_amount_usd)).toBe(5500);
    expect(row.cashflow_user_set).toBe(true);
    expect(row.cashflow_status).toBe("complete");
  });

  // ─── (a) plain SELL with a cost override → NEGATIVE, flow negative ──────────
  let sellRowId = "";
  it("(a) SELL 0.04 BTC, cost €1,600 → stored NEGATIVE pair; deriveCashFlows emits the negative flow", async () => {
    // Capture the buy flow total before the sell (it must gain a negative event).
    const before = await realEvents();
    const beforeBuy = before.find((e) => e.amount_usd === 5500);
    expect(beforeBuy).toBeDefined(); // the (c) buy is in the stream

    await addTransaction(
      { class: "crypto", assetId: cryptoAssetId },
      { type: "sell", quantity: 0.04, cost: { amount: 1600, currency: "EUR" }, walletId },
    );
    // Position 0.16 → 0.12.
    const { data: pos } = await client
      .from("crypto_positions")
      .select("quantity")
      .eq("crypto_asset_id", cryptoAssetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBeCloseTo(0.12, 12);

    // THE BUG (pre-fix): stored +1,760 / +1,600 (phantom S&P contribution).
    // THE CONTRACT: a disposal stores NEGATIVE. eur = −1,600 ; usd = −round2(1,600 × 1.10) = −1,760.
    const row = await latestByType("crypto_position");
    sellRowId = row.id as string;
    expect(Number(row.cashflow_amount_eur)).toBe(-1600);
    expect(Number(row.cashflow_amount_usd)).toBe(-1760);
    expect(row.cashflow_user_set).toBe(true);
    expect(row.is_adjustment).toBe(false);

    // The replay now carries the NEGATIVE sell flow (money leaving).
    const after = await realEvents();
    const sellFlow = after.find((e) => e.amount_usd === -1760);
    expect(sellFlow).toBeDefined();
    expect(sellFlow!.amount_eur).toBe(-1600);
  });

  // ─── (d) editTransaction cost edit on the SELL row → magnitude updated, sign
  //         PRESERVED negative ─────────────────────────────────────────────────
  it("(d) edit the SELL's cost to €1,800 → amount updated, sign STAYS negative", async () => {
    const res = await editTransaction(sellRowId, {
      cost: { amount: 1800, currency: "EUR" },
    });
    expect(res.success).toBe(true);

    // New magnitude €1,800 → usd round2(1,800 × 1.10) = 1,980. Sign stays NEGATIVE
    // (the row is a disposal: quantityDelta < 0).
    const { data: row } = await client
      .from("activity_log")
      .select("cashflow_amount_usd, cashflow_amount_eur, cashflow_user_set, cashflow_status, delta_usd, delta_status")
      .eq("id", sellRowId)
      .single();
    expect(Number(row!.cashflow_amount_eur)).toBe(-1800);
    expect(Number(row!.cashflow_amount_usd)).toBe(-1980);
    expect(row!.cashflow_user_set).toBe(true);
    expect(row!.cashflow_status).toBe("complete");
    // Delta side stays nulled (never-both contract).
    expect(row!.delta_usd).toBeNull();
    expect(row!.delta_status).toBeNull();
  });

  // ─── (b) WITHDRAWAL with a cost override → NEGATIVE ─────────────────────────
  it("(b) WITHDRAWAL €1,000 with cost override → stored NEGATIVE pair", async () => {
    // First deposit €5,000 so the withdrawal has funds.
    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "deposit", quantity: 5000, cost: { amount: 5000, currency: "EUR" } },
    );
    expect((await latestByEntity(alphaId)).cashflow_amount_eur).not.toBeNull();

    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "withdrawal", quantity: 1000, cost: { amount: 1000, currency: "EUR" } },
    );
    // Balance 5,000 − 1,000 = 4,000.
    const { data: acct } = await client
      .from("cash_accounts")
      .select("balance")
      .eq("id", alphaId)
      .single();
    expect(Number(acct!.balance)).toBe(4000);

    // Withdrawal is an OUTFLOW: eur = −1,000 ; usd = −1,100. cashflow_user_set true.
    const row = await latestByEntity(alphaId);
    expect(Number(row.cashflow_amount_eur)).toBe(-1000);
    expect(Number(row.cashflow_amount_usd)).toBe(-1100);
    expect(row.cashflow_user_set).toBe(true);
    expect(row.is_adjustment).toBe(false);
  });

  // ─── (c-deposit) DEPOSIT with a cost override → POSITIVE (regression) ───────
  it("(c) DEPOSIT €2,000 with cost override → stored POSITIVE pair", async () => {
    await addTransaction(
      { class: "cash", accountId: alphaId },
      { type: "deposit", quantity: 2000, cost: { amount: 2000, currency: "EUR" } },
    );
    const row = await latestByEntity(alphaId);
    expect(Number(row.cashflow_amount_eur)).toBe(2000);
    expect(Number(row.cashflow_amount_usd)).toBe(2200); // 2000 × 1.10
    expect(row.cashflow_user_set).toBe(true);
  });

  // ─── (e) editor-style adjustment override on a qty-DECREASE → delta NEGATIVE ─
  it("(e) adjustment cost edit on a qty-decrease row → delta_* stored NEGATIVE", async () => {
    // Build an ADJUSTMENT row whose snapshots encode a quantity DROP (0.12 → 0.10):
    // is_adjustment=true so editTransaction writes the delta side. We insert it
    // directly with snapshots so quantityDelta(row) resolves to −0.02 (< 0).
    const { data: adjRow, error: insErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_id: cryptoAssetId,
        entity_name: "BTC",
        description: "qty-decrease adjustment",
        is_adjustment: true,
        before_snapshot: { quantity: 0.12 },
        after_snapshot: { quantity: 0.1 },
        delta_usd: 100, // stale wrong-sign placeholder the edit must overwrite
        delta_eur: 90,
        delta_status: "complete",
      })
      .select("id")
      .single();
    if (insErr) throw new Error("adj insert: " + insErr.message);

    const res = await editTransaction(adjRow!.id, {
      cost: { amount: 500, currency: "EUR" },
    });
    expect(res.success).toBe(true);

    // The qty delta is −0.02 (< 0) → direction −1. Magnitude €500 → usd 550.
    // delta stored NEGATIVE; cashflow side nulled (adjustment branch).
    const { data: row } = await client
      .from("activity_log")
      .select("delta_usd, delta_eur, delta_status, cashflow_amount_usd, cashflow_status")
      .eq("id", adjRow!.id)
      .single();
    expect(Number(row!.delta_eur)).toBe(-500);
    expect(Number(row!.delta_usd)).toBe(-550); // −round2(500 × 1.10)
    expect(row!.delta_status).toBe("complete");
    expect(row!.cashflow_amount_usd).toBeNull();
    expect(row!.cashflow_status).toBeNull();
  });
});
