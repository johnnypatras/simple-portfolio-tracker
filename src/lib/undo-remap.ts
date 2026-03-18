// Cash consolidation backward-compat remapping for undo system.
// Historical activity_log entries reference old table/field names.
// Extracted from actions/undo.ts so these pure functions can be tested
// without "use server" async-function constraints.

const TABLE_REMAP: Record<string, string> = {
  bank_accounts: "cash_accounts",
  exchange_deposits: "cash_accounts",
  broker_deposits: "cash_accounts",
};

const SNAPSHOT_FIELD_REMAP: Record<string, Record<string, string>> = {
  exchange_deposits: { amount: "balance" },
  broker_deposits: { amount: "balance" },
};

export function resolveTable(entityTable: string): string {
  return TABLE_REMAP[entityTable] ?? entityTable;
}

export function remapSnapshotFields(
  entityTable: string,
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const remap = SNAPSHOT_FIELD_REMAP[entityTable];
  if (!remap) return snapshot;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    result[remap[key] ?? key] = value;
  }
  return result;
}
