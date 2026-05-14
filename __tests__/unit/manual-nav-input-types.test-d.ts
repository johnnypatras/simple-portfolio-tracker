// Type-only contract tests for manual NAV input shapes. Runs via
// `npx tsc --noEmit`, not vitest. The @ts-expect-error lines fail at
// compile time if the type DOESN'T error — guards against accidental
// type widening (e.g. someone making `nav` optional on ManualNavInput).

import type {
  ManualNavInput,
  ManualNavUpdate,
  PortfolioBackup,
  ImportResult,
  LatestManualNav,
} from "@/lib/types";

// ── ManualNavInput: required fields ─────────────────────

const valid: ManualNavInput = {
  asset_id: "11111111-1111-1111-1111-111111111111",
  effective_date: "2026-04-01",
  nav: 105.5,
};
void valid;

const withNote: ManualNavInput = {
  asset_id: "11111111-1111-1111-1111-111111111111",
  effective_date: "2026-04-01",
  nav: 105.5,
  note: "Q1 2026 fund letter",
};
void withNote;

// @ts-expect-error nav is required
const missingNav: ManualNavInput = {
  asset_id: "11111111-1111-1111-1111-111111111111",
  effective_date: "2026-04-01",
};
void missingNav;

// @ts-expect-error effective_date is required
const missingDate: ManualNavInput = {
  asset_id: "11111111-1111-1111-1111-111111111111",
  nav: 105.5,
};
void missingDate;

// @ts-expect-error asset_id is required
const missingAssetId: ManualNavInput = {
  effective_date: "2026-04-01",
  nav: 105.5,
};
void missingAssetId;

// ── ManualNavUpdate: round-trip with DB row shape ───────

const dbRow: ManualNavUpdate = {
  id: "row-1",
  user_id: "user-1",
  asset_id: "asset-1",
  effective_date: "2026-04-01",
  nav: 105.5,
  note: null,
  created_at: "2026-05-14T00:00:00Z",
};
void dbRow;

// ── PortfolioBackup version union ───────────────────────

const v4: PortfolioBackup["version"] = 4;
const v5: PortfolioBackup["version"] = 5;
void v4;
void v5;

// @ts-expect-error v6 is not a supported version
const v6: PortfolioBackup["version"] = 6;
void v6;

// ── ImportResult counts include manualNavUpdates ────────

function makeCounts(): ImportResult["counts"] {
  return {
    institutions: 0,
    wallets: 0,
    brokers: 0,
    cashAccounts: 0,
    cryptoAssets: 0,
    cryptoPositions: 0,
    stockAssets: 0,
    stockPositions: 0,
    tradeEntries: 0,
    snapshots: 0,
    diaryEntries: 0,
    goalPrices: 0,
    manualNavUpdates: 0, // required in v5
  };
}
void makeCounts;

// @ts-expect-error manualNavUpdates is required on counts
const missingCount: ImportResult["counts"] = {
  institutions: 0,
  wallets: 0,
  brokers: 0,
  cashAccounts: 0,
  cryptoAssets: 0,
  cryptoPositions: 0,
  stockAssets: 0,
  stockPositions: 0,
  tradeEntries: 0,
  snapshots: 0,
  diaryEntries: 0,
  goalPrices: 0,
};
void missingCount;

// ── LatestManualNav: RPC return shape ───────────────────

const rpcRow: LatestManualNav = {
  asset_id: "asset-1",
  nav: 105.5,
  effective_date: "2026-04-01",
  note: null, // must allow null (RLS-scoped data can have NULL notes)
};
void rpcRow;

const rpcRowWithNote: LatestManualNav = {
  asset_id: "asset-1",
  nav: 105.5,
  effective_date: "2026-04-01",
  note: "Q1 letter",
};
void rpcRowWithNote;
