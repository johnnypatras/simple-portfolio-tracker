import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

const hoisted = vi.hoisted(() => ({ testClient: null as SupabaseClient | null }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// LOW market price for ANY coingecko id → market value ≠ cost paid. A buy of
// 25 units at this market price values the position at ~$24.75 / €21.49, which
// must NOT be what lands in delta_* once the fix books cost = amount-paid.
vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { usd: 0.99, eur: 0.86 }])),
  ),
  getCoinImage: vi.fn(async () => null),
}));
vi.mock("@/lib/prices/yahoo", () => ({ getStockPrices: vi.fn(async () => ({})) }));
vi.mock("@/lib/prices/historical", () => ({
  fetchYahooDailyHistory: vi.fn(async () => []),
  fetchFxUsdPivotHistory: vi.fn(async () => []),
}));
// EUR→USD rate 1.1 (so €100 → $110, €300 → $330). The cost-override path calls
// toUsdAndEur(amount, "EUR", date) → getFXRates("EUR", ["USD"], date) → { USD: 1.1 }.
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

describe("executeTransfer valuation contract — cost = amount paid, not market (integration)", () => {
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

  /** Seed a EUR cash account (name satisfies chk_bank_requires_name). */
  async function seedCash(balance: number): Promise<string> {
    const { data, error } = await client
      .from("cash_accounts")
      .insert({ user_id: userId, currency: "EUR", balance, name: "VC Cash" })
      .select("id")
      .single();
    if (error) throw new Error("cash insert failed: " + error.message);
    return data!.id;
  }

  // ─── (A) tracked BUY: cost = €100 paid, NOT ~€21 market ───────────────────
  it("tracked buy books cost = cash paid (delta_eur=100), not market", async () => {
    const cashId = await seedCash(1000);
    const coingeckoId = `vc-buy-${randomUUID()}`;
    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cashId, amount: 100 },
      destination: { type: "crypto_position", assetId: "PENDING", walletId: "PENDING", quantity: 25 },
      newCryptoAsset: { ticker: "VCB", name: "VC Buy", coingecko_id: coingeckoId },
      newWallet: { name: `VC W ${randomUUID().slice(0, 6)}` },
    });
    expect(res.success).toBe(true);

    // New asset + its position.
    const { data: asset } = await client
      .from("crypto_assets")
      .select("id")
      .eq("user_id", userId)
      .eq("coingecko_id", coingeckoId)
      .is("deleted_at", null)
      .single();
    expect(asset).not.toBeNull();
    const { data: pos } = await client
      .from("crypto_positions")
      .select("id, quantity")
      .eq("crypto_asset_id", asset!.id)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBe(25);

    // The POSITION leg's delta must equal the CASH paid (€100 → $110), NOT the
    // market value (25 × €0.86 = €21.50). is_adjustment stays true (S&P-neutral).
    const { data: posLog } = await client
      .from("activity_log")
      .select("delta_usd, delta_eur, is_adjustment")
      .eq("entity_id", pos!.id)
      .eq("entity_table", "crypto_positions")
      .single();
    expect(Number(posLog!.delta_eur)).toBe(100);
    expect(Number(posLog!.delta_usd)).toBeCloseTo(110, 2);
    expect(posLog!.is_adjustment).toBe(true);

    // Cash debited by the buy amount.
    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", cashId).single();
    expect(Number(cashAfter!.balance)).toBe(900);
  });

  // ─── (B) tracked SELL: proceeds = cash received, NOT market ───────────────
  // Self-contained: mint a priced position via a buy first, then sell part of it
  // into a cash account and assert the SELL leg books the cash received.
  it("tracked sell books proceeds = cash received (|delta_eur|=300), not market", async () => {
    const buyCashId = await seedCash(1000);
    const coingeckoId = `vc-sell-${randomUUID()}`;

    // Buy 50 units for €400 → position exists at qty 50.
    const buyRes = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: buyCashId, amount: 400 },
      destination: { type: "crypto_position", assetId: "PENDING", walletId: "PENDING", quantity: 50 },
      newCryptoAsset: { ticker: "VCS", name: "VC Sell", coingecko_id: coingeckoId },
      newWallet: { name: `VC SW ${randomUUID().slice(0, 6)}` },
    });
    expect(buyRes.success).toBe(true);

    const { data: asset } = await client
      .from("crypto_assets")
      .select("id")
      .eq("user_id", userId)
      .eq("coingecko_id", coingeckoId)
      .is("deleted_at", null)
      .single();
    const { data: pos } = await client
      .from("crypto_positions")
      .select("id, quantity, wallet_id")
      .eq("crypto_asset_id", asset!.id)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBe(50);

    // Destination cash account that receives the sale proceeds.
    const proceedsCashId = await seedCash(0);

    // Sell 25 units; €300 lands in the cash account.
    const sellRes = await executeTransfer({
      mode: "sell",
      source: { type: "crypto_position", assetId: asset!.id, walletId: pos!.wallet_id, quantity: 25 },
      destination: { type: "cash_account", accountId: proceedsCashId, amount: 300 },
    });
    expect(sellRes.success).toBe(true);

    // Position reduced to 25.
    const { data: posAfter } = await client
      .from("crypto_positions")
      .select("quantity")
      .eq("id", pos!.id)
      .is("deleted_at", null)
      .single();
    expect(Number(posAfter!.quantity)).toBe(25);

    // The SELL position leg (transfer-tagged) must book proceeds = cash received
    // (€300 → $330), NOT market (25 × €0.86 = €21.50). Disposal → negative delta.
    const { data: sellLeg } = await client
      .from("activity_log")
      .select("delta_usd, delta_eur, is_adjustment")
      .eq("entity_id", pos!.id)
      .eq("entity_table", "crypto_positions")
      .eq("transfer_group_id", sellRes.transferGroupId)
      .single();
    expect(Math.abs(Number(sellLeg!.delta_eur))).toBe(300);
    expect(Math.abs(Number(sellLeg!.delta_usd))).toBeCloseTo(330, 2);
    expect(sellLeg!.is_adjustment).toBe(true);

    // Cash credited by the proceeds.
    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", proceedsCashId).single();
    expect(Number(cashAfter!.balance)).toBe(300);
  });
});
