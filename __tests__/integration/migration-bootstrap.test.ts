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
      "cash_accounts",
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

  it("activity_log has compensates_for column", async () => {
    const admin = getAdminClient();
    // Query with the compensates_for column to verify migration 049 applied
    const { error } = await admin
      .from("activity_log")
      .select("compensates_for")
      .limit(0);
    expect(error, "compensates_for column should exist on activity_log").toBeNull();
  });
});
