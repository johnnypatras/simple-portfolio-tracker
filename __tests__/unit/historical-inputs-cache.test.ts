import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Unit tests for historical-inputs-cache.ts — the two request-cached + graceful
 * wrappers around fetchHistoricalPriceInputsFor:
 *
 *   • getHistoricalPriceInputs(userId)        — current-user / server-client path
 *   • getHistoricalPriceInputsForOwner(owner) — share / admin-client path
 *
 * The whole point of these wrappers (audit R1-C3 + R2-1) is graceful
 * degradation: a transient Yahoo/Frankfurter/historical_prices failure must NOT
 * throw — it must return empty inputs so the chart (including the PUBLIC share
 * link) degrades to literal snapshots instead of error-pinning the page. Each
 * failure path must also fire exactly one Sentry.captureException with a
 * context-tagged scope.
 *
 * Strategy: mock the underlying fetcher + both Supabase client factories +
 * Sentry, and mock `react` so cache() is an identity pass-through (each test
 * gets a fresh, non-memoised invocation — matching derive-cashflows-db.test.ts).
 * cache()'s actual request-dedup is a React-runtime concern, not unit-testable
 * here; these tests pin the degradation + pass-through + client-selection
 * contract the wrappers own.
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  // Configurable behaviour for the underlying fetcher per test.
  fetchImpl: null as
    | ((client: unknown, userId: string) => Promise<unknown>)
    | null,
}));

// ─── Module mocks (hoisted before imports) ───────────────────────────────────

// Strip React.cache() memoisation so each test gets a fresh invocation.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

// Sentinel client objects so we can assert WHICH factory each wrapper used and
// that the chosen client is the one handed to the fetcher.
const ADMIN_CLIENT = { __kind: "admin" } as const;
const SERVER_CLIENT = { __kind: "server" } as const;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ADMIN_CLIENT),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => SERVER_CLIENT),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// Only fetchHistoricalPriceInputsFor needs to be controllable; the type exports
// (HistoricalLot/HistoricalPriceRow) are erased at runtime and don't need stubs.
vi.mock("@/lib/portfolio/historical-prices-augmentation", () => ({
  fetchHistoricalPriceInputsFor: vi.fn(
    (client: unknown, userId: string) => hoisted.fetchImpl!(client, userId),
  ),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────
import {
  getHistoricalPriceInputs,
  getHistoricalPriceInputsForOwner,
} from "@/lib/actions/historical-inputs-cache";
import { fetchHistoricalPriceInputsFor } from "@/lib/portfolio/historical-prices-augmentation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import * as Sentry from "@sentry/nextjs";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_INPUTS = {
  lots: [{ id: "lot-1", deltas: [{ effective_date: "2024-01-01" }] }],
  prices: [{ symbol: "BTC", date: "2024-01-01", price_usd: 42000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.fetchImpl = null;
});

// ─── getHistoricalPriceInputsForOwner (share / admin path) ───────────────────
describe("getHistoricalPriceInputsForOwner (share / admin path)", () => {
  it("returns empty inputs (never throws) when the fetcher rejects, and reports to Sentry", async () => {
    const boom = new Error("Yahoo timeout");
    hoisted.fetchImpl = vi.fn().mockRejectedValue(boom);

    const result = await getHistoricalPriceInputsForOwner(OWNER_ID);

    // Graceful degradation: the public share link must NOT be error-pinned.
    expect(result).toEqual({ lots: [], prices: [] });

    // Exactly one capture, with the owner-path context tag.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, {
      tags: {
        context: "historical-inputs-cache.getHistoricalPriceInputsForOwner",
      },
    });
  });

  it("does not throw when the fetcher rejects", async () => {
    hoisted.fetchImpl = vi.fn().mockRejectedValue(new Error("Frankfurter 503"));
    await expect(
      getHistoricalPriceInputsForOwner(OWNER_ID),
    ).resolves.toBeDefined();
  });

  it("passes the fetcher result straight through on the happy path (no Sentry)", async () => {
    hoisted.fetchImpl = vi.fn().mockResolvedValue(SAMPLE_INPUTS);

    const result = await getHistoricalPriceInputsForOwner(OWNER_ID);

    expect(result).toEqual(SAMPLE_INPUTS);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("uses the admin client (not the server client) and forwards the ownerId", async () => {
    hoisted.fetchImpl = vi.fn().mockResolvedValue(SAMPLE_INPUTS);

    await getHistoricalPriceInputsForOwner(OWNER_ID);

    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    // The admin client (RLS-bypass, scoped by ownerId) is handed to the fetcher.
    expect(fetchHistoricalPriceInputsFor).toHaveBeenCalledWith(
      ADMIN_CLIENT,
      OWNER_ID,
    );
  });
});

// ─── getHistoricalPriceInputs (current-user / server path) ───────────────────
describe("getHistoricalPriceInputs (current-user / server path)", () => {
  it("returns empty inputs (never throws) when the fetcher rejects, and reports to Sentry", async () => {
    const boom = new Error("historical_prices read failed");
    hoisted.fetchImpl = vi.fn().mockRejectedValue(boom);

    const result = await getHistoricalPriceInputs(OWNER_ID);

    expect(result).toEqual({ lots: [], prices: [] });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, {
      tags: { context: "historical-inputs-cache.getHistoricalPriceInputs" },
    });
  });

  it("passes the fetcher result straight through on the happy path (no Sentry)", async () => {
    hoisted.fetchImpl = vi.fn().mockResolvedValue(SAMPLE_INPUTS);

    const result = await getHistoricalPriceInputs(OWNER_ID);

    expect(result).toEqual(SAMPLE_INPUTS);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("uses the server client (not the admin client) and forwards the userId", async () => {
    hoisted.fetchImpl = vi.fn().mockResolvedValue(SAMPLE_INPUTS);

    await getHistoricalPriceInputs(OWNER_ID);

    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(fetchHistoricalPriceInputsFor).toHaveBeenCalledWith(
      SERVER_CLIENT,
      OWNER_ID,
    );
  });
});
