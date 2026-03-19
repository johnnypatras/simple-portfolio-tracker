import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("assertLocalSupabase", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws in development when URL points to supabase.co", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).toThrow("SAFETY");
  });

  it("includes hostname in error message", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).toThrow("xyz.supabase.co");
  });

  it("does not throw in development when URL is localhost", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw in production even with supabase.co URL", async () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw when URL is undefined", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw for non-supabase.co URLs", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://evil-supabase.co.attacker.com";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });
});
