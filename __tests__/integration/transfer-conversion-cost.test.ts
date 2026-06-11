import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for the transfer conversion-cost channel
 * (currency-uniform-fix Task 4, audit bug #1).
 *
 * A buy/sell funded through a tracked cash account must book the POSITION leg
 * at the REAL cash moved — converted once via `toUsdAndEur` at the effective
 * date and fed to the primitives' dual `cashflowOverride` channel — for ANY
 * ISO account currency. The former EUR/USD narrowing silently discarded a
 * foreign (e.g. GBP) cash amount and fell back to qty × market, corrupting
 * that asset's cost-basis P&L. Both legs are `is_adjustment=true`, so the
 * override must land in the DELTA columns, and the account-resolved original
 * {amount, currency} must be stamped on BOTH legs (the primitives' auto-stamp
 * only fires on the single-currency `cost` channel, which transfers no longer
 * use).
 *
 * FX mock: any base → USD 1.1, EUR 0.9091. Market mock: every coingecko id
 * prices at $100 / €91, so a regression to the market fallback books values
 * clearly distinct from the converted cash (e.g. 2 × $100 = $200 ≠ $550).
 *
 * Strategy (mirrors transfer-custody.test.ts): mock
 * `createServerSupabaseClient` to return the test user's RLS-authed client,
 * then call the real `executeTransfer` against local Supabase.
 */

const hoisted = vi.hoisted(() => ({ testClient: null as SupabaseClient | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/prices/coingecko", () => ({
  // Price EVERY requested id so the pre-fix market fallback produces a real
  // (wrong) value rather than a null delta — the sharpest possible contrast.
  getPrices: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { usd: 100, eur: 91 }]))
  ),
  getCoinImage: vi.fn(async () => null),
}));
vi.mock("@/lib/prices/yahoo", () => ({ getStockPrices: vi.fn(async () => ({})) }));
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(async () => []),
  fetchFxUsdPivotHistory: vi.fn(async () => []),
}));
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

import { executeTransfer } from "@/lib/actions/transfers";

