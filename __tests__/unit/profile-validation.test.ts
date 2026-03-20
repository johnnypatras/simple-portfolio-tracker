import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for updateProfile() input validation in profile.ts.
 *
 * Confirms that validation fires before any DB call — an oversized display_name
 * is rejected immediately without reaching Supabase (behavior enforced by audit).
 */

// ─── Hoisted mock state ──────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({ testClient: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(async () => hoisted.testClient),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Admin client is imported by profile.ts — stub it so the module loads cleanly
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────
import { updateProfile, changePassword } from "@/lib/actions/profile";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user1" } },
        error: null,
      }),
    },
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi
        .fn()
        .mockResolvedValue({ error: null }),
    }),
  };
}

/**
 * Client for changePassword tests.
 * Exposes signInWithPassword as a named spy so tests can assert it was not called.
 */
function makePasswordClient() {
  const signInWithPassword = vi.fn().mockResolvedValue({ error: null });
  const updateUser = vi.fn().mockResolvedValue({ error: null });
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user1", email: "user@example.com" } },
        error: null,
      }),
      signInWithPassword,
      updateUser,
    },
    signInWithPassword, // exposed shortcut for assertions
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("updateProfile — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.testClient = makeClient();
  });

  it("throws when display_name exceeds 100 characters", async () => {
    await expect(
      updateProfile({ display_name: "x".repeat(101) })
    ).rejects.toThrow("Display name");
  });

  it("throws before reaching the DB when display_name is too long", async () => {
    const client = makeClient();
    hoisted.testClient = client;

    await expect(
      updateProfile({ display_name: "x".repeat(101) })
    ).rejects.toThrow();

    // createServerSupabaseClient should never have been called
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    expect(vi.mocked(createServerSupabaseClient)).not.toHaveBeenCalled();
  });

  it("error message mentions max length", async () => {
    await expect(
      updateProfile({ display_name: "x".repeat(101) })
    ).rejects.toThrow("100");
  });

  it("throws when first_name exceeds 100 characters", async () => {
    await expect(
      updateProfile({ first_name: "a".repeat(101) })
    ).rejects.toThrow("First name");
  });

  it("throws when last_name exceeds 100 characters", async () => {
    await expect(
      updateProfile({ last_name: "b".repeat(101) })
    ).rejects.toThrow("Last name");
  });

  it("throws for an invalid primary_currency", async () => {
    await expect(
      updateProfile({ primary_currency: "GBP" as "EUR" })
    ).rejects.toThrow("Invalid currency");
  });

  it("throws for an invalid theme", async () => {
    await expect(
      updateProfile({ theme: "neon" })
    ).rejects.toThrow("Invalid theme");
  });

  it("accepts a display_name of exactly 100 characters without throwing", async () => {
    // The DB call returns no error — just verify no validation throws
    const client = makeClient();
    (client.from as ReturnType<typeof vi.fn>).mockReturnValue({
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    hoisted.testClient = client;

    await expect(
      updateProfile({ display_name: "x".repeat(100) })
    ).resolves.toBeUndefined();
  });
});

// ─── changePassword validation ────────────────────────────────────────────────

/**
 * changePassword order of operations:
 *   1. createServerSupabaseClient()   ← always called
 *   2. getUser()                      ← always called
 *   3. validation (length, complexity) ← throws here on bad input
 *   4. signInWithPassword()           ← NOT reached when validation fails
 *   5. updateUser()
 *
 * Tests verify that validation fires BEFORE the network round-trip.
 */
describe("changePassword — input validation", () => {
  const CURRENT = "CurrentP@ss1";
  const VALID_NEW = "ValidNew1A";

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.testClient = makePasswordClient();
  });

  it("throws for a new password shorter than 8 characters", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    await expect(changePassword(CURRENT, "Ab1")).rejects.toThrow();

    // createServerSupabaseClient must have been called (getUser is needed first)
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    expect(vi.mocked(createServerSupabaseClient)).toHaveBeenCalled();
    // signInWithPassword must NOT have been called — validation fires before it
    expect(client.signInWithPassword).not.toHaveBeenCalled();
  });

  it("throws for a new password longer than 72 characters", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    await expect(changePassword(CURRENT, "A1a" + "x".repeat(70))).rejects.toThrow();

    expect(client.signInWithPassword).not.toHaveBeenCalled();
  });

  it("throws when new password has no uppercase letter", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    await expect(changePassword(CURRENT, "nouppercase1")).rejects.toThrow();

    expect(client.signInWithPassword).not.toHaveBeenCalled();
  });

  it("throws when new password has no lowercase letter", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    await expect(changePassword(CURRENT, "NOLOWERCASE1")).rejects.toThrow();

    expect(client.signInWithPassword).not.toHaveBeenCalled();
  });

  it("throws when new password has no digit", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    await expect(changePassword(CURRENT, "NoDigitHere")).rejects.toThrow();

    expect(client.signInWithPassword).not.toHaveBeenCalled();
  });

  it("calls signInWithPassword when a valid new password is provided", async () => {
    const client = makePasswordClient();
    hoisted.testClient = client;

    // signInWithPassword returns no error → updateUser proceeds
    await expect(changePassword(CURRENT, VALID_NEW)).resolves.toBeUndefined();

    expect(client.signInWithPassword).toHaveBeenCalledOnce();
  });
});
