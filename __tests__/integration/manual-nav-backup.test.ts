import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser } from "./setup";

/**
 * Integration tests for the manual_nav_updates backup/restore round-trip
 * shipped in PR 5/5 (PortfolioBackup version 5).
 *
 * Validates:
 *   1. manual_nav_updates rows insert under RLS for the owning user
 *   2. The exact column shape (asset_id, effective_date, nav, note, user_id)
 *      matches the PortfolioBackup ManualNavUpdate payload contract
 *   3. The UNIQUE (asset_id, effective_date) constraint behaves on conflict
 *   4. Re-running the same payload is idempotent (upsert + onConflict)
 *   5. ON DELETE CASCADE wipes NAV history when the parent asset is deleted
 *      (so isReplace=true import doesn't leak orphans)
 */
describe("manual NAV backup round-trip (integration)", () => {
  let client: SupabaseClient;
  let userId: string;
  let cleanup: () => void;
  let assetId: string;

  beforeAll(async () => {
    const result = await createTestUser();
    client = result.client;
    userId = result.userId;
    cleanup = result.cleanup;

    const { data: asset, error: assetErr } = await client
      .from("stock_assets")
      .insert({
        user_id: userId,
        ticker: "ENXF",
        name: "Test ELTIF",
        currency: "EUR",
        kind: "manual",
        category: "private_equity",
      })
      .select("id")
      .single();
    expect(assetErr).toBeNull();
    assetId = asset!.id;
  });

  afterAll(() => cleanup());

  it("export shape matches the ManualNavUpdate payload contract", async () => {
    await client.from("manual_nav_updates").insert({
      user_id: userId,
      asset_id: assetId,
      effective_date: "2026-01-15",
      nav: 100,
      note: "Q1 2026 fund letter",
    });

    const { data, error } = await client
      .from("manual_nav_updates")
      .select("id, user_id, asset_id, effective_date, nav, note, created_at")
      .eq("asset_id", assetId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const row = data![0];
    expect(row.user_id).toBe(userId);
    expect(row.asset_id).toBe(assetId);
    expect(row.effective_date).toBe("2026-01-15");
    expect(Number(row.nav)).toBe(100);
    expect(row.note).toBe("Q1 2026 fund letter");
    expect(typeof row.id).toBe("string");
    expect(typeof row.created_at).toBe("string");
  });

  it("upsert with onConflict=(asset_id, effective_date) is idempotent across re-imports", async () => {
    // Initial import: one row
    const initial = await client
      .from("manual_nav_updates")
      .upsert(
        {
          user_id: userId,
          asset_id: assetId,
          effective_date: "2026-04-01",
          nav: 110,
          note: "Q2 2026 fund letter",
        },
        { onConflict: "asset_id,effective_date" },
      );
    expect(initial.error).toBeNull();

    // Re-import identical payload — should NOT error, should leave row count unchanged
    const reimport = await client
      .from("manual_nav_updates")
      .upsert(
        {
          user_id: userId,
          asset_id: assetId,
          effective_date: "2026-04-01",
          nav: 110,
          note: "Q2 2026 fund letter",
        },
        { onConflict: "asset_id,effective_date" },
      );
    expect(reimport.error).toBeNull();

    const { data } = await client
      .from("manual_nav_updates")
      .select("id")
      .eq("asset_id", assetId)
      .eq("effective_date", "2026-04-01");
    expect(data).toHaveLength(1);
  });

  it("upsert with same key but different nav refreshes the existing row (revision flow)", async () => {
    await client
      .from("manual_nav_updates")
      .upsert(
        {
          user_id: userId,
          asset_id: assetId,
          effective_date: "2026-04-01",
          nav: 115,
          note: "Q2 2026 fund letter (revised)",
        },
        { onConflict: "asset_id,effective_date" },
      );

    const { data } = await client
      .from("manual_nav_updates")
      .select("nav, note")
      .eq("asset_id", assetId)
      .eq("effective_date", "2026-04-01")
      .single();
    expect(data).toBeTruthy();
    expect(Number(data!.nav)).toBe(115);
    expect(data!.note).toBe("Q2 2026 fund letter (revised)");
  });

  it("ON DELETE CASCADE wipes NAV history when parent asset is deleted (isReplace flow)", async () => {
    // Sanity: history exists before delete
    const { data: pre } = await client
      .from("manual_nav_updates")
      .select("id")
      .eq("asset_id", assetId);
    expect(pre!.length).toBeGreaterThan(0);

    // Delete the parent stock_asset (mimics isReplace=true import wiping
    // stock_assets first). manual_nav_updates rows must cascade-delete.
    const { error } = await client.from("stock_assets").delete().eq("id", assetId);
    expect(error).toBeNull();

    const { data: post } = await client
      .from("manual_nav_updates")
      .select("id")
      .eq("asset_id", assetId);
    expect(post).toHaveLength(0);
  });
});
