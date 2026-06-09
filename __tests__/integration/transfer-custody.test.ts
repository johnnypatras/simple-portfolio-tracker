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

describe("executeTransfer new-wallet custody (integration)", () => {
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

  // A single-legged buy (source undefined) that mints both a new asset and a new
  // wallet — the destination.walletId is "PENDING" and Step 0's createWallet
  // patches it. We only assert the created wallet's custody type here.
  async function buyIntoNewWallet(walletType?: "custodial" | "non_custodial") {
    const coingeckoId = `xfer-cust-${randomUUID()}`;
    const name = `Xfer Wallet ${randomUUID().slice(0, 6)}`;
    const res = await executeTransfer({
      mode: "buy",
      source: undefined,
      destination: { type: "crypto_position", assetId: "PENDING", walletId: "PENDING", quantity: 1 },
      newCryptoAsset: { ticker: "XC", name: "Xfer Coin", coingecko_id: coingeckoId },
      newWallet: walletType ? { name, wallet_type: walletType } : { name },
    });
    expect(res.success).toBe(true);
    const { data: w } = await client
      .from("wallets")
      .select("wallet_type")
      .eq("user_id", userId)
      .eq("name", name)
      .is("deleted_at", null)
      .single();
    return w!.wallet_type;
  }

  it("defaults to custodial when newWallet.wallet_type is omitted", async () => {
    expect(await buyIntoNewWallet()).toBe("custodial");
  });

  it("honors newWallet.wallet_type: 'non_custodial'", async () => {
    expect(await buyIntoNewWallet("non_custodial")).toBe("non_custodial");
  });

  // The toolbar-Buy TRACKED route (1b-2b-ii-b): pay with a tracked cash account,
  // mint a new asset + new self-custody wallet. Both legs must be S&P-neutral.
  it("tracked new-asset buy: cash source funds it, custody threads, both legs neutral", async () => {
    // `name` satisfies chk_bank_requires_name (needs wallet_id | broker_id | name).
    const { data: cash, error: cashErr } = await client
      .from("cash_accounts")
      .insert({ user_id: userId, currency: "EUR", balance: 1000, name: "Test Cash EUR" })
      .select("id")
      .single();
    if (cashErr) throw new Error("cash insert failed: " + cashErr.message);
    const coingeckoId = `tracked-buy-${randomUUID()}`;
    const walletName = `Tracked SC ${randomUUID().slice(0, 6)}`;
    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cash!.id, amount: 200 },
      destination: { type: "crypto_position", assetId: "PENDING", walletId: "PENDING", quantity: 3 },
      newCryptoAsset: { ticker: "TRK", name: "Tracked Coin", coingecko_id: coingeckoId },
      newWallet: { name: walletName, wallet_type: "non_custodial" },
    });
    expect(res.success).toBe(true);

    // New asset + position at the transacted qty.
    const { data: asset } = await client
      .from("crypto_assets").select("id").eq("user_id", userId)
      .eq("coingecko_id", coingeckoId).is("deleted_at", null).single();
    expect(asset).not.toBeNull();
    const { data: pos } = await client
      .from("crypto_positions").select("id, quantity")
      .eq("crypto_asset_id", asset!.id).is("deleted_at", null).single();
    expect(Number(pos!.quantity)).toBe(3);

    // New wallet got the chosen custody.
    const { data: w } = await client
      .from("wallets").select("wallet_type").eq("user_id", userId)
      .eq("name", walletName).is("deleted_at", null).single();
    expect(w!.wallet_type).toBe("non_custodial");

    // Cash debited by the buy amount.
    const { data: cashAfter } = await client
      .from("cash_accounts").select("balance").eq("id", cash!.id).single();
    expect(Number(cashAfter!.balance)).toBe(800);

    // BOTH legs are adjustments → transfers are S&P-neutral (no contribution).
    const { data: posLog } = await client
      .from("activity_log").select("is_adjustment")
      .eq("entity_id", pos!.id).eq("entity_table", "crypto_positions").single();
    expect(posLog!.is_adjustment).toBe(true);
    // The cash debit leg must ALSO be neutral — a dropped flag here would make the
    // cash outflow count in the benchmark.
    const { data: cashLog } = await client
      .from("activity_log").select("is_adjustment")
      .eq("entity_id", cash!.id).eq("entity_table", "cash_accounts").single();
    expect(cashLog!.is_adjustment).toBe(true);
  });

  // Group-C extras on the TRACKED route: a tracked crypto buy carrying apy +
  // acquisitionMethod must thread them onto the freshly-created crypto position
  // (apy/acquisition_method are crypto-only). Mirrors the cash-funded buy above.
  it("tracked new-asset buy: apy + acquisition_method thread onto the new crypto position", async () => {
    const { data: cash, error: cashErr } = await client
      .from("cash_accounts")
      .insert({ user_id: userId, currency: "EUR", balance: 1000, name: "Test Cash GroupC" })
      .select("id")
      .single();
    if (cashErr) throw new Error("cash insert failed: " + cashErr.message);
    const coingeckoId = `tracked-groupc-${randomUUID()}`;
    const walletName = `Tracked GC ${randomUUID().slice(0, 6)}`;
    const res = await executeTransfer({
      mode: "buy",
      source: { type: "cash_account", accountId: cash!.id, amount: 150 },
      destination: { type: "crypto_position", assetId: "PENDING", walletId: "PENDING", quantity: 4 },
      newCryptoAsset: { ticker: "TGC", name: "Tracked GC Coin", coingecko_id: coingeckoId },
      newWallet: { name: walletName, wallet_type: "non_custodial" },
      apy: 12.5,
      acquisitionMethod: "staked",
    });
    expect(res.success).toBe(true);

    const { data: asset } = await client
      .from("crypto_assets").select("id").eq("user_id", userId)
      .eq("coingecko_id", coingeckoId).is("deleted_at", null).single();
    expect(asset).not.toBeNull();

    // The new position persisted the threaded apy + acquisition_method.
    const { data: pos } = await client
      .from("crypto_positions").select("apy, acquisition_method, quantity")
      .eq("crypto_asset_id", asset!.id).is("deleted_at", null).single();
    expect(Number(pos!.quantity)).toBe(4);
    expect(Number(pos!.apy)).toBe(12.5);
    expect(pos!.acquisition_method).toBe("staked");
  });
});
