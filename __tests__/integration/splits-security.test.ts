import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Security tests for split-related features (migration 011) and
 * complementary RLS enforcement gaps (portfolio_shares expiry/revocation,
 * is_active_user pending-user blocking).
 *
 * Requires local Supabase running (supabase start).
 */

describe("splits security", () => {
  // ── 1. Cross-user split_from_id reference ───────────────────────

  describe("RLS: cross-user split_from_id reference", () => {
    let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
    let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
    let userAEntryId: string;

    beforeAll(async () => {
      userA = await createTestUser("split-rls-a@test.local");
      userB = await createTestUser("split-rls-b@test.local");

      // UserA: create a crypto asset + position + activity_log entry
      const { data: asset } = await userA.client
        .from("crypto_assets")
        .insert({
          user_id: userA.userId,
          name: "SplitCoin",
          ticker: "SPCN",
          coingecko_id: "splitcoin-rls",
        })
        .select("id")
        .single();
      if (!asset) throw new Error("Failed to create userA crypto asset");

      const { data: wallet } = await userA.client
        .from("wallets")
        .insert({
          user_id: userA.userId,
          name: "SplitWallet",
          wallet_type: "custodial",
        })
        .select("id")
        .single();
      if (!wallet) throw new Error("Failed to create userA wallet");

      await userA.client
        .from("crypto_positions")
        .insert({
          crypto_asset_id: asset.id,
          wallet_id: wallet.id,
          quantity: 10,
        });

      const { data: entry } = await userA.client
        .from("activity_log")
        .insert({
          user_id: userA.userId,
          action: "created",
          entity_type: "crypto_asset",
          entity_name: "SplitCoin",
          description: "Added SplitCoin",
          entity_id: asset.id,
        })
        .select("id")
        .single();
      if (!entry) throw new Error("Failed to create userA activity_log entry");
      userAEntryId = entry.id;
    });

    afterAll(() => {
      userA.cleanup();
      userB.cleanup();
    });

    it("userB can insert with split_from_id pointing to userA's entry (FK allows it)", async () => {
      // RLS INSERT policy only checks user_id on the NEW row, not the FK target.
      // The FK constraint validates the UUID exists in activity_log (service-role created it).
      // So userB's insert should succeed — the row belongs to userB.
      const { data, error } = await userB.client
        .from("activity_log")
        .insert({
          user_id: userB.userId,
          action: "created",
          entity_type: "crypto_asset",
          entity_name: "SplitChild",
          description: "Split from userA parent",
          split_from_id: userAEntryId,
        })
        .select("id, split_from_id")
        .single();

      // Insert succeeds — userB owns the new row
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.split_from_id).toBe(userAEntryId);
    });

    it("userB cannot read the parent entry belonging to userA", async () => {
      // Even though userB's row references userA's entry via split_from_id,
      // RLS prevents userB from reading the parent row directly.
      const { data } = await userB.client
        .from("activity_log")
        .select("*")
        .eq("id", userAEntryId);

      expect(data).toEqual([]);
    });
  });

  // ── 2. ON DELETE CASCADE for split children ─────────────────────

  describe("ON DELETE CASCADE for split children", () => {
    let client: SupabaseClient;
    let userId: string;
    let cleanup: () => void;
    let parentId: string;
    let childIds: string[];

    beforeAll(async () => {
      const result = await createTestUser("split-cascade@test.local");
      client = result.client;
      userId = result.userId;
      cleanup = result.cleanup;

      // Insert parent activity_log entry
      const { data: parent } = await client
        .from("activity_log")
        .insert({
          user_id: userId,
          action: "created",
          entity_type: "crypto_asset",
          entity_name: "CascadeParent",
          description: "Parent entry for cascade test",
        })
        .select("id")
        .single();
      if (!parent) throw new Error("Failed to create parent entry");
      parentId = parent.id;

      // Insert 2 child entries referencing parent
      const { data: children } = await client
        .from("activity_log")
        .insert([
          {
            user_id: userId,
            action: "created",
            entity_type: "crypto_asset",
            entity_name: "CascadeChild1",
            description: "First split child",
            split_from_id: parentId,
          },
          {
            user_id: userId,
            action: "created",
            entity_type: "crypto_asset",
            entity_name: "CascadeChild2",
            description: "Second split child",
            split_from_id: parentId,
          },
        ])
        .select("id");
      if (!children || children.length !== 2) {
        throw new Error("Failed to create child entries");
      }
      childIds = children.map((c) => c.id);
    });

    afterAll(() => cleanup());

    it("deleting parent cascades to all split children", async () => {
      // Hard-delete the parent via admin client (bypasses RLS)
      const admin = getAdminClient();
      const { error } = await admin
        .from("activity_log")
        .delete()
        .eq("id", parentId);
      expect(error).toBeNull();

      // Both children should be cascade-deleted
      const { data: remaining } = await admin
        .from("activity_log")
        .select("id")
        .in("id", childIds);
      expect(remaining).toEqual([]);
    });
  });

  // ── 3. chk_no_self_split constraint ─────────────────────────────

  describe("chk_no_self_split constraint", () => {
    let client: SupabaseClient;
    let userId: string;
    let cleanup: () => void;
    let entryId: string;

    beforeAll(async () => {
      const result = await createTestUser("split-self@test.local");
      client = result.client;
      userId = result.userId;
      cleanup = result.cleanup;

      const { data: entry } = await client
        .from("activity_log")
        .insert({
          user_id: userId,
          action: "created",
          entity_type: "crypto_asset",
          entity_name: "SelfSplitTest",
          description: "Entry for self-split constraint test",
        })
        .select("id")
        .single();
      if (!entry) throw new Error("Failed to create entry");
      entryId = entry.id;
    });

    afterAll(() => cleanup());

    it("rejects self-referencing split_from_id", async () => {
      const { error } = await client
        .from("activity_log")
        .update({ split_from_id: entryId })
        .eq("id", entryId);

      expect(error).not.toBeNull();
      // PostgreSQL check_violation error code
      expect(error!.code).toBe("23514");
      expect(error!.message).toContain("chk_no_self_split");
    });
  });

  // ── 4. is_active_user() blocks pending users ────────────────────

  describe("is_active_user blocks pending users", () => {
    let pendingClient: SupabaseClient;
    let pendingUserId: string;
    let pendingCleanup: () => void;

    beforeAll(async () => {
      // createTestUser activates the user — we need to revert that
      const result = await createTestUser("pending-block@test.local");
      pendingClient = result.client;
      pendingUserId = result.userId;
      pendingCleanup = result.cleanup;

      // Set user back to pending status via admin client
      const admin = getAdminClient();
      const { error } = await admin
        .from("profiles")
        .update({ status: "pending" })
        .eq("id", pendingUserId);
      if (error) throw new Error("Failed to set pending status: " + error.message);
    });

    afterAll(() => pendingCleanup());

    it("pending user cannot insert crypto_assets", async () => {
      const { data, error } = await pendingClient
        .from("crypto_assets")
        .insert({
          user_id: pendingUserId,
          name: "BlockedCoin",
          ticker: "BLCK",
          coingecko_id: "blocked-coin",
        })
        .select("id")
        .single();

      // RLS blocks the insert — either error or empty result
      if (error) {
        expect(error.code).toBeTruthy();
      } else {
        expect(data).toBeNull();
      }

      // Verify nothing was inserted (check via admin)
      const admin = getAdminClient();
      const { data: check } = await admin
        .from("crypto_assets")
        .select("id")
        .eq("user_id", pendingUserId)
        .eq("ticker", "BLCK");
      expect(check).toEqual([]);
    });

    it("pending user cannot insert activity_log entries", async () => {
      const { data, error } = await pendingClient
        .from("activity_log")
        .insert({
          user_id: pendingUserId,
          action: "created",
          entity_type: "crypto_asset",
          entity_name: "Blocked",
          description: "Should be blocked",
        })
        .select("id")
        .single();

      if (error) {
        expect(error.code).toBeTruthy();
      } else {
        expect(data).toBeNull();
      }

      // Verify nothing was inserted
      const admin = getAdminClient();
      const { data: check } = await admin
        .from("activity_log")
        .select("id")
        .eq("user_id", pendingUserId)
        .eq("entity_name", "Blocked");
      expect(check).toEqual([]);
    });
  });

  // ── 5. portfolio_shares expiry enforcement ──────────────────────

  describe("portfolio_shares expiry enforcement", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    let viewer: { client: SupabaseClient; userId: string; cleanup: () => void };
    let shareId: string;

    beforeAll(async () => {
      owner = await createTestUser("share-expiry-owner@test.local");
      viewer = await createTestUser("share-expiry-viewer@test.local");

      // Owner creates a share with expires_at in the past
      const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const admin = getAdminClient();
      const { data: share } = await admin
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          viewer_id: viewer.userId,
          share_type: "user",
          scope: "full",
          expires_at: pastDate,
        })
        .select("id")
        .single();
      if (!share) throw new Error("Failed to create expired share");
      shareId = share.id;
    });

    afterAll(() => {
      owner.cleanup();
      viewer.cleanup();
    });

    it("viewer cannot read expired share", async () => {
      const { data } = await viewer.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);

      expect(data).toEqual([]);
    });

    it("owner can still read their own expired share", async () => {
      // read_shares policy: owner_id match OR (viewer_id match + not expired + not revoked)
      // Owner always has access regardless of expiry
      const { data } = await owner.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);

      expect(data).toHaveLength(1);
      expect(data![0].id).toBe(shareId);
    });
  });

  // ── 6. portfolio_shares revocation enforcement ──────────────────

  describe("portfolio_shares revocation enforcement", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    let viewer: { client: SupabaseClient; userId: string; cleanup: () => void };
    let shareId: string;

    beforeAll(async () => {
      owner = await createTestUser("share-revoke-owner@test.local");
      viewer = await createTestUser("share-revoke-viewer@test.local");

      // Owner creates a valid share (no expiry, no revocation)
      const admin = getAdminClient();
      const { data: share } = await admin
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          viewer_id: viewer.userId,
          share_type: "user",
          scope: "full",
        })
        .select("id")
        .single();
      if (!share) throw new Error("Failed to create share");
      shareId = share.id;

      // Verify viewer CAN read it before revocation
      const { data: preCheck } = await viewer.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);
      if (!preCheck || preCheck.length !== 1) {
        throw new Error("Viewer should be able to read unrevoked share");
      }

      // Owner revokes the share
      const { error } = await owner.client
        .from("portfolio_shares")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", shareId);
      if (error) throw new Error("Failed to revoke share: " + error.message);
    });

    afterAll(() => {
      owner.cleanup();
      viewer.cleanup();
    });

    it("viewer cannot read revoked share", async () => {
      const { data } = await viewer.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);

      expect(data).toEqual([]);
    });

    it("owner can still read their own revoked share", async () => {
      const { data } = await owner.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);

      expect(data).toHaveLength(1);
      expect(data![0].id).toBe(shareId);
    });
  });
});
