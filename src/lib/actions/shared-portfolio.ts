"use server";

import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateShareToken } from "./shares";
import type {
  AcquisitionType,
  Profile,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  CashAccount,
  Wallet,
  Broker,
  InstitutionWithRoles,
  InstitutionRole,
  PortfolioSnapshot,
  SharedPortfolioData,
} from "@/lib/types";
import { normalizeCategory } from "@/lib/stock-categories";
import { MAX_SNAPSHOTS_LIMIT } from "@/lib/constants";
import { pickJoinedName } from "@/lib/supabase/join-utils";
import { findSnapshotAt } from "@/lib/portfolio/snapshot-utils";
import {
  augmentSnapshotsWithManualNavs,
  fetchManualNavInputsFor,
} from "@/lib/portfolio/manual-nav-augmentation";

// SharedPortfolioData and ValidatedShare are defined in @/lib/types — Turbopack
// strips type re-exports from "use server" modules, so consumers (share pages,
// layouts) import those types directly from @/lib/types.

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
      .limit(MAX_SNAPSHOTS_LIMIT),
  ]);

  if (profileRes.error || !profileRes.data) {
    console.error("[shared-portfolio] Profile fetch failed:", profileRes.error?.message);
    return null;
  }
  for (const [label, res] of [
    ["crypto_assets", cryptoAssetsRes],
    ["stock_assets", stockAssetsRes],
    ["cash_accounts", cashAccountsRes],
    ["wallets", walletsRes],
    ["brokers", brokersRes],
    ["institutions", institutionsRes],
    ["snapshots", snapshotsRes],
  ] as const) {
    if (res.error) {
      console.error(`[shared-portfolio] ${label} fetch failed:`, res.error.message);
      return null;
    }
  }

  // profileRes.data is guaranteed non-null at this point by the earlier
  // response-validation loop (lines 67-82) which returns null on missing data.
  const profile: Profile = {
    ...profileRes.data,
    role: profileRes.data.role as Profile["role"],
    status: profileRes.data.status as Profile["status"],
  };
  const cryptoAssetsRaw = cryptoAssetsRes.data ?? [];
  const stockAssetsRaw = stockAssetsRes.data ?? [];
  const wallets: Wallet[] = walletsRes.data ?? [];
  const brokers: Broker[] = brokersRes.data ?? [];
  // Legacy snapshots may have null USD value columns; normalize to 0 to match
  // PortfolioSnapshot domain contract.
  const snapshots: PortfolioSnapshot[] = (snapshotsRes.data ?? []).map((row) => ({
    ...row,
    total_value_usd: row.total_value_usd ?? 0,
    total_value_eur: row.total_value_eur ?? 0,
    crypto_value_usd: row.crypto_value_usd ?? 0,
    stocks_value_usd: row.stocks_value_usd ?? 0,
    cash_value_usd: row.cash_value_usd ?? 0,
  }));

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
      : Promise.resolve({ data: [], error: null }),
    stockAssetIds.length > 0
      ? admin
          .from("stock_positions")
          .select("*")
          .in("stock_asset_id", stockAssetIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cryptoPositionsData.error) {
    console.error("[shared-portfolio] crypto_positions fetch failed:", cryptoPositionsData.error.message);
    return null;
  }
  if (stockPositionsData.error) {
    console.error("[shared-portfolio] stock_positions fetch failed:", stockPositionsData.error.message);
    return null;
  }

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
          // DB stores acquisition_method as free-text constrained by validation;
          // narrow to the domain enum at the boundary.
          acquisition_method: (p.acquisition_method ?? "bought") as AcquisitionType,
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
    kind: asset.kind as "yahoo" | "manual",
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
    institution_name: pickJoinedName(row.institutions),
    wallet_name: pickJoinedName(row.wallets),
    broker_name: pickJoinedName(row.brokers),
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

  // ── Augment snapshots with manual NAV contributions ────
  // Without this, share-page viewers see an artificial drop in pre-cron
  // chart history for owners holding kind='manual' assets (ELTIFs, SICAVs).
  // The viewer is not the owner — admin client + explicit owner_id bypasses
  // RLS which would otherwise scope to auth.uid() and return zero rows.
  const manualInputs = await fetchManualNavInputsFor(admin, userId);
  const augmentedSnapshots = manualInputs.positions.length > 0
    ? augmentSnapshotsWithManualNavs(snapshots, manualInputs.positions, manualInputs.navs)
    : snapshots;

  // ── Snapshot lookups for change calculations ──────────
  // Snapshot lookups use `findSnapshotAt` (binary search, O(log n) per call).
  // `augmentedSnapshots` is sorted ascending by snapshot_date from the DB query.
  return {
    share,
    profile,
    cryptoAssets,
    stockAssets,
    cashAccounts,
    wallets,
    brokers,
    institutions,
    snapshots: augmentedSnapshots,
    snap3d: findSnapshotAt(augmentedSnapshots, 3),
    snap7d: findSnapshotAt(augmentedSnapshots, 7),
    snap30d: findSnapshotAt(augmentedSnapshots, 30),
    snap90d: findSnapshotAt(augmentedSnapshots, 90),
    snap1y: findSnapshotAt(augmentedSnapshots, 365),
    // "All" = earliest snapshot (snapshots array is now all-time)
    snapAll: augmentedSnapshots.length > 0 ? augmentedSnapshots[0] : null,
  };
});
