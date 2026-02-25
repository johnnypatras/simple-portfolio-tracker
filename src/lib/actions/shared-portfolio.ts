"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { validateShareToken, type ValidatedShare } from "./shares";
import type {
  Profile,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  Wallet,
  Broker,
  InstitutionWithRoles,
  InstitutionRole,
  PortfolioSnapshot,
  AssetCategory,
} from "@/lib/types";

// ─── Shared portfolio bundle ───────────────────────────

export interface SharedPortfolioData {
  share: ValidatedShare;
  profile: Profile;
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  wallets: Wallet[];
  brokers: Broker[];
  institutions: InstitutionWithRoles[];
  snapshots: PortfolioSnapshot[];
  snap7d: PortfolioSnapshot | null;
  snap30d: PortfolioSnapshot | null;
  snap1y: PortfolioSnapshot | null;
}

/** Normalize old DB category values to current enum */
const OLD_CAT_MAP: Record<string, AssetCategory> = {
  stock: "individual_stock",
  etf_ucits: "etf",
  etf_non_ucits: "etf",
  bond: "bond_fixed_income",
};
function normalizeCategory(raw: string | null | undefined): AssetCategory {
  if (!raw) return "individual_stock";
  return OLD_CAT_MAP[raw] ?? (raw as AssetCategory);
}

/**
 * Validate a share token and fetch the owner's full portfolio data.
 * Returns null if the token is invalid/expired/revoked.
 * Uses service-role client to bypass RLS.
 */
export async function getSharedPortfolio(
  token: string
): Promise<SharedPortfolioData | null> {
  const share = await validateShareToken(token);
  if (!share) return null;

  const admin = createAdminClient();
  const userId = share.owner_id;

  // ── Parallel fetch of all portfolio data ──────────────
  const [
    profileRes,
    cryptoAssetsRes,
    stockAssetsRes,
    bankAccountsRes,
    walletsRes,
    brokersRes,
    exchangeDepositsRes,
    brokerDepositsRes,
    institutionsRes,
    snapshotsRes,
  ] = await Promise.all([
    admin.from("profiles").select("*").eq("id", userId).single(),
    admin.from("crypto_assets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("stock_assets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("bank_accounts").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("wallets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("brokers").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("exchange_deposits").select("*, wallets(name)").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("broker_deposits").select("*, brokers(name)").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("institutions").select("*").eq("user_id", userId).is("deleted_at", null).order("name"),
    // Last 365 days of snapshots for the chart
    admin.from("portfolio_snapshots").select("*").eq("user_id", userId)
      .gte("snapshot_date", new Date(Date.now() - 365 * 86_400_000).toISOString().split("T")[0])
      .order("snapshot_date", { ascending: true }),
  ]);

  if (profileRes.error || !profileRes.data) return null;

  const profile = profileRes.data as Profile;
  const cryptoAssetsRaw = cryptoAssetsRes.data ?? [];
  const stockAssetsRaw = stockAssetsRes.data ?? [];
  const bankAccounts = (bankAccountsRes.data ?? []) as BankAccount[];
  const wallets = (walletsRes.data ?? []) as Wallet[];
  const brokers = (brokersRes.data ?? []) as Broker[];
  const snapshots = (snapshotsRes.data ?? []) as PortfolioSnapshot[];

  // ── Build crypto assets with positions ────────────────
  const cryptoAssetIds = cryptoAssetsRaw.map((a) => a.id);
  let cryptoAssets: CryptoAssetWithPositions[] = [];
  if (cryptoAssetIds.length > 0) {
    const { data: positions } = await admin
      .from("crypto_positions")
      .select("*")
      .in("crypto_asset_id", cryptoAssetIds)
      .is("deleted_at", null);

    const walletsMap: Record<string, { name: string; wallet_type: Wallet["wallet_type"] }> = {};
    for (const w of wallets) {
      walletsMap[w.id] = { name: w.name, wallet_type: w.wallet_type };
    }

    cryptoAssets = cryptoAssetsRaw.map((asset) => ({
      ...asset,
      positions: (positions ?? [])
        .filter((p) => p.crypto_asset_id === asset.id)
        .map((p) => {
          const walletInfo = walletsMap[p.wallet_id];
          return {
            ...p,
            quantity: Number(p.quantity),
            apy: Number(p.apy ?? 0),
            wallet_name: walletInfo?.name ?? "Unknown",
            wallet_type: walletInfo?.wallet_type ?? ("custodial" as const),
          };
        }),
    }));
  }

  // ── Build stock assets with positions ─────────────────
  const stockAssetIds = stockAssetsRaw.map((a) => a.id);
  let stockAssets: StockAssetWithPositions[] = [];
  if (stockAssetIds.length > 0) {
    const { data: positions } = await admin
      .from("stock_positions")
      .select("*")
      .in("stock_asset_id", stockAssetIds)
      .is("deleted_at", null);

    const brokersMap: Record<string, string> = {};
    for (const b of brokers) {
      brokersMap[b.id] = b.name;
    }

    stockAssets = stockAssetsRaw.map((asset) => ({
      ...asset,
      category: normalizeCategory(asset.category),
      positions: (positions ?? [])
        .filter((p) => p.stock_asset_id === asset.id)
        .map((p) => ({
          ...p,
          quantity: Number(p.quantity),
          broker_name: brokersMap[p.broker_id] ?? "Unknown",
        })),
    }));
  }

  // ── Flatten exchange deposits with wallet names ───────
  const exchangeDeposits: ExchangeDeposit[] = (exchangeDepositsRes.data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    wallet_id: row.wallet_id,
    wallet_name: (row.wallets as { name: string })?.name ?? "Unknown",
    currency: row.currency,
    amount: row.amount,
    apy: row.apy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  // ── Flatten broker deposits with broker names ─────────
  const brokerDeposits: BrokerDeposit[] = (brokerDepositsRes.data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    broker_id: row.broker_id,
    broker_name: (row.brokers as { name: string })?.name ?? "Unknown",
    currency: row.currency,
    amount: row.amount,
    apy: row.apy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  // ── Build institutions with roles ─────────────────────
  const walletInstIds = new Set(wallets.map((w) => w.institution_id).filter(Boolean));
  const brokerInstIds = new Set(brokers.map((b) => b.institution_id).filter(Boolean));
  const bankInstIds = new Set(bankAccounts.map((b) => b.institution_id).filter(Boolean));

  const institutions: InstitutionWithRoles[] = (institutionsRes.data ?? []).map((inst) => {
    const roles: InstitutionRole[] = [];
    if (walletInstIds.has(inst.id)) roles.push("wallet");
    if (brokerInstIds.has(inst.id)) roles.push("broker");
    if (bankInstIds.has(inst.id)) roles.push("bank");
    return { ...inst, roles };
  });

  // ── Snapshot lookups for change calculations ──────────
  const findSnapshotAt = (daysAgo: number): PortfolioSnapshot | null => {
    const target = new Date();
    target.setDate(target.getDate() - daysAgo);
    const targetStr = target.toISOString().split("T")[0];
    // Find the most recent snapshot on or before the target date
    const candidates = snapshots.filter((s) => s.snapshot_date <= targetStr);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  };

  return {
    share,
    profile,
    cryptoAssets,
    stockAssets,
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    wallets,
    brokers,
    institutions,
    snapshots,
    snap7d: findSnapshotAt(7),
    snap30d: findSnapshotAt(30),
    snap1y: findSnapshotAt(365),
  };
}
