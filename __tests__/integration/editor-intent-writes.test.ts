import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration coverage for the C3 editor intent question's three write
 * shapes — all through EXISTING actions (no server changes in C3):
 *   1. Yes+free → addTransaction(type: "yield")  — counts, is_yield, cost 0
 *   2. No (cosmetic) → upsertPosition(isAdjustment: true) — off-book delta
 *   3. Metadata-only → upsertPosition(same qty)  — books no benchmark flow
 */

const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

vi.mock("@/lib/prices/fx", async (importOriginal) => {
  // Keep the real module shape (convertToBase etc.) — only stub the fetchers.
  const actual = await importOriginal<typeof import("@/lib/prices/fx")>();
  return {
    ...actual,
    getFXRates: vi.fn(async (_base: string, targets: string[]) => {
      const rates: Record<string, number> = {};
      for (const t of targets) {
        if (t === "USD") rates.USD = 1.11;
        else if (t === "EUR") rates.EUR = 0.9;
        else rates[t] = 1;
      }
      return rates;
    }),
    getFXRatesSafe: vi.fn(async () => ({ USD: 1.11, EUR: 1 })),
  };
});

import { upsertPosition } from "@/lib/actions/crypto";
import { addTransaction } from "@/lib/actions/transactions";

describe("editor intent writes (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let walletId: string;
  let assetId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: wallet, error: wErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Intent Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    expect(wErr).toBeNull();
    walletId = wallet!.id;

    const { data: asset, error: aErr } = await client
      .from("crypto_assets")
      .insert({ user_id: userId, ticker: "GHO", name: "GHO", coingecko_id: "gho" })
      .select("id")
      .single();
    expect(aErr).toBeNull();
    assetId = asset!.id;

    const { error: pErr } = await client.from("crypto_positions").insert({
      crypto_asset_id: assetId,
      wallet_id: walletId,
      quantity: 10,
      acquisition_method: "bought",
      apy: 0,
    });
    expect(pErr).toBeNull();
  });

  afterAll(() => cleanup());

  async function latestActivity() {
    const { data, error } = await client
      .from("activity_log")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  it("yield books is_yield, counted, at the chosen effective date", async () => {
    await addTransaction(
      { class: "crypto", assetId },
      { type: "yield", quantity: 5, effectiveDate: "2026-06-01", walletId },
    );

    const { data: pos } = await client
      .from("crypto_positions")
      .select("quantity")
      .eq("crypto_asset_id", assetId)
      .eq("wallet_id", walletId)
      .is("deleted_at", null)
      .single();
    expect(Number(pos!.quantity)).toBe(15);

    const row = await latestActivity();
    expect(row.is_yield).toBe(true);
    expect(row.is_adjustment).toBe(false);
    expect(row.effective_date).toContain("2026-06-01");
  });

  it("cosmetic save books an off-book adjustment (delta filled, no cashflow)", async () => {
    await upsertPosition(
      {
        crypto_asset_id: assetId,
        wallet_id: walletId,
        quantity: 20, // 15 → 20
        acquisition_method: "bought",
      },
      {
        isAdjustment: true,
        currentPriceUsd: 1.11,
        currentPriceEur: 1,
        effectiveDate: "2026-06-02",
      },
    );

    const row = await latestActivity();
    expect(row.is_adjustment).toBe(true);
    expect(row.cashflow_amount_eur).toBeNull();
    expect(Number(row.delta_eur)).toBeCloseTo(5); // +5 units × €1
    expect(row.effective_date).toContain("2026-06-02");
  });

  it("zero-delta metadata save books no benchmark flow", async () => {
    await upsertPosition(
      {
        crypto_asset_id: assetId,
        wallet_id: walletId,
        quantity: 20, // unchanged
        acquisition_method: "bought",
        apy: 4,
      },
      { currentPriceUsd: 1.11, currentPriceEur: 1 },
    );

    const row = await latestActivity();
    expect(row.is_adjustment).toBe(false);
    expect(Number(row.cashflow_amount_eur ?? 0)).toBe(0);
    expect(row.delta_eur).toBeNull();
  });
});
