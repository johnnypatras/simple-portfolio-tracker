import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for cashflow/delta backfill pipeline columns.
 *
 * These tests verify DB-level column storage, status transitions, and query
 * patterns used by the backfill server action (src/lib/actions/backfill.ts).
 * They insert directly into activity_log — no price API mocking needed.
 *
 * Columns tested:
 *   cashflow_status, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class,
 *   cashflow_attempted_at, delta_status, delta_usd, delta_eur, delta_attempted_at
 *
 * The SECOND suite ("auto-retry of failed rows") drives the REAL
 * backfillCashflowsAndDeltas() server action against local Supabase, mocking
 * createServerSupabaseClient + the FX module (strategy mirrors cashflow-sign.test.ts).
 * It proves the BATCH SELECT now re-picks throttle-eligible `failed` rows.
 */

// ─── Hoisted mock state (consumed by the file-level vi.mock factories) ───────
// The first suite uses the raw RLS client directly and is unaffected by these
// mocks; only the action-driven suite reads them.
const hoisted = vi.hoisted(() => ({
  testClient: null as SupabaseClient | null,
}));

// ─── Module mocks (file-wide — hoisted above all imports) ────────────────────
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => hoisted.testClient),
}));

// Fixed FX mock: 1 EUR = 1.10 USD. Cash-entity backfill calls toUsdAndEur which
// reads getFXRates — this makes the recompute deterministic with no network.
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

// ─── Imports after mocks ─────────────────────────────────────────────────────
import { backfillCashflowsAndDeltas } from "@/lib/actions/backfill";
describe("backfill pipeline columns (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
  });

  afterAll(() => cleanup());

  it("pending cashflow row — insert and query by cashflow_status filter", async () => {
    const { data, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "BTC position",
        description: "Bought 0.1 BTC",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id, cashflow_status")
      .single();

    expect(insertErr).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.cashflow_status).toBe("pending");

    // Query using the backfill scan pattern
    const { data: pending, error: queryErr } = await client
      .from("activity_log")
      .select("id, cashflow_status")
      .eq("user_id", userId)
      .eq("cashflow_status", "pending")
      .eq("id", data!.id);

    expect(queryErr).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending![0].cashflow_status).toBe("pending");
  });

  it("pending delta row — insert and query by delta_status filter", async () => {
    const { data, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "ETH position",
        description: "Updated ETH quantity",
        is_adjustment: true,
        delta_status: "pending",
        cashflow_status: null,
      })
      .select("id, delta_status, cashflow_status")
      .single();

    expect(insertErr).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.delta_status).toBe("pending");
    expect(data!.cashflow_status).toBeNull();

    // Query using the delta backfill scan pattern
    const { data: pending, error: queryErr } = await client
      .from("activity_log")
      .select("id, delta_status")
      .eq("user_id", userId)
      .eq("delta_status", "pending")
      .eq("id", data!.id);

    expect(queryErr).toBeNull();
    expect(pending).toHaveLength(1);
    expect(pending![0].delta_status).toBe("pending");
  });

  it("cashflow status transition — pending to complete with amounts", async () => {
    // Insert a pending row
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "stock_position",
        entity_name: "AAPL position",
        description: "Bought 10 AAPL",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to complete (as backfill does after price lookup)
    const now = new Date().toISOString();
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        cashflow_amount_usd: 1500.5,
        cashflow_amount_eur: 1350.45,
        cashflow_asset_class: "stocks",
        cashflow_status: "complete",
        cashflow_attempted_at: now,
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify all columns stored correctly
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select(
        "cashflow_status, cashflow_amount_usd, cashflow_amount_eur, cashflow_asset_class, cashflow_attempted_at"
      )
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.cashflow_status).toBe("complete");
    expect(Number(updated!.cashflow_amount_usd)).toBe(1500.5);
    expect(Number(updated!.cashflow_amount_eur)).toBe(1350.45);
    expect(updated!.cashflow_asset_class).toBe("stocks");
    expect(updated!.cashflow_attempted_at).not.toBeNull();
  });

  it("delta status transition — pending to complete with values", async () => {
    // Insert a pending delta row
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "crypto_position",
        entity_name: "SOL position",
        description: "Portfolio correction",
        is_adjustment: true,
        delta_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to complete
    const now = new Date().toISOString();
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        delta_usd: 250.75,
        delta_eur: 225.68,
        delta_status: "complete",
        delta_attempted_at: now,
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("delta_status, delta_usd, delta_eur, delta_attempted_at")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.delta_status).toBe("complete");
    expect(Number(updated!.delta_usd)).toBe(250.75);
    expect(Number(updated!.delta_eur)).toBe(225.68);
    expect(updated!.delta_attempted_at).not.toBeNull();
  });

  it("failed status — cashflow_status set to failed after exhausted retries", async () => {
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "DOGE position",
        description: "Bought DOGE",
        is_adjustment: false,
        cashflow_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    // Transition to failed (as backfill does after MAX_DAYS_BEFORE_EXHAUSTED)
    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        cashflow_amount_usd: 0,
        cashflow_amount_eur: 0,
        cashflow_status: "failed",
        cashflow_attempted_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    // Verify
    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("cashflow_status, cashflow_amount_usd")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.cashflow_status).toBe("failed");
    expect(Number(updated!.cashflow_amount_usd)).toBe(0);
  });

  it("failed delta_status — stored correctly", async () => {
    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "TSLA position",
        description: "Portfolio correction on TSLA",
        is_adjustment: true,
        delta_status: "pending",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const rowId = row!.id;

    const { error: updateErr } = await client
      .from("activity_log")
      .update({
        delta_usd: 0,
        delta_eur: 0,
        delta_status: "failed",
        delta_attempted_at: new Date().toISOString(),
      })
      .eq("id", rowId);
    expect(updateErr).toBeNull();

    const { data: updated, error: readErr } = await client
      .from("activity_log")
      .select("delta_status, delta_usd")
      .eq("id", rowId)
      .single();

    expect(readErr).toBeNull();
    expect(updated!.delta_status).toBe("failed");
  });

  it("throttle gate — cashflow_attempted_at is writable and queryable", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "ADA position",
        description: "Bought ADA",
        is_adjustment: false,
        cashflow_status: "pending",
        cashflow_attempted_at: pastDate,
      })
      .select("id, cashflow_attempted_at")
      .single();
    expect(insertErr).toBeNull();
    expect(row!.cashflow_attempted_at).not.toBeNull();

    // Verify: the backfill throttle query pattern works.
    // Rows with cashflow_attempted_at older than the throttle window are eligible.
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id, cashflow_attempted_at")
      .eq("id", row!.id)
      .eq("cashflow_status", "pending")
      .lt("cashflow_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(1);
    expect(eligible![0].id).toBe(row!.id);
  });

  it("throttle gate — delta_attempted_at is writable and queryable", async () => {
    const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "stock_position",
        entity_name: "NVDA position",
        description: "Correction on NVDA",
        is_adjustment: true,
        delta_status: "pending",
        delta_attempted_at: pastDate,
      })
      .select("id, delta_attempted_at")
      .single();
    expect(insertErr).toBeNull();
    expect(row!.delta_attempted_at).not.toBeNull();

    // Verify: delta throttle query finds rows past the window
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id, delta_attempted_at")
      .eq("id", row!.id)
      .eq("delta_status", "pending")
      .lt("delta_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(1);
    expect(eligible![0].id).toBe(row!.id);
  });

  it("recently-attempted rows are excluded by throttle query", async () => {
    const recentDate = new Date().toISOString(); // just now

    const { data: row, error: insertErr } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "crypto_position",
        entity_name: "XRP position",
        description: "Bought XRP",
        is_adjustment: false,
        cashflow_status: "pending",
        cashflow_attempted_at: recentDate,
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();

    // This row was attempted just now — it should NOT appear in the throttle query
    const throttleDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: eligible, error: queryErr } = await client
      .from("activity_log")
      .select("id")
      .eq("id", row!.id)
      .eq("cashflow_status", "pending")
      .lt("cashflow_attempted_at", throttleDate);

    expect(queryErr).toBeNull();
    expect(eligible).toHaveLength(0);
  });
});

