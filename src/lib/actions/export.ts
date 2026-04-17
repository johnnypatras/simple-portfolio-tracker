"use server";

import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { getTradeEntries } from "@/lib/actions/trades";
import { getSnapshots } from "@/lib/actions/snapshots";
import { getProfile } from "@/lib/actions/profile";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/csv";
import { ALL_SNAPSHOTS_DAYS, MAX_QUERY_LIMIT } from "@/lib/constants";
import { getMyShares } from "@/lib/actions/shares";
import type {
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  GoalPrice,
  ActivityLog,
  PortfolioBackup,
} from "@/lib/types";

// ─── Full JSON backup ───────────────────────────────────
// PortfolioBackup type lives in @/lib/types (Turbopack strips
// re-exports from "use server" modules — consumers import from types).

export async function exportFullJson(): Promise<PortfolioBackup> {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const uid = user.id;

  const [
    profile,
    institutions,
    wallets,
    brokers,
    cryptoAssets,
    stockAssets,
    cashAccounts,
    tradeEntries,
    snapshots,
    shares,
    { data: diaryRows },
    { data: activityRows },
  ] = await Promise.all([
    getProfile(),
    getInstitutionsWithRoles(),
    getWallets(),
    getBrokers(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getCashAccounts(),
    getTradeEntries(),
    getSnapshots(ALL_SNAPSHOTS_DAYS),
    getMyShares(),
    supabase
      .from("diary_entries")
      .select("id, entry_date, content, created_at, updated_at")
      .eq("user_id", uid)
      .is("deleted_at", null)
      .order("entry_date", { ascending: true }),
    supabase
      .from("activity_log")
      .select("*")
      .eq("user_id", uid)
      .order("created_at", { ascending: false })
      .limit(MAX_QUERY_LIMIT),
  ]);

  // goal_prices linked through crypto_assets (no direct user_id) — query via asset IDs
  let goalPrices: GoalPrice[] = [];
  const cryptoIds = cryptoAssets.map((a) => a.id);
  if (cryptoIds.length > 0) {
    const { data: gp } = await supabase
      .from("goal_prices")
      .select("id, crypto_asset_id, target_price, weight, label")
      .in("crypto_asset_id", cryptoIds)
      .is("deleted_at", null);
    goalPrices = (gp ?? []).map<GoalPrice>((row) => ({
      id: row.id,
      crypto_asset_id: row.crypto_asset_id,
      target_price: row.target_price,
      weight: row.weight ?? 0.25,
      label: row.label,
    }));
  }

  return {
    version: 4,
    exportedAt: new Date().toISOString(),
    primaryCurrency: profile.primary_currency,
    institutions,
    wallets,
    brokers,
    cryptoAssets,
    stockAssets,
    cashAccounts,
    // Legacy arrays for backward compat with v1/v2 importers. Map the unified
    // CashAccount shape to each legacy type so v1/v2 consumers (which expect
    // `amount` not `balance`, and `bank_name`/`wallet_name`/`broker_name`
    // joined-in) get usable rows rather than silently-mis-shaped objects.
    bankAccounts: cashAccounts
      .filter((c) => !c.wallet_id && !c.broker_id)
      .map<BankAccount>((c) => ({
        id: c.id,
        user_id: c.user_id,
        name: c.name ?? "",
        bank_name: c.name ?? "",
        region: c.region ?? "",
        currency: c.currency,
        balance: c.balance,
        apy: c.apy,
        institution_id: c.institution_id,
        last_was_adjustment: c.last_was_adjustment,
        last_was_transfer: c.last_was_transfer,
        created_at: c.created_at,
        updated_at: c.updated_at,
        deleted_at: c.deleted_at,
      })),
    exchangeDeposits: cashAccounts
      .filter((c): c is typeof c & { wallet_id: string } => c.wallet_id != null)
      .map<ExchangeDeposit>((c) => ({
        id: c.id,
        user_id: c.user_id,
        wallet_id: c.wallet_id,
        wallet_name: c.name ?? "",
        currency: c.currency,
        amount: c.balance,
        apy: c.apy,
        last_was_adjustment: c.last_was_adjustment,
        last_was_transfer: c.last_was_transfer,
        created_at: c.created_at,
        updated_at: c.updated_at,
        deleted_at: c.deleted_at,
      })),
    brokerDeposits: cashAccounts
      .filter((c): c is typeof c & { broker_id: string } => c.broker_id != null)
      .map<BrokerDeposit>((c) => ({
        id: c.id,
        user_id: c.user_id,
        broker_id: c.broker_id,
        broker_name: c.name ?? "",
        currency: c.currency,
        amount: c.balance,
        apy: c.apy,
        last_was_adjustment: c.last_was_adjustment,
        last_was_transfer: c.last_was_transfer,
        created_at: c.created_at,
        updated_at: c.updated_at,
        deleted_at: c.deleted_at,
      })),
    tradeEntries,
    snapshots,
    // DiaryEntry includes user_id which the projection above omits — re-attach
    // from the filter context.
    diaryEntries: (diaryRows ?? []).map((row) => ({ ...row, user_id: uid })),
    goalPrices,
    activityLog: (activityRows ?? []).map<ActivityLog>((row) => ({
      ...row,
      details: row.details as Record<string, unknown> | null,
      before_snapshot: row.before_snapshot as Record<string, unknown> | null,
      after_snapshot: row.after_snapshot as Record<string, unknown> | null,
      cashflow_asset_class: row.cashflow_asset_class as ActivityLog["cashflow_asset_class"],
      cashflow_status: row.cashflow_status as ActivityLog["cashflow_status"],
      delta_status: row.delta_status as ActivityLog["delta_status"],
    })),
    portfolioShares: shares,
    profile: {
      display_name: profile.display_name,
      theme: profile.theme,
    },
  };
}

// ─── CSV: Crypto Holdings ───────────────────────────────

export async function exportCryptoCsv(): Promise<string> {
  const assets = await getCryptoAssetsWithPositions();

  const headers = [
    "Ticker", "Name", "CoinGecko ID", "Chain", "Subcategory",
    "Wallet", "Wallet Type", "Quantity", "Acquisition Method", "APY %",
    "Network",
    "Adjustment", "Transfer",
    "Asset Created", "Position Updated",
  ];

  const rows: (string | number | null)[][] = [];
  for (const asset of assets) {
    for (const pos of asset.positions) {
      rows.push([
        asset.ticker,
        asset.name,
        asset.coingecko_id,
        asset.chain,
        asset.subcategory,
        pos.wallet_name,
        pos.wallet_type,
        pos.quantity,
        pos.acquisition_method,
        pos.apy,
        pos.network,
        pos.last_was_adjustment ? "Yes" : "No",
        pos.last_was_transfer ? "Yes" : "No",
        asset.created_at,
        pos.updated_at,
      ]);
    }
  }

  return toCsv(headers, rows);
}

// ─── CSV: Stock/ETF Holdings ────────────────────────────

export async function exportStocksCsv(): Promise<string> {
  const assets = await getStockAssetsWithPositions();

  const headers = [
    "Ticker", "Name", "ISIN", "Yahoo Ticker", "Category",
    "Currency", "Subcategory", "Tags",
    "Broker", "Quantity", "Adjustment", "Transfer",
    "Asset Created", "Position Updated",
  ];

  const rows: (string | number | null)[][] = [];
  for (const asset of assets) {
    for (const pos of asset.positions) {
      rows.push([
        asset.ticker,
        asset.name,
        asset.isin,
        asset.yahoo_ticker,
        asset.category,
        asset.currency,
        asset.subcategory,
        asset.tags?.join("; ") || null,
        pos.broker_name,
        pos.quantity,
        pos.last_was_adjustment ? "Yes" : "No",
        pos.last_was_transfer ? "Yes" : "No",
        asset.created_at,
        pos.updated_at,
      ]);
    }
  }

  return toCsv(headers, rows);
}

// ─── CSV: Cash Accounts ─────────────────────────────────

export async function exportCashCsv(): Promise<string> {
  const cashAccounts = await getCashAccounts();

  const headers = [
    "Type", "Account Name", "Institution", "Currency", "Amount", "APY %",
    "Region", "Adjustment", "Transfer",
    "Created", "Updated",
  ];

  const rows: (string | number | null)[][] = [];

  for (const c of cashAccounts) {
    // Derive origin type from FK presence
    const type = c.wallet_id ? "Exchange Deposit" : c.broker_id ? "Broker Deposit" : "Bank Account";
    const institution = c.wallet_name ?? c.broker_name ?? c.institution_name ?? null;
    rows.push([
      type, c.name, institution, c.currency, c.balance, c.apy,
      c.region, c.last_was_adjustment ? "Yes" : "No", c.last_was_transfer ? "Yes" : "No",
      c.created_at, c.updated_at,
    ]);
  }

  return toCsv(headers, rows);
}

// ─── CSV: Trade Diary ───────────────────────────────────

export async function exportTradesCsv(): Promise<string> {
  const trades = await getTradeEntries();

  const headers = [
    "Date", "Action", "Asset Type", "Asset Name",
    "Quantity", "Price", "Currency", "Total Value", "Notes",
    "Created", "Updated",
  ];

  const rows: (string | number | null)[][] = [];
  for (const t of trades) {
    rows.push([
      t.trade_date,
      t.action,
      t.asset_type,
      t.asset_name,
      t.quantity,
      t.price,
      t.currency,
      t.total_value,
      t.notes,
      t.created_at,
      t.updated_at,
    ]);
  }

  return toCsv(headers, rows);
}

// ─── CSV: Portfolio Snapshots ───────────────────────────

export async function exportSnapshotsCsv(): Promise<string> {
  const snapshots = await getSnapshots(ALL_SNAPSHOTS_DAYS);

  const headers = [
    "Date", "Total USD", "Total EUR",
    "Crypto USD", "Stocks USD", "Cash USD",
  ];

  const rows: (string | number)[][] = [];
  for (const s of snapshots) {
    rows.push([
      s.snapshot_date,
      s.total_value_usd,
      s.total_value_eur,
      s.crypto_value_usd,
      s.stocks_value_usd,
      s.cash_value_usd,
    ]);
  }

  return toCsv(headers, rows);
}

// ─── CSV: Activity Log ──────────────────────────────────

export async function exportActivityLogCsv(): Promise<string> {
  const { exportActivityLogsCsv } = await import("@/lib/actions/activity-log");
  return exportActivityLogsCsv();
}
