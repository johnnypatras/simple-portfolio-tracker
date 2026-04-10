"use server";

import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateShareToken, type ValidatedShare } from "./shares";
import type {
  Profile,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  CashAccount,
  Wallet,
  Broker,
  InstitutionWithRoles,
  InstitutionRole,
  PortfolioSnapshot,
} from "@/lib/types";
import { normalizeCategory } from "@/lib/stock-categories";

// ─── Shared portfolio bundle ───────────────────────────

export interface SharedPortfolioData {
  share: ValidatedShare;
  profile: Profile;
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  cashAccounts: CashAccount[];
  wallets: Wallet[];
  brokers: Broker[];
  institutions: InstitutionWithRoles[];
  snapshots: PortfolioSnapshot[];
  snap3d: PortfolioSnapshot | null;
  snap7d: PortfolioSnapshot | null;
  snap30d: PortfolioSnapshot | null;
  snap90d: PortfolioSnapshot | null;
  snap1y: PortfolioSnapshot | null;
  snapAll: PortfolioSnapshot | null;
}

/**
 * Validate a share token and fetch the owner's full portfolio data.
 * Returns null if the token is invalid/expired/revoked.
 * Uses service-role client to bypass RLS.
 */
export const getSharedPortfolio = cache(async function getSharedPortfolio(
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
    cashAccountsRes,
    walletsRes,
    brokersRes,
    institutionsRes,
    snapshotsRes,
  ] = await Promise.all([
    admin.from("profiles").select("*").eq("id", userId).single(),
    admin.from("crypto_assets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("stock_assets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("cash_accounts").select("*, institutions(name), wallets(name), brokers(name)").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("wallets").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("brokers").select("*").eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: true }),
    admin.from("institutions").select("*").eq("user_id", userId).is("deleted_at", null).order("name"),
    // All snapshots — chart and panel all-time change share this data.
    // Explicit .limit() overrides PostgREST's 1000-row default.
    admin.from("portfolio_snapshots").select("*").eq("user_id", userId)
      .order("snapshot_date", { ascending: true })
      .limit(100_000),
  ]);

  if (profileRes.error || !profileRes.data) return null;

  const profile = profileRes.data as Profile;
  const cryptoAssetsRaw = cryptoAssetsRes.data ?? [];
  const stockAssetsRaw = stockAssetsRes.data ?? [];
  const wallets = (walletsRes.data ?? []) as Wallet[];
  const brokers = (brokersRes.data ?? []) as Broker[];
  const snapshots = (snapshotsRes.data ?? []) as PortfolioSnapshot[];

  // ── Build crypto and stock assets with positions (parallel) ──
  const cryptoAssetIds = cryptoAssetsRaw.map((a) => a.id);
  const stockAssetIds = stockAssetsRaw.map((a) => a.id);

  const [cryptoPositionsData, stockPositionsData] = await Promise.all([
    cryptoAssetIds.length > 0
      ? admin
          .from("crypto_positions")
          .select("*")
          .in("crypto_asset_id", cryptoAssetIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
    stockAssetIds.length > 0
      ? admin
          .from("stock_positions")
          .select("*")
          .in("stock_asset_id", stockAssetIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] }),
  ]);

  const walletsMap: Record<string, { name: string; wallet_type: Wallet["wallet_type"] }> = {};
  for (const w of wallets) {
    walletsMap[w.id] = { name: w.name, wallet_type: w.wallet_type };
  }

  const cryptoAssets: CryptoAssetWithPositions[] = cryptoAssetsRaw.map((asset) => ({
    ...asset,
    positions: (cryptoPositionsData.data ?? [])
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

  const brokersMap: Record<string, string> = {};
  for (const b of brokers) {
    brokersMap[b.id] = b.name;
  }

  const stockAssets: StockAssetWithPositions[] = stockAssetsRaw.map((asset) => ({
    ...asset,
    category: normalizeCategory(asset.category),
    positions: (stockPositionsData.data ?? [])
      .filter((p) => p.stock_asset_id === asset.id)
      .map((p) => ({
        ...p,
        quantity: Number(p.quantity),
        broker_name: brokersMap[p.broker_id] ?? "Unknown",
      })),
  }));

  // ── Flatten cash accounts with joined names ────────────
  const cashAccounts: CashAccount[] = (cashAccountsRes.data ?? []).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    institution_id: row.institution_id,
    name: row.name,
    currency: row.currency,
    balance: row.balance,
    apy: row.apy,
    region: row.region,
    wallet_id: row.wallet_id,
    broker_id: row.broker_id,
    last_was_adjustment: row.last_was_adjustment ?? false,
    last_was_transfer: row.last_was_transfer ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    institution_name: (row.institutions as { name: string } | null)?.name ?? null,
    wallet_name: (row.wallets as { name: string } | null)?.name ?? null,
    broker_name: (row.brokers as { name: string } | null)?.name ?? null,
  }));

  // ── Build institutions with roles ─────────────────────
  const walletInstIds = new Set(wallets.map((w) => w.institution_id).filter(Boolean));
  const brokerInstIds = new Set(brokers.map((b) => b.institution_id).filter(Boolean));
  const cashInstIds = new Set(cashAccounts.map((c) => c.institution_id).filter(Boolean));

  const institutions: InstitutionWithRoles[] = (institutionsRes.data ?? []).map((inst) => {
    const roles: InstitutionRole[] = [];
    if (walletInstIds.has(inst.id)) roles.push("wallet");
    if (brokerInstIds.has(inst.id)) roles.push("broker");
    if (cashInstIds.has(inst.id)) roles.push("bank");
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
    cashAccounts,
    wallets,
    brokers,
    institutions,
    snapshots,
    snap3d: findSnapshotAt(3),
    snap7d: findSnapshotAt(7),
    snap30d: findSnapshotAt(30),
    snap90d: findSnapshotAt(90),
    snap1y: findSnapshotAt(365),
    // "All" = earliest snapshot (snapshots array is now all-time)
    snapAll: snapshots.length > 0 ? snapshots[0] : null,
  };
});
