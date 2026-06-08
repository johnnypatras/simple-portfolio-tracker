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
});