describe("executeTransfer conversion cost — any-ISO cash funding (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;
  });

  afterAll(() => cleanup());

  async function createCash(currency: string, balance: number) {
    const { data, error } = await client
      .from("cash_accounts")
      .insert({ user_id: userId, currency, balance, name: `Conv ${currency} ${randomUUID().slice(0, 6)}` })
      .select("id")
      .single();
    if (error) throw new Error("cash insert failed: " + error.message);
    return data!.id as string;
  }

  async function createWalletAndAsset() {
    const { data: wallet, error: wErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: `Conv Wallet ${randomUUID().slice(0, 6)}`, wallet_type: "custodial" })
      .select("id")
      .single();
    if (wErr) throw new Error("wallet insert failed: " + wErr.message);
    const { data: asset, error: aErr } = await client
      .from("crypto_assets")
      .insert({ user_id: userId, ticker: "CNV", name: "Conv Coin", coingecko_id: `conv-${randomUUID()}` })
      .select("id")
      .single();
    if (aErr) throw new Error("asset insert failed: " + aErr.message);
    return { walletId: wallet!.id as string, assetId: asset!.id as string };
  }

  /** Fetch the single transfer leg logged against `entityTable`. */
  async function legRow(transferGroupId: string, entityTable: string) {
    const { data, error } = await client
      .from("activity_log")
      .select(
        "delta_usd, delta_eur, delta_status, cashflow_amount_usd, cashflow_amount_eur, is_adjustment, original_amount, original_currency"
      )
      .eq("transfer_group_id", transferGroupId)
      .eq("entity_table", entityTable);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    return data![0];
  }

  it("GBP-funded buy books the position leg at converted cash (not market) and stamps originals on BOTH legs", async () => {
    const cashId = await createCash("GBP", 1000);
    const { walletId, assetId } = await createWalletAndAsset();

    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cashId, amount: 500 },
      destination: { type: "crypto_position", assetId, walletId, quantity: 2 },
    });
    if (!res.success) throw new Error("transfer failed: " + res.error);

    // Position leg: toUsdAndEur(500, GBP) = {usd 550, eur 454.55} (round2'd),
    // acquisition-signed +. Market would be 2 × $100 = $200 / 2 × €91 = €182 —
    // the converted cash MUST win. Adjustment leg → values land in delta_*.
    const posLeg = await legRow(res.transferGroupId, "crypto_positions");
    expect(posLeg.is_adjustment).toBe(true);
    expect(posLeg.delta_status).toBe("complete");
    expect(Number(posLeg.delta_usd)).toBeCloseTo(550, 2);
    expect(Number(posLeg.delta_eur)).toBeCloseTo(454.55, 2);
    expect(posLeg.cashflow_amount_usd).toBeNull();
    expect(posLeg.cashflow_amount_eur).toBeNull();
    expect(Number(posLeg.original_amount)).toBe(500);
    expect(posLeg.original_currency).toBe("GBP");

    // Cash leg: account-resolved original face delta (Task-2 stamp carries
    // through the transfer path too).
    const cashLeg = await legRow(res.transferGroupId, "cash_accounts");
    expect(cashLeg.is_adjustment).toBe(true);
    expect(Number(cashLeg.original_amount)).toBe(500);
    expect(cashLeg.original_currency).toBe("GBP");

    // The cash actually left the account.
    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", cashId).single();
    expect(Number(cashAfter!.balance)).toBe(500);
  });

  it("EUR control: typed leg stays verbatim, sibling round2'd — byte-identical to the pre-change EUR path", async () => {
    const cashId = await createCash("EUR", 1000);
    const { walletId, assetId } = await createWalletAndAsset();

    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cashId, amount: 200 },
      destination: { type: "crypto_position", assetId, walletId, quantity: 1 },
    });
    if (!res.success) throw new Error("transfer failed: " + res.error);

    // EUR is the typed/account leg → stored EXACTLY (200); USD is the derived
    // sibling → round2(200 × 1.1) = 220. Exact equality guards the channel
    // switch against any regression from today's cost-channel behaviour.
    const posLeg = await legRow(res.transferGroupId, "crypto_positions");
    expect(posLeg.delta_status).toBe("complete");
    expect(Number(posLeg.delta_eur)).toBe(200);
    expect(Number(posLeg.delta_usd)).toBe(220);
    expect(Number(posLeg.original_amount)).toBe(200);
    expect(posLeg.original_currency).toBe("EUR");

    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", cashId).single();
    expect(Number(cashAfter!.balance)).toBe(800);
  });

  it("GBP sell mirror: position leg books converted proceeds, disposal-signed; originals on both legs", async () => {
    const cashId = await createCash("GBP", 100);
    const { walletId, assetId } = await createWalletAndAsset();
    const { error: posErr } = await client
      .from("crypto_positions")
      .insert({ crypto_asset_id: assetId, wallet_id: walletId, quantity: 5 });
    if (posErr) throw new Error("position insert failed: " + posErr.message);

    const res = await executeTransfer({
      mode: "sell",
      source: { type: "crypto_position", assetId, walletId, quantity: 2 },
      destination: { type: "cash_account", accountId: cashId, amount: 300 },
    });
    if (!res.success) throw new Error("transfer failed: " + res.error);

    // Disposal: toUsdAndEur(300, GBP) = {usd 330, eur 272.73}, signed − by the
    // qty drop. Market would be −2 × $100 = −$200. Original stays a positive
    // magnitude (direction lives in the signed delta columns).
    const posLeg = await legRow(res.transferGroupId, "crypto_positions");
    expect(posLeg.is_adjustment).toBe(true);
    expect(posLeg.delta_status).toBe("complete");
    expect(Number(posLeg.delta_usd)).toBeCloseTo(-330, 2);
    expect(Number(posLeg.delta_eur)).toBeCloseTo(-272.73, 2);
    expect(Number(posLeg.original_amount)).toBe(300);
    expect(posLeg.original_currency).toBe("GBP");

    const cashLeg = await legRow(res.transferGroupId, "cash_accounts");
    expect(Number(cashLeg.original_amount)).toBe(300);
    expect(cashLeg.original_currency).toBe("GBP");

    // Quantity reduced, proceeds landed.
    const { data: pos } = await client
      .from("crypto_positions").select("quantity")
      .eq("crypto_asset_id", assetId).eq("wallet_id", walletId)
      .is("deleted_at", null).single();
    expect(Number(pos!.quantity)).toBe(3);
    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", cashId).single();
    expect(Number(cashAfter!.balance)).toBe(400);
  });

  it("GBP-funded STOCK buy books the stock leg at converted cash too (same channel, stock primitive)", async () => {
    const cashId = await createCash("GBP", 1000);
    const { data: broker, error: bErr } = await client
      .from("brokers")
      .insert({ user_id: userId, name: `Conv Broker ${randomUUID().slice(0, 6)}` })
      .select("id")
      .single();
    if (bErr) throw new Error("broker insert failed: " + bErr.message);
    const { data: stockAsset, error: sErr } = await client
      .from("stock_assets")
      .insert({
        user_id: userId,
        ticker: "CNVS",
        name: "Conv Stock",
        yahoo_ticker: `CNVS-${randomUUID().slice(0, 6)}.DE`,
        currency: "EUR",
      })
      .select("id")
      .single();
    if (sErr) throw new Error("stock asset insert failed: " + sErr.message);

    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cashId, amount: 500 },
      destination: { type: "stock_position", assetId: stockAsset!.id, brokerId: broker!.id, quantity: 10 },
    });
    if (!res.success) throw new Error("transfer failed: " + res.error);

    const posLeg = await legRow(res.transferGroupId, "stock_positions");
    expect(posLeg.is_adjustment).toBe(true);
    expect(posLeg.delta_status).toBe("complete");
    expect(Number(posLeg.delta_usd)).toBeCloseTo(550, 2);
    expect(Number(posLeg.delta_eur)).toBeCloseTo(454.55, 2);
    expect(Number(posLeg.original_amount)).toBe(500);
    expect(posLeg.original_currency).toBe("GBP");
  });
});
