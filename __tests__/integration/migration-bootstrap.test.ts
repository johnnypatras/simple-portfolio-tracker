import { describe, it, expect } from "vitest";
import { getAdminClient } from "./setup";

describe("migration bootstrap", () => {
  it("all expected tables are accessible", async () => {
    const admin = getAdminClient();
    const tables = [
      "profiles",
      "invite_codes",
      "crypto_assets",
      "crypto_positions",
      "stock_assets",
      "stock_positions",
      "wallets",
      "brokers",
      "bank_accounts",
      "exchange_deposits",
      "broker_deposits",
      "activity_log",
      "portfolio_snapshots",
      "portfolio_shares",
      "trade_entries",
      "diary_entries",
      "goal_prices",
      "institutions",
    ];

    for (const table of tables) {
      const { error } = await admin.from(table).select("id").limit(0);
      expect(error, `Table ${table} should be accessible`).toBeNull();
    }
  });

  it("undo_transfer_group RPC exists", async () => {
    const admin = getAdminClient();
    const { error } = await admin.rpc("undo_transfer_group", {
      p_group_id: "00000000-0000-0000-0000-000000000000",
    });
    // A nil UUID will always error, but the error should NOT be "function not found".
    // Any domain error (e.g. "No active transfer legs found") confirms the RPC exists.
    expect(error).not.toBeNull();
    expect(error!.message).not.toContain("Could not find");
  });
});
