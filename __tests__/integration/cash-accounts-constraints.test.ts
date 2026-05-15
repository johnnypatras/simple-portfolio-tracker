import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser, getAdminClient } from "./setup";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tests cash_accounts constraints from migration 005:
 *   - Unique index (uq_cash_accounts_active)
 *   - CHECK constraints (chk_cash_origin, chk_name_not_empty, chk_bank_requires_name)
 *   - RLS cross-user isolation
 *   - Cascade restore (soft-delete then restore parent)
 *   - is_active_user enforcement for pending users
 *   - mergeCashAccounts self-merge guard
 */

describe("cash_accounts constraints", () => {
  let clientA: SupabaseClient;
  let userIdA: string;
  let cleanupA: () => void;

  let clientB: SupabaseClient;
  let cleanupB: () => void;

  let institutionId: string;
  let walletId: string;
  let brokerId: string;

  beforeAll(async () => {
    const resultA = await createTestUser("cash-constraints-a@test.local");
    clientA = resultA.client;
    userIdA = resultA.userId;
    cleanupA = resultA.cleanup;

    const resultB = await createTestUser("cash-constraints-b@test.local");
    clientB = resultB.client;
    cleanupB = resultB.cleanup;

    // Create shared setup entities for User A
    const { data: inst } = await clientA
      .from("institutions")
      .insert({ user_id: userIdA, name: "Constraint-Test-Inst" })
      .select("id")
      .single();
    institutionId = inst!.id;

    const { data: wallet } = await clientA
      .from("wallets")
      .insert({
        user_id: userIdA,
        name: "Constraint-Test-Wallet",
        wallet_type: "custodial",
        institution_id: institutionId,
      })
      .select("id")
      .single();
    walletId = wallet!.id;

    const { data: broker } = await clientA
      .from("brokers")
      .insert({
        user_id: userIdA,
        name: "Constraint-Test-Broker",
        institution_id: institutionId,
      })
      .select("id")
      .single();
    brokerId = broker!.id;
  });

  afterAll(() => {
    cleanupA();
    cleanupB();
  });

  // ── P1: Unique Index ────────────────────────────────────────

  describe("P1 — unique index (uq_cash_accounts_active)", () => {
    it("two unnamed deposits at same wallet_id+currency → second INSERT fails", async () => {
      // First unnamed deposit at walletId (name=NULL)
      const { error: err1 } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: walletId,
        institution_id: institutionId,
        currency: "USD",
        balance: 100,
      });
      expect(err1).toBeNull();

      // Second deposit at the SAME wallet_id + currency → unique violation
      // (Per migration 019, the key now includes wallet_id/broker_id so two
      // *different* wallets at the same institution+currency are allowed —
      // see the next test. Same wallet_id + currency must still collide.)
      const { error: err2 } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: walletId,
        institution_id: institutionId,
        currency: "USD",
        balance: 200,
      });
      expect(err2).not.toBeNull();
      expect(err2!.code).toBe("23505"); // unique_violation
    });

    it("two unnamed deposits at different wallets, same institution+currency → both succeed (migration 019)", async () => {
      // Fresh institution to avoid earlier-test fixtures
      const { data: inst019 } = await clientA
        .from("institutions")
        .insert({ user_id: userIdA, name: "Mig019-Test-Inst" })
        .select("id")
        .single();

      const { data: walletA } = await clientA
        .from("wallets")
        .insert({
          user_id: userIdA,
          name: "Mig019-Wallet-A",
          wallet_type: "custodial",
          institution_id: inst019!.id,
        })
        .select("id")
        .single();
      const { data: walletB } = await clientA
        .from("wallets")
        .insert({
          user_id: userIdA,
          name: "Mig019-Wallet-B",
          wallet_type: "custodial",
          institution_id: inst019!.id,
        })
        .select("id")
        .single();

      const { error: errA } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: walletA!.id,
        institution_id: inst019!.id,
        currency: "USD",
        balance: 100,
      });
      const { error: errB } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: walletB!.id,
        institution_id: inst019!.id,
        currency: "USD",
        balance: 200,
      });

      expect(errA).toBeNull();
      expect(errB).toBeNull();
    });

    it("one named + one unnamed at same institution+currency → both succeed", async () => {
      // Create a fresh institution to avoid collisions with other tests
      const { data: inst2 } = await clientA
        .from("institutions")
        .insert({ user_id: userIdA, name: "Unique-Test-Inst-2" })
        .select("id")
        .single();

      // Unnamed deposit (name=NULL)
      const { data: w } = await clientA
        .from("wallets")
        .insert({
          user_id: userIdA,
          name: "Unique-Wallet-A",
          wallet_type: "custodial",
          institution_id: inst2!.id,
        })
        .select("id")
        .single();

      const { error: err1 } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: w!.id,
        institution_id: inst2!.id,
        currency: "EUR",
        balance: 100,
      });
      expect(err1).toBeNull();

      // Named deposit at same institution+currency → COALESCE makes them distinct
      const { error: err2 } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        name: "Savings",
        institution_id: inst2!.id,
        currency: "EUR",
        balance: 500,
      });
      expect(err2).toBeNull();
    });

    it("soft-deleted record does NOT block a new active record with same key", async () => {
      const { data: inst3 } = await clientA
        .from("institutions")
        .insert({ user_id: userIdA, name: "SoftDel-Test-Inst" })
        .select("id")
        .single();

      // Create and soft-delete a cash account
      const { data: cash1 } = await clientA
        .from("cash_accounts")
        .insert({
          user_id: userIdA,
          name: "ToDelete",
          institution_id: inst3!.id,
          currency: "GBP",
          balance: 100,
        })
        .select("id")
        .single();

      await clientA
        .from("cash_accounts")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", cash1!.id);

      // Insert a new record with the same key → should succeed (partial index WHERE deleted_at IS NULL)
      const { error } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        name: "ToDelete",
        institution_id: inst3!.id,
        currency: "GBP",
        balance: 200,
      });
      expect(error).toBeNull();
    });
  });

  // ── P2: CHECK Constraints ───────────────────────────────────

  describe("P2 — CHECK constraints", () => {
    it("chk_cash_origin: both wallet_id AND broker_id set → fails", async () => {
      const { error } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        wallet_id: walletId,
        broker_id: brokerId,
        institution_id: institutionId,
        currency: "EUR",
        balance: 100,
      });
      expect(error).not.toBeNull();
      expect(error!.code).toBe("23514"); // check_violation
      expect(error!.message).toContain("chk_cash_origin");
    });

    it("chk_name_not_empty: name = '' (empty string) → fails", async () => {
      const { error } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        name: "",
        institution_id: institutionId,
        currency: "EUR",
        balance: 100,
      });
      expect(error).not.toBeNull();
      expect(error!.code).toBe("23514"); // check_violation
      expect(error!.message).toContain("chk_name_not_empty");
    });

    it("chk_bank_requires_name: standalone account with no name → fails", async () => {
      // wallet_id=NULL, broker_id=NULL, name=NULL → must fail
      const { error } = await clientA.from("cash_accounts").insert({
        user_id: userIdA,
        institution_id: institutionId,
        currency: "CHF",
        balance: 100,
      });
      expect(error).not.toBeNull();
      expect(error!.code).toBe("23514"); // check_violation
      expect(error!.message).toContain("chk_bank_requires_name");
    });
  });

  // ── P3: RLS Cross-User Isolation ────────────────────────────

  describe("P3 — RLS cross-user isolation", () => {
    let cashAccountId: string;

    beforeAll(async () => {
      const { data: inst } = await clientA
        .from("institutions")
        .insert({ user_id: userIdA, name: "RLS-Cash-Inst" })
        .select("id")
        .single();

      const { data: cash } = await clientA
        .from("cash_accounts")
        .insert({
          user_id: userIdA,
          name: "RLS-Test-Account",
          institution_id: inst!.id,
          currency: "EUR",
          balance: 5000,
        })
        .select("id")
        .single();
      cashAccountId = cash!.id;
    });

    it("User B cannot SELECT User A's cash_accounts", async () => {
      const { data } = await clientB
        .from("cash_accounts")
        .select("*")
        .eq("id", cashAccountId);
      expect(data).toEqual([]);
    });

    it("User B cannot UPDATE User A's cash_accounts balance", async () => {
      await clientB
        .from("cash_accounts")
        .update({ balance: 0 })
        .eq("id", cashAccountId);

      // Verify User A's balance is unchanged
      const { data } = await clientA
        .from("cash_accounts")
        .select("balance")
        .eq("id", cashAccountId)
        .single();
      expect(data?.balance).toBe(5000);
    });
  });

  // ── P4: Cascade Restore ─────────────────────────────────────

  describe("P4 — cascade restore", () => {
    it("soft-delete wallet → cash_account deleted, restore wallet → cash_account restored", async () => {
      const { data: inst } = await clientA
        .from("institutions")
        .insert({ user_id: userIdA, name: "Restore-Test-Inst" })
        .select("id")
        .single();

      const { data: wallet } = await clientA
        .from("wallets")
        .insert({
          user_id: userIdA,
          name: "Restore-Wallet",
          wallet_type: "custodial",
          institution_id: inst!.id,
        })
        .select("id")
        .single();

      const { data: cash } = await clientA
        .from("cash_accounts")
        .insert({
          user_id: userIdA,
          wallet_id: wallet!.id,
          institution_id: inst!.id,
          currency: "EUR",
          balance: 750,
        })
        .select("id")
        .single();

      // Soft-delete the wallet
      const deleteTime = new Date().toISOString();
      await clientA
        .from("wallets")
        .update({ deleted_at: deleteTime })
        .eq("id", wallet!.id);

      // Verify cash_account was cascade-deleted
      const { data: deletedCash } = await clientA
        .from("cash_accounts")
        .select("deleted_at")
        .eq("id", cash!.id)
        .single();
      expect(deletedCash?.deleted_at).not.toBeNull();

      // Restore the wallet (set deleted_at=NULL)
      await clientA
        .from("wallets")
        .update({ deleted_at: null })
        .eq("id", wallet!.id);

      // Verify cash_account was cascade-restored
      const { data: restoredCash } = await clientA
        .from("cash_accounts")
        .select("deleted_at")
        .eq("id", cash!.id)
        .single();
      expect(restoredCash?.deleted_at).toBeNull();
    });
  });

  // ── P5: is_active_user enforcement ──────────────────────────

  describe("P5 — pending user blocked by is_active_user", () => {
    it("pending user cannot query cash_accounts", async () => {
      // Create a new user, then set their profile status to 'pending' via admin
      const pending = await createTestUser("cash-pending@test.local");
      const admin = getAdminClient();

      // Set the profile status to 'pending' (bypassing RLS via service_role)
      await admin
        .from("profiles")
        .update({ status: "pending" })
        .eq("id", pending.userId);

      // Create a cash_account via admin for this user
      const { data: inst } = await admin
        .from("institutions")
        .insert({ user_id: pending.userId, name: "Pending-Inst" })
        .select("id")
        .single();

      await admin.from("cash_accounts").insert({
        user_id: pending.userId,
        name: "Pending-Cash",
        institution_id: inst!.id,
        currency: "EUR",
        balance: 100,
      });

      // Query with the pending user's RLS-scoped client → should get empty
      const { data } = await pending.client
        .from("cash_accounts")
        .select("*");
      expect(data).toEqual([]);

      pending.cleanup();
    });
  });

  // ── Self-merge guard ────────────────────────────────────────

  describe("mergeCashAccounts self-merge guard", () => {
    it("mergeCashAccounts(id, id) throws self-merge error", async () => {
      // This tests the application-level guard, not DB constraints.
      // Import the function and call it with the same ID twice.
      // Since this is a server action, we test the guard logic directly.
      const { validateUUID } = await import("@/lib/validation");

      const fakeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      validateUUID(fakeId); // sanity check — valid UUID format

      // The guard is: if (survivorId === duplicateId) throw
      // We verify the logic by checking equality + expected error message
      expect(fakeId === fakeId).toBe(true);

      // Direct test: import and call the function
      // Note: mergeCashAccounts is a "use server" function, but the self-merge
      // guard fires before any DB access, so we can test it by calling with
      // matching IDs and catching the error.
      try {
        // Dynamically import to get the server action
        const { mergeCashAccounts } = await import(
          "@/lib/actions/cash-accounts"
        );
        await mergeCashAccounts(fakeId, fakeId);
        // Should not reach here
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect((err as Error).message).toBe(
          "Cannot merge a cash account with itself",
        );
      }
    });
  });
});
