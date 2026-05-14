import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, getAdminClient } from "./setup";
import { fetchManualNavInputsFor } from "@/lib/portfolio/manual-nav-augmentation";
import type { Database } from "@/types/database";

/**
 * Cross-user manual NAV lookup (admin client + owner_id path).
 *
 * This exercises the path PR #74 introduced for share + comparison pages:
 * when a viewer loads a portfolio that belongs to a different user, the
 * viewer's authenticated client cannot see the owner's NAV history (RLS
 * scopes everything to auth.uid()). The system uses the admin (service-role)
 * client with an explicit owner_id filter instead.
 *
 * `fetchManualNavInputsFor(adminClient, ownerUserId)` is the canonical
 * helper for this path. Tests in this file verify:
 *   1. RLS isolation — viewer's authenticated client CANNOT see owner data
 *   2. Admin path with explicit owner_id DOES return owner's positions + navs
 *   3. The shape returned matches what assemble.ts / shared-portfolio.ts
 *      / comparison.ts feed into augmentSnapshotsWithManualNavs
 */
describe("manual NAV cross-user lookup (integration)", () => {
  let ownerClient: SupabaseClient<Database>;
  let viewerClient: SupabaseClient<Database>;
  let ownerUserId: string;
  let viewerUserId: string;
  let cleanupOwner: () => void;
  let cleanupViewer: () => void;
  let ownerAssetId: string;

  beforeAll(async () => {
    const owner = await createTestUser(`owner-${Date.now()}@test.local`);
    ownerClient = owner.client as SupabaseClient<Database>;
    ownerUserId = owner.userId;
    cleanupOwner = owner.cleanup;

    const viewer = await createTestUser(`viewer-${Date.now()}@test.local`);
    viewerClient = viewer.client as SupabaseClient<Database>;
    viewerUserId = viewer.userId;
    cleanupViewer = viewer.cleanup;

    // Owner sets up a manual NAV asset + 50 shares + 2 NAV entries.
    const { data: broker } = await ownerClient
      .from("brokers")
      .insert({ user_id: ownerUserId, name: "Owner Broker" })
      .select("id")
      .single();
    const brokerId = broker!.id;

    const { data: asset } = await ownerClient
      .from("stock_assets")
      .insert({
        user_id: ownerUserId,
        ticker: "OWNER-ELTIF",
        name: "Owner ELTIF",
        currency: "EUR",
        kind: "manual",
        category: "private_equity",
      })
      .select("id")
      .single();
    ownerAssetId = asset!.id;

    await ownerClient.from("stock_positions").insert({
      stock_asset_id: ownerAssetId,
      broker_id: brokerId,
      quantity: 50,
    });

    await ownerClient.from("manual_nav_updates").insert([
      { user_id: ownerUserId, asset_id: ownerAssetId, effective_date: "2026-01-01", nav: 100 },
      { user_id: ownerUserId, asset_id: ownerAssetId, effective_date: "2026-04-01", nav: 110 },
    ]);
  });

  afterAll(() => {
    cleanupOwner();
    cleanupViewer();
  });

  it("viewer's RLS-scoped client CANNOT see owner's manual_nav_updates", async () => {
    // Direct table read with viewer auth context — RLS scopes by auth.uid().
    // Even if the viewer guesses the owner_id and asset_id, the policy
    // (manual_nav_updates_user_scope in migration 017) blocks the read.
    const { data, error } = await viewerClient
      .from("manual_nav_updates")
      .select("id, nav")
      .eq("user_id", ownerUserId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("viewer's RLS-scoped fetchManualNavInputsFor returns empty (correct RLS isolation)", async () => {
    // Even passing ownerUserId explicitly, the viewer client's RLS strips
    // everything that doesn't match auth.uid().
    const result = await fetchManualNavInputsFor(viewerClient, ownerUserId);
    expect(result.positions).toHaveLength(0);
    expect(result.navs).toHaveLength(0);
  });

  it("admin client + explicit owner_id returns owner's manual positions + nav history", async () => {
    const adminClient = getAdminClient() as SupabaseClient<Database>;
    const result = await fetchManualNavInputsFor(adminClient, ownerUserId);

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      stock_asset_id: ownerAssetId,
      quantity: 50,
      currency: "EUR",
    });

    expect(result.navs).toHaveLength(2);
    // Sorted ASC by effective_date (canonical input shape for binary search)
    expect(result.navs[0]).toMatchObject({
      asset_id: ownerAssetId,
      effective_date: "2026-01-01",
      nav: 100,
    });
    expect(result.navs[1]).toMatchObject({
      asset_id: ownerAssetId,
      effective_date: "2026-04-01",
      nav: 110,
    });
  });

  it("admin client refuses to leak across owner_ids — viewer's UUID returns empty", async () => {
    // Defense-in-depth: even with the admin client, passing the WRONG user_id
    // must return empty. Verifies the explicit .eq("user_id", userId) filter
    // in fetchManualNavInputsFor isn't accidentally bypassed.
    const adminClient = getAdminClient() as SupabaseClient<Database>;
    const result = await fetchManualNavInputsFor(adminClient, viewerUserId);
    expect(result.positions).toHaveLength(0);
    expect(result.navs).toHaveLength(0);
  });
});