/**
 * Auto-retry of FAILED rows by the BATCH backfill.
 *
 * A row escalates to cashflow_status/delta_status = 'failed' only after ≥3 days
 * of throttled retries where both the FX API and the snapshot fallback failed.
 * Previously the BATCH SELECT queries excluded 'failed' entirely, so such rows
 * were STRANDED (a failed cashflow contributes 0 to the S&P benchmark — silently
 * wrong) even once data became available. The fix folds 'failed' into the same
 * throttled set as 'pending'. These tests prove the SELECT now re-picks
 * throttle-eligible failed rows (and still honours the throttle for recent ones).
 *
 * We use bank_account rows: the backfill's cash-entity branch computes the value
 * from before/after snapshots + toUsdAndEur (the mocked FX above), so the recompute
 * resolves deterministically with NO network and NO price-history dependency.
 */
describe("backfill auto-retry of failed rows (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;

  // ~25h ago → older than THROTTLE_MS (24h): throttle-eligible.
  const eligibleAttemptedAt = new Date(
    Date.now() - 25 * 60 * 60 * 1000
  ).toISOString();
  // ~1h ago → inside the throttle window: must be skipped.
  const recentAttemptedAt = new Date(
    Date.now() - 1 * 60 * 60 * 1000
  ).toISOString();

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;
    // Route the server action's createServerSupabaseClient() to this RLS client.
    hoisted.testClient = client;
  });

  afterAll(() => cleanup());

  /** Seed a cashflow-producing FAILED bank_account row (deposit of 1000 EUR). */
  async function seedFailedCashflowRow(attemptedAt: string): Promise<string> {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "created",
        entity_type: "bank_account",
        entity_name: "Failed-cashflow bank account",
        description: "Deposit 1000 EUR",
        is_adjustment: false,
        cashflow_user_set: false,
        undone_at: null,
        before_snapshot: null,
        after_snapshot: { balance: 1000, currency: "EUR" },
        cashflow_status: "failed",
        cashflow_amount_usd: 0,
        cashflow_amount_eur: 0,
        cashflow_attempted_at: attemptedAt,
      })
      .select("id")
      .single();
    if (error) throw new Error("seedFailedCashflowRow: " + error.message);
    return data!.id as string;
  }

  /**
   * Seed a delta-only FAILED bank_account row. cashflow_status='complete' +
   * is_adjustment=true keep it OUT of the cashflow batch, so only the delta
   * query can pick it up — isolating the delta SELECT change.
   */
  async function seedFailedDeltaRow(attemptedAt: string): Promise<string> {
    const { data, error } = await client
      .from("activity_log")
      .insert({
        user_id: userId,
        action: "updated",
        entity_type: "bank_account",
        entity_name: "Failed-delta bank account",
        description: "Adjust balance to 500 EUR",
        is_adjustment: true,
        undone_at: null,
        before_snapshot: { balance: 0, currency: "EUR" },
        after_snapshot: { balance: 500, currency: "EUR" },
        cashflow_status: "complete",
        delta_status: "failed",
        delta_usd: 0,
        delta_eur: 0,
        delta_attempted_at: attemptedAt,
      })
      .select("id")
      .single();
    if (error) throw new Error("seedFailedDeltaRow: " + error.message);
    return data!.id as string;
  }

  it("throttle-eligible FAILED cashflow row is re-processed (healed to complete)", async () => {
    const rowId = await seedFailedCashflowRow(eligibleAttemptedAt);

    await backfillCashflowsAndDeltas();

    const { data: updated, error } = await client
      .from("activity_log")
      .select(
        "cashflow_status, cashflow_amount_usd, cashflow_amount_eur, cashflow_attempted_at"
      )
      .eq("id", rowId)
      .single();

    expect(error).toBeNull();
    // Recomputed: deposit 1000 EUR → 1000 EUR / 1100 USD (mocked 1 EUR = 1.10 USD).
    expect(updated!.cashflow_status).toBe("complete");
    expect(Number(updated!.cashflow_amount_eur)).toBe(1000);
    expect(Number(updated!.cashflow_amount_usd)).toBe(1100);
    // attempted_at advanced past the seeded ~25h-ago timestamp → row WAS selected.
    expect(
      new Date(updated!.cashflow_attempted_at as string).getTime()
    ).toBeGreaterThan(new Date(eligibleAttemptedAt).getTime());
  });

  it("recently-attempted FAILED cashflow row is skipped (throttle holds)", async () => {
    const rowId = await seedFailedCashflowRow(recentAttemptedAt);

    await backfillCashflowsAndDeltas();

    const { data: untouched, error } = await client
      .from("activity_log")
      .select("cashflow_status, cashflow_amount_eur, cashflow_attempted_at")
      .eq("id", rowId)
      .single();

    expect(error).toBeNull();
    // Inside the throttle window → NOT selected: still failed, amount still 0,
    // attempted_at unchanged (compare by instant — Postgres serialises +00:00
    // where we seeded Z; same moment, different string).
    expect(untouched!.cashflow_status).toBe("failed");
    expect(Number(untouched!.cashflow_amount_eur)).toBe(0);
    expect(new Date(untouched!.cashflow_attempted_at as string).getTime()).toBe(
      new Date(recentAttemptedAt).getTime()
    );
  });

  it("throttle-eligible FAILED delta row is re-processed (healed to complete)", async () => {
    const rowId = await seedFailedDeltaRow(eligibleAttemptedAt);

    await backfillCashflowsAndDeltas();

    const { data: updated, error } = await client
      .from("activity_log")
      .select("delta_status, delta_usd, delta_eur, delta_attempted_at")
      .eq("id", rowId)
      .single();

    expect(error).toBeNull();
    // Recomputed: +500 EUR balance change → 500 EUR / 550 USD.
    expect(updated!.delta_status).toBe("complete");
    expect(Number(updated!.delta_eur)).toBe(500);
    expect(Number(updated!.delta_usd)).toBe(550);
    expect(
      new Date(updated!.delta_attempted_at as string).getTime()
    ).toBeGreaterThan(new Date(eligibleAttemptedAt).getTime());
  });

  it("recently-attempted FAILED delta row is skipped (throttle holds)", async () => {
    const rowId = await seedFailedDeltaRow(recentAttemptedAt);

    await backfillCashflowsAndDeltas();

    const { data: untouched, error } = await client
      .from("activity_log")
      .select("delta_status, delta_eur, delta_attempted_at")
      .eq("id", rowId)
      .single();

    expect(error).toBeNull();
    expect(untouched!.delta_status).toBe("failed");
    expect(Number(untouched!.delta_eur)).toBe(0);
    expect(new Date(untouched!.delta_attempted_at as string).getTime()).toBe(
      new Date(recentAttemptedAt).getTime()
    );
  });
});
