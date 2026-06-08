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
vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
}));
vi.mock("@/lib/prices/yahoo", () => ({ getStockPrices: vi.fn(async () => ({})) }));
// Match the reference harness exactly — kept as a no-op so a future backdated
// test can't silently hit the network via backdateActivityEntry.
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

import { addNewAssetTransaction } from "@/lib/actions/transactions";

describe("addNewAssetTransaction (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let walletId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Existing Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (error) throw new Error("wallet create failed: " + error.message);
    walletId = wallet!.id;
  });

  afterAll(() => cleanup());

  it("crypto new-money buy into an existing wallet books an S&P contribution", async () => {
    const coingeckoId = `newbuy-btc-${randomUUID()}`;
    const res = await addNewAssetTransaction({
      assetClass: "crypto",
      newCryptoAsset: { ticker: "NBTC", name: "New BTC", coingecko_id: coingeckoId },
      locationId: walletId,
      quantity: 2,
      cost: { amount: 200, currency: "EUR" },
    });
    expect(res.success).toBe(true);

    // Asset created
    const { data: asset } = await client
      .from("crypto_assets")
      .select("id")
      .eq("user_id", userId)
      .eq("coingecko_id", coingeckoId)
      .is("deleted_at", null)
      .single();
    expect(asset).not.toBeNull();

    // Position created at the transacted qty (capture its id for the log assertion)
    const { data: pos } = await client
      .from("crypto_positions")
      .select("id, quantity")
      .eq("crypto_asset_id", asset!.id)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBe(2);

    // The buy COUNTS in the S&P benchmark: real flow, complete, user-set cost.
    // The cashflow row is logged against the POSITION (`crypto_positions`, the
    // position id), NOT the asset — `upsertPosition` logs `entity_table:
    // "crypto_positions"` / `entity_id: position.id`. Filter on the position id
    // so the assertion is exact AND isolated (one freshly-created position → one
    // "created" row → `.single()` is safe; no cross-test "newest row" ambiguity).
    const { data: log } = await client
      .from("activity_log")
      .select("is_adjustment, cashflow_status, cashflow_user_set, cashflow_amount_eur")
      .eq("entity_id", pos!.id)
      .eq("entity_table", "crypto_positions")
      .single();
    expect(log!.is_adjustment).toBe(false);
    expect(log!.cashflow_status).toBe("complete");
    expect(log!.cashflow_user_set).toBe(true);
    expect(Number(log!.cashflow_amount_eur)).toBe(200);
  });
});
