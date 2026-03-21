import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Share link lifecycle: insert, token uniqueness, scope validation,
 * cross-user isolation, and owner self-update.
 *
 * Requires local Supabase running (supabase start).
 */

describe("shares lifecycle", () => {
  // ── 1. Create share link ──────────────────────────────────────

  describe("create share link", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    let shareId: string;

    beforeAll(async () => {
      owner = await createTestUser("share-create-owner@test.local");
    });

    afterAll(() => {
      // Clean up share via admin (owner might not have delete working if test fails)
      const admin = getAdminClient();
      if (shareId) admin.from("portfolio_shares").delete().eq("id", shareId);
      owner.cleanup();
    });

    it("owner can insert a link share with token, scope, and expires_at", async () => {
      const expiresAt = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString();

      const { data, error } = await owner.client
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          share_type: "link",
          token: "lifecycle-test-token-01",
          scope: "full",
          label: "Test Share",
          expires_at: expiresAt,
        })
        .select("id, owner_id, share_type, token, scope, label, expires_at, revoked_at")
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.owner_id).toBe(owner.userId);
      expect(data!.share_type).toBe("link");
      expect(data!.token).toBe("lifecycle-test-token-01");
      expect(data!.scope).toBe("full");
      expect(data!.label).toBe("Test Share");
      expect(data!.expires_at).not.toBeNull();
      expect(data!.revoked_at).toBeNull();
      shareId = data!.id;
    });
  });

  // ── 2. Token uniqueness ───────────────────────────────────────

  describe("token uniqueness", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    let firstShareId: string;

    beforeAll(async () => {
      owner = await createTestUser("share-token-unique@test.local");

      const { data } = await owner.client
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          share_type: "link",
          token: "duplicate-token-test-xyz",
          scope: "full",
        })
        .select("id")
        .single();
      if (!data) throw new Error("Failed to create first share");
      firstShareId = data.id;
    });

    afterAll(() => {
      const admin = getAdminClient();
      admin.from("portfolio_shares").delete().eq("id", firstShareId);
      owner.cleanup();
    });

    it("duplicate token violates unique constraint", async () => {
      const { error } = await owner.client
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          share_type: "link",
          token: "duplicate-token-test-xyz",
          scope: "overview",
        });

      expect(error).not.toBeNull();
      // 23505 = unique_violation
      expect(error!.code).toBe("23505");
      expect(error!.message).toContain("portfolio_shares_token_key");
    });
  });

  // ── 3. Scope enum validation ──────────────────────────────────

  describe("scope enum validation", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      owner = await createTestUser("share-scope-enum@test.local");
    });

    afterAll(() => owner.cleanup());

    it("rejects invalid scope value", async () => {
      const { error } = await owner.client
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          share_type: "link",
          token: "scope-invalid-test-abc",
          scope: "nonexistent_scope",
        });

      expect(error).not.toBeNull();
      // 22P02 = invalid_text_representation (invalid enum value)
      expect(error!.code).toBe("22P02");
    });
  });

  // ── 4. Owner can list own shares ──────────────────────────────

  describe("owner can list own shares", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    const shareIds: string[] = [];

    beforeAll(async () => {
      owner = await createTestUser("share-list-owner@test.local");

      // Create two shares
      for (const suffix of ["list-a", "list-b"]) {
        const { data } = await owner.client
          .from("portfolio_shares")
          .insert({
            owner_id: owner.userId,
            share_type: "link",
            token: `list-test-${suffix}-token`,
            scope: "full",
          })
          .select("id")
          .single();
        if (data) shareIds.push(data.id);
      }
    });

    afterAll(() => {
      const admin = getAdminClient();
      for (const id of shareIds) {
        admin.from("portfolio_shares").delete().eq("id", id);
      }
      owner.cleanup();
    });

    it("SELECT returns own shares", async () => {
      const { data, error } = await owner.client
        .from("portfolio_shares")
        .select("id, token")
        .eq("owner_id", owner.userId);

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(2);

      const returnedIds = data!.map((s) => s.id);
      for (const id of shareIds) {
        expect(returnedIds).toContain(id);
      }
    });
  });

  // ── 5. User B cannot see User A's shares ──────────────────────

  describe("cross-user share isolation", () => {
    let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
    let userB: { client: SupabaseClient; userId: string; cleanup: () => void };
    let shareId: string;

    beforeAll(async () => {
      userA = await createTestUser("share-iso-a@test.local");
      userB = await createTestUser("share-iso-b@test.local");

      // UserA creates a link share (no viewer_id)
      const { data } = await userA.client
        .from("portfolio_shares")
        .insert({
          owner_id: userA.userId,
          share_type: "link",
          token: "isolation-test-token-01",
          scope: "full",
        })
        .select("id")
        .single();
      if (!data) throw new Error("Failed to create userA share");
      shareId = data.id;
    });

    afterAll(() => {
      const admin = getAdminClient();
      admin.from("portfolio_shares").delete().eq("id", shareId);
      userA.cleanup();
      userB.cleanup();
    });

    it("userB cannot see userA's link share", async () => {
      // Link shares have no viewer_id, so RLS read_shares policy only allows
      // owner_id match or viewer_id match. userB is neither.
      const { data } = await userB.client
        .from("portfolio_shares")
        .select("id")
        .eq("id", shareId);

      expect(data).toEqual([]);
    });

    it("userB cannot see any of userA's shares via owner_id filter", async () => {
      const { data } = await userB.client
        .from("portfolio_shares")
        .select("id")
        .eq("owner_id", userA.userId);

      expect(data).toEqual([]);
    });
  });

  // ── 6. Owner can update revoked_at on own share ───────────────

  describe("owner can revoke own share", () => {
    let owner: { client: SupabaseClient; userId: string; cleanup: () => void };
    let shareId: string;

    beforeAll(async () => {
      owner = await createTestUser("share-revoke-self@test.local");

      const { data } = await owner.client
        .from("portfolio_shares")
        .insert({
          owner_id: owner.userId,
          share_type: "link",
          token: "revoke-self-test-token",
          scope: "full",
        })
        .select("id")
        .single();
      if (!data) throw new Error("Failed to create share");
      shareId = data.id;
    });

    afterAll(() => {
      const admin = getAdminClient();
      admin.from("portfolio_shares").delete().eq("id", shareId);
      owner.cleanup();
    });

    it("owner can UPDATE revoked_at on their own share", async () => {
      const revokedAt = new Date().toISOString();
      const { error } = await owner.client
        .from("portfolio_shares")
        .update({ revoked_at: revokedAt })
        .eq("id", shareId);

      expect(error).toBeNull();

      // Verify the revocation persisted
      const { data } = await owner.client
        .from("portfolio_shares")
        .select("revoked_at")
        .eq("id", shareId)
        .single();

      expect(data).not.toBeNull();
      expect(data!.revoked_at).not.toBeNull();
    });
  });
});
