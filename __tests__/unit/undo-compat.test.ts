import { describe, it, expect, vi } from "vitest";

// Mock "use server" dependencies so the module can be imported in unit tests
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/actions/activity-log", () => ({
  logActivity: vi.fn(),
}));

import { resolveTable, remapSnapshotFields } from "@/lib/actions/undo";

describe("resolveTable", () => {
  it("remaps bank_accounts → cash_accounts", () => {
    expect(resolveTable("bank_accounts")).toBe("cash_accounts");
  });

  it("remaps exchange_deposits → cash_accounts", () => {
    expect(resolveTable("exchange_deposits")).toBe("cash_accounts");
  });

  it("remaps broker_deposits → cash_accounts", () => {
    expect(resolveTable("broker_deposits")).toBe("cash_accounts");
  });

  it("identity: cash_accounts → cash_accounts", () => {
    expect(resolveTable("cash_accounts")).toBe("cash_accounts");
  });

  it("passes through unmapped tables", () => {
    expect(resolveTable("crypto_positions")).toBe("crypto_positions");
  });
});

describe("remapSnapshotFields", () => {
  it("remaps exchange_deposits amount → balance", () => {
    expect(
      remapSnapshotFields("exchange_deposits", { amount: 500, currency: "EUR" }),
    ).toEqual({ balance: 500, currency: "EUR" });
  });

  it("remaps broker_deposits amount → balance", () => {
    expect(
      remapSnapshotFields("broker_deposits", { amount: 200 }),
    ).toEqual({ balance: 200 });
  });

  it("leaves bank_accounts snapshot unchanged", () => {
    expect(
      remapSnapshotFields("bank_accounts", { balance: 1000 }),
    ).toEqual({ balance: 1000 });
  });

  it("leaves cash_accounts snapshot unchanged", () => {
    expect(
      remapSnapshotFields("cash_accounts", { balance: 1000 }),
    ).toEqual({ balance: 1000 });
  });

  it("returns null for null snapshot", () => {
    expect(remapSnapshotFields("exchange_deposits", null)).toBeNull();
  });
});
