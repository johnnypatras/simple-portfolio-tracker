import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for original_amount / original_currency stamping
 * (migration 023, spec 2026-06-11-currency-uniform-fix-design v2).
 *
 * The original travels BESIDE the FX result: cash-account mutations stamp the
 * face-value balance delta (account-resolved — fully known server-side from
 * the account row) in the account's own currency; market-derived rows (e.g. a
 * position upsert without a user-entered cost) leave both columns NULL.
 * Magnitudes are positive — direction lives in the signed cashflow/delta
 * columns.
 *
 * Strategy (mirrors crypto-actions.test.ts): mock `createServerSupabaseClient`
 * to return the test user's RLS-authed client, then call the actual server
 * actions against the real local Supabase instance.
 */

// ─── Hoisted mock state ─────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
}));

// ─── Module mocks (hoisted before imports) ──────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/prices/coingecko", () => ({
  getPrices: vi.fn(async () => ({})),
  getCoinImage: vi.fn(async () => null),
}));

vi.mock("@/lib/prices/yahoo", () => ({
  getStockPrices: vi.fn(async () => ({})),
}));

vi.mock("@/lib/prices/fx", () => ({
  getFXRates: vi.fn(async (_base: string, targets: string[]) => {
    const rates: Record<string, number> = {};
    for (const t of targets) {
      if (t === "USD") rates.USD = 1.11;
      else if (t === "EUR") rates.EUR = 0.90;
      else rates[t] = 1;
    }
    return rates;
  }),
  getFXRatesSafe: vi.fn(async () => ({ USD: 1.11, EUR: 1 })),
}));

// ─── Import server actions (resolved against mocks) ─────────
import {
  createCashAccount,
  updateCashAccount,
} from "@/lib/actions/cash-accounts";
import { upsertPosition } from "@/lib/actions/crypto";

// ─── Tests ──────────────────────────────────────────────────
describe("original_amount / original_currency stamping (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let institutionId: string;
  let gbpAccountId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    hoisted.testClient = client;

    const { data: inst, error } = await client
      .from("institutions")
      .insert({ user_id: userId, name: "Original-Currency-Bank" })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create test institution: " + error.message);
    institutionId = inst!.id;
  });

  afterAll(() => cleanup());

  it("createCashAccount stamps the initial balance as the original (GBP face value)", async () => {
    gbpAccountId = await createCashAccount({
      institution_id: institutionId,
      name: "Original GBP",
      currency: "GBP",
      balance: 500,
    });

    const { data: logs, error } = await client
      .from("activity_log")
      .select("original_amount, original_currency, cashflow_status")
      .eq("entity_id", gbpAccountId)
      .eq("entity_table", "cash_accounts")
      .eq("action", "created");

    expect(error).toBeNull();
    expect(logs).toHaveLength(1);
    expect(Number(logs![0].original_amount)).toBe(500);
    expect(logs![0].original_currency).toBe("GBP");
  });

  it("deposit (balance increase) stamps the face delta as a positive magnitude", async () => {
    // 500 → 800: face delta +300 GBP
    await updateCashAccount(gbpAccountId, { balance: 800 });

    const { data: logs, error } = await client
      .from("activity_log")
      .select("original_amount, original_currency, is_adjustment")
      .eq("entity_id", gbpAccountId)
      .eq("action", "updated")
      .eq("is_adjustment", false);

    expect(error).toBeNull();
    expect(logs).toHaveLength(1);
    expect(Number(logs![0].original_amount)).toBe(300);
    expect(logs![0].original_currency).toBe("GBP");
  });

  it("adjustment update stamps the original too (account-resolved, abs magnitude)", async () => {
    // 800 → 750: face delta −50 GBP, stored as magnitude 50
    await updateCashAccount(gbpAccountId, { balance: 750 }, { isAdjustment: true });

    const { data: logs, error } = await client
      .from("activity_log")
      .select("original_amount, original_currency, delta_status")
      .eq("entity_id", gbpAccountId)
      .eq("action", "updated")
      .eq("is_adjustment", true);

    expect(error).toBeNull();
    expect(logs).toHaveLength(1);
    expect(Number(logs![0].original_amount)).toBe(50);
    expect(logs![0].original_currency).toBe("GBP");
  });

  it("zero-delta update (rename, no money movement) leaves originals NULL", async () => {
    await updateCashAccount(gbpAccountId, { name: "Renamed GBP" });

    const { data: logs, error } = await client
      .from("activity_log")
      .select("original_amount, original_currency")
      .eq("entity_id", gbpAccountId)
      .eq("action", "updated")
      .eq("after_snapshot->>name", "Renamed GBP");

    expect(error).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs![0].original_amount).toBeNull();
    expect(logs![0].original_currency).toBeNull();
  });

  it("crypto upsertPosition without cost and without original leaves originals NULL", async () => {
    const { data: wallet, error: walletErr } = await client
      .from("wallets")
      .insert({ user_id: userId, name: "Original-Test-Wallet", wallet_type: "custodial" })
      .select("id")
      .single();
    if (walletErr) throw new Error("Failed to create test wallet: " + walletErr.message);

    const { data: asset, error: assetErr } = await client
      .from("crypto_assets")
      .insert({
        user_id: userId,
        ticker: "BTC",
        name: "Bitcoin",
        coingecko_id: "bitcoin-original-test-" + Date.now(),
      })
      .select("id")
      .single();
    if (assetErr) throw new Error("Failed to create test asset: " + assetErr.message);

    await upsertPosition({
      crypto_asset_id: asset!.id,
      wallet_id: wallet!.id,
      quantity: 1.5,
    });

    const { data: pos } = await client
      .from("crypto_positions")
      .select("id")
      .eq("crypto_asset_id", asset!.id)
      .eq("wallet_id", wallet!.id)
      .is("deleted_at", null)
      .single();
    expect(pos).not.toBeNull();

    const { data: logs, error } = await client
      .from("activity_log")
      .select("original_amount, original_currency")
      .eq("entity_id", pos!.id)
      .eq("entity_type", "crypto_position")
      .eq("action", "created");

    expect(error).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs![0].original_amount).toBeNull();
    expect(logs![0].original_currency).toBeNull();
  });
});
