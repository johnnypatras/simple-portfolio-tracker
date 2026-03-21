import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin operations: RLS enforcement on profiles, column-level REVOKE,
 * and invite_codes constraints.
 *
 * Requires local Supabase running (supabase start).
 */

describe("admin RLS", () => {
  // ── 1. Non-admin cannot read other users' profiles ────────────

  describe("non-admin cannot read other profiles", () => {
    let userA: { client: SupabaseClient; userId: string; cleanup: () => void };
    let userB: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      userA = await createTestUser("admin-rls-a@test.local");
      userB = await createTestUser("admin-rls-b@test.local");
    });

    afterAll(() => {
      userA.cleanup();
      userB.cleanup();
    });

    it("userA cannot SELECT userB's profile", async () => {
      const { data } = await userA.client
        .from("profiles")
        .select("id, email, role, status")
        .eq("id", userB.userId);

      expect(data).toEqual([]);
    });

    it("userA can only read their own profile", async () => {
      const { data } = await userA.client
        .from("profiles")
        .select("id")
        .neq("id", userA.userId);

      expect(data).toEqual([]);
    });
  });

  // ── 2. Admin role column protected via column-level REVOKE ────

  describe("admin role column protected", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      user = await createTestUser("role-protect@test.local");
    });

    afterAll(() => user.cleanup());

    it("user cannot UPDATE own role to admin", async () => {
      // Migration 010 revokes table-level UPDATE on profiles from authenticated,
      // then grants only safe columns (first_name, last_name, display_name,
      // primary_currency, theme, updated_at). Role is not in that list.
      const { error } = await user.client
        .from("profiles")
        .update({ role: "admin" })
        .eq("id", user.userId);

      // Column-level REVOKE causes a permission error
      expect(error).not.toBeNull();
      expect(error!.code).toBeTruthy();

      // Verify role is unchanged via admin client
      const admin = getAdminClient();
      const { data: profile } = await admin
        .from("profiles")
        .select("role")
        .eq("id", user.userId)
        .single();

      expect(profile?.role).toBe("user");
    });
  });

  // ── 3. Profile status column protected ────────────────────────

  describe("profile status column protected", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };

    beforeAll(async () => {
      user = await createTestUser("status-protect@test.local");
    });

    afterAll(() => user.cleanup());

    it("user cannot UPDATE own status to active", async () => {
      // First set user to pending via admin to make the test meaningful
      const admin = getAdminClient();
      await admin
        .from("profiles")
        .update({ status: "pending" })
        .eq("id", user.userId);

      // User tries to reactivate themselves
      const { error } = await user.client
        .from("profiles")
        .update({ status: "active" })
        .eq("id", user.userId);

      // Column-level REVOKE causes a permission error
      expect(error).not.toBeNull();
      expect(error!.code).toBeTruthy();

      // Verify status is unchanged
      const { data: profile } = await admin
        .from("profiles")
        .select("status")
        .eq("id", user.userId)
        .single();

      expect(profile?.status).toBe("pending");

      // Restore active status for cleanup
      await admin
        .from("profiles")
        .update({ status: "active" })
        .eq("id", user.userId);
    });
  });

  // ── 4. Invite code storage ────────────────────────────────────

  describe("invite code storage", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };
    let codeId: string;

    beforeAll(async () => {
      user = await createTestUser("invite-store@test.local");
    });

    afterAll(() => user.cleanup());

    it("admin client can insert invite code and fields are stored correctly", async () => {
      const admin = getAdminClient();
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      ).toISOString();

      const { data, error } = await admin
        .from("invite_codes")
        .insert({
          code: "test-invite-store-001",
          created_by: user.userId,
          expires_at: expiresAt,
        })
        .select("id, code, created_by, expires_at, used_by, used_at")
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.code).toBe("test-invite-store-001");
      expect(data!.created_by).toBe(user.userId);
      expect(data!.expires_at).not.toBeNull();
      expect(data!.used_by).toBeNull();
      expect(data!.used_at).toBeNull();
      codeId = data!.id;

      // Clean up
      await admin.from("invite_codes").delete().eq("id", codeId);
    });
  });

  // ── 5. Invite code uniqueness constraint ──────────────────────

  describe("invite code uniqueness", () => {
    let user: { client: SupabaseClient; userId: string; cleanup: () => void };
    let firstCodeId: string;
    const uniqueCode = `utc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      user = await createTestUser("invite-unique@test.local");

      const admin = getAdminClient();
      const { data, error } = await admin
        .from("invite_codes")
        .insert({
          code: uniqueCode,
          created_by: user.userId,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error("Failed to create first invite code: " + (error?.message ?? "null data"));
      firstCodeId = data.id;
    });

    afterAll(() => {
      const admin = getAdminClient();
      admin.from("invite_codes").delete().eq("id", firstCodeId);
      user.cleanup();
    });

    it("duplicate invite code violates unique constraint", async () => {
      const admin = getAdminClient();
      const { error } = await admin.from("invite_codes").insert({
        code: uniqueCode,
        created_by: user.userId,
      });

      expect(error).not.toBeNull();
      // 23505 = unique_violation
      expect(error!.code).toBe("23505");
      expect(error!.message).toContain("invite_codes_code_key");
    });
  });
});
