"use server";

import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { exportFullJson } from "@/lib/actions/export";
import { VALID_THEMES, SUPPORTED_BACKUP_VERSIONS, MAX_NAV_NOTE_LENGTH, type SupportedBackupVersion } from "@/lib/constants";
import type { PortfolioBackup, ImportResult, ImportError } from "@/lib/types";
import type { Database } from "@/types/database";
import {
  validateAmount,
  validateDate,
  validatePastOrTodayDate,
  validateQuantity,
  validateCurrency,
  validateName,
} from "@/lib/validation";

// ─── Types ──────────────────────────────────────────────
// ImportResult, ImportError, PortfolioBackup live in @/lib/types.
// Consumers (settings/import-export-settings.tsx) import directly from types.

// ─── Validation ─────────────────────────────────────────

function hasRequiredFields(item: unknown, fields: string[]): boolean {
  if (typeof item !== "object" || item === null) return false;
  return fields.every((f) => f in item);
}

export async function validateBackup(
  data: unknown
): Promise<{ ok: true; preview: PortfolioBackup } | { ok: false; error: string }> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Invalid JSON: expected an object" };
  }

  const d = data as Record<string, unknown>;

  // Accept any version listed in SUPPORTED_BACKUP_VERSIONS. Bumping the constant
  // automatically widens the validator (and the type at compile time).
  if (!SUPPORTED_BACKUP_VERSIONS.includes(d.version as SupportedBackupVersion)) {
    return { ok: false, error: `Unsupported backup version: ${d.version}` };
  }

  const isUnifiedCash = d.version === 3 || d.version === 4 || d.version === 5;

  // Required arrays differ by version
  const requiredArrays = [
    "institutions", "wallets", "brokers", "cryptoAssets", "stockAssets",
    "tradeEntries", "snapshots",
  ];

  for (const key of requiredArrays) {
    if (!Array.isArray(d[key])) {
      return { ok: false, error: `Missing or invalid field: ${key}` };
    }
  }

  // v3 requires cashAccounts; v1/v2 requires the 3 legacy arrays
  if (isUnifiedCash) {
    if (!Array.isArray(d.cashAccounts)) {
      return { ok: false, error: "Missing or invalid field: cashAccounts" };
    }
  } else {
    for (const key of ["bankAccounts", "exchangeDeposits", "brokerDeposits"]) {
      if (!Array.isArray(d[key])) {
        return { ok: false, error: `Missing or invalid field: ${key}` };
      }
    }
  }

  // Validate item shapes
  const shapeRules: Record<string, string[]> = {
    institutions: ["id", "name"],
    wallets: ["id", "name", "wallet_type"],
    brokers: ["id", "name"],
    cryptoAssets: ["id", "ticker", "name", "coingecko_id"],
    stockAssets: ["id", "ticker", "name"],
    tradeEntries: ["asset_name", "quantity", "price"],
    snapshots: ["snapshot_date", "total_value_usd"],
  };

  // Add cash shape rules based on version
  if (isUnifiedCash) {
    shapeRules.cashAccounts = ["currency", "balance"];
  } else {
    shapeRules.bankAccounts = ["name", "currency", "balance"];
    shapeRules.exchangeDeposits = ["wallet_id", "currency", "amount"];
    shapeRules.brokerDeposits = ["broker_id", "currency", "amount"];
  }

  for (const [key, fields] of Object.entries(shapeRules)) {
    const arr = d[key] as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (!hasRequiredFields(arr[i], fields)) {
        return { ok: false, error: `${key}[${i}] is missing required fields: ${fields.join(", ")}` };
      }
    }
  }

  // v2+ optional arrays — validate shape only when present
  const optionalShapeRules: Record<string, string[]> = {
    diaryEntries: ["entry_date", "content"],
    goalPrices: ["crypto_asset_id", "target_price"],
    // v5+: manual_nav_updates array. Required fields per ManualNavInput.
    manualNavUpdates: ["asset_id", "effective_date", "nav"],
  };

  for (const [key, fields] of Object.entries(optionalShapeRules)) {
    if (d[key] !== undefined && !Array.isArray(d[key])) {
      // Reject non-array, non-undefined values (e.g. malformed JSON
      // payloads like `manualNavUpdates: "string"` would iterate
      // characters in for-of loops downstream).
      return { ok: false, error: `Invalid field: ${key} must be an array if present` };
    }
    if (Array.isArray(d[key])) {
      const arr = d[key] as unknown[];
      for (let i = 0; i < arr.length; i++) {
        if (!hasRequiredFields(arr[i], fields)) {
          return { ok: false, error: `${key}[${i}] is missing required fields: ${fields.join(", ")}` };
        }
      }
    }
  }

  // Deep validation for manualNavUpdates rows (v5+). Run the same per-field
  // validators server-side so corrupt or hand-edited backups can't insert
  // invalid data via the import path's batch upsert.
  if (Array.isArray(d.manualNavUpdates)) {
    for (const [i, raw] of (d.manualNavUpdates as Record<string, unknown>[]).entries()) {
      const navNum = Number(raw.nav);
      if (!Number.isFinite(navNum) || navNum <= 0) {
        return { ok: false, error: `manualNavUpdates[${i}].nav must be a positive finite number` };
      }
      // validatePastOrTodayDate does format + calendar round-trip + future-date
      // rejection. The R2 audit added the validator and wired it into the
      // interactive write paths (addManualNavAsset/upsertManualNav); this
      // closes the import path that was bypassing the future-date check.
      const dateStr = String(raw.effective_date);
      try {
        validatePastOrTodayDate(dateStr, `manualNavUpdates[${i}].effective_date`);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (typeof raw.asset_id !== "string" || raw.asset_id.length === 0) {
        return { ok: false, error: `manualNavUpdates[${i}].asset_id must be a non-empty string` };
      }
      if (raw.note != null && typeof raw.note !== "string") {
        return { ok: false, error: `manualNavUpdates[${i}].note must be a string or null` };
      }
      if (typeof raw.note === "string" && raw.note.length > MAX_NAV_NOTE_LENGTH) {
        return { ok: false, error: `manualNavUpdates[${i}].note exceeds ${MAX_NAV_NOTE_LENGTH} characters` };
      }
    }
  }

  // ── Normalize v1/v2 → v3 format ────────────────────────
  // Convert 3 legacy arrays into unified cashAccounts for consistent processing
  if (!isUnifiedCash) {
    const cashAccounts: Record<string, unknown>[] = [];

    for (const ba of (d.bankAccounts as Record<string, unknown>[])) {
      cashAccounts.push({
        ...ba,
        balance: ba.balance,
        wallet_id: null,
        broker_id: null,
      });
    }
    for (const dep of (d.exchangeDeposits as Record<string, unknown>[])) {
      cashAccounts.push({
        ...dep,
        balance: dep.amount,
        name: null,
        broker_id: null,
      });
    }
    for (const dep of (d.brokerDeposits as Record<string, unknown>[])) {
      cashAccounts.push({
        ...dep,
        balance: dep.amount,
        name: null,
        wallet_id: null,
      });
    }

    d.cashAccounts = cashAccounts;
  }

  // ── Value validation ──────────────────────────────────
  // Shape is correct — now validate field values to catch bad data
  // before any mutations. Each validator throws, so wrap per-item.
  try {
    for (const [i, inst] of (d.institutions as Record<string, unknown>[]).entries()) {
      validateName(String(inst.name), 100, `institutions[${i}].name`);
    }
    for (const [i, w] of (d.wallets as Record<string, unknown>[]).entries()) {
      validateName(String(w.name), 100, `wallets[${i}].name`);
    }
    for (const [i, b] of (d.brokers as Record<string, unknown>[]).entries()) {
      validateName(String(b.name), 100, `brokers[${i}].name`);
    }
    for (const [i, ca] of (d.cashAccounts as Record<string, unknown>[]).entries()) {
      if (ca.name) validateName(String(ca.name), 100, `cashAccounts[${i}].name`);
      validateCurrency(String(ca.currency));
      validateAmount(Number(ca.balance), `cashAccounts[${i}].balance`);
    }
    for (const [i, t] of (d.tradeEntries as Record<string, unknown>[]).entries()) {
      if (t.trade_date) validateDate(String(t.trade_date), `tradeEntries[${i}].trade_date`);
      validateQuantity(Number(t.quantity), `tradeEntries[${i}].quantity`);
      validateAmount(Number(t.price), `tradeEntries[${i}].price`);
    }
    for (const [i, s] of (d.snapshots as Record<string, unknown>[]).entries()) {
      validateDate(String(s.snapshot_date), `snapshots[${i}].snapshot_date`);
    }
    // Crypto/stock positions are nested — validate quantities
    for (const [i, asset] of (d.cryptoAssets as Record<string, unknown>[]).entries()) {
      if (asset.chain != null && String(asset.chain).trim()) {
        validateName(String(asset.chain).trim(), 50, `cryptoAssets[${i}].chain`);
      }
      const positions = (asset as Record<string, unknown>).positions;
      if (Array.isArray(positions)) {
        for (const [j, pos] of (positions as Record<string, unknown>[]).entries()) {
          validateQuantity(Number(pos.quantity), `cryptoAssets[${i}].positions[${j}].quantity`);
          if (pos.network != null && String(pos.network).trim()) {
            validateName(String(pos.network).trim(), 50, `cryptoAssets[${i}].positions[${j}].network`);
          }
        }
      }
    }
    for (const [i, asset] of (d.stockAssets as Record<string, unknown>[]).entries()) {
      const positions = (asset as Record<string, unknown>).positions;
      if (Array.isArray(positions)) {
        for (const [j, pos] of (positions as Record<string, unknown>[]).entries()) {
          validateQuantity(Number(pos.quantity), `stockAssets[${i}].positions[${j}].quantity`);
        }
      }
    }
    if (Array.isArray(d.diaryEntries)) {
      for (const [i, e] of (d.diaryEntries as Record<string, unknown>[]).entries()) {
        if (e.entry_date) validateDate(String(e.entry_date), `diaryEntries[${i}].entry_date`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Validation error";
    return { ok: false, error: `Invalid data: ${msg}` };
  }

  return { ok: true, preview: data as PortfolioBackup };
}

// ─── Import ─────────────────────────────────────────────

export async function importFromJson(
  data: PortfolioBackup,
  mode: "merge" | "replace"
): Promise<ImportResult | ImportError> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const uid = user.id;
  const isReplace = mode === "replace";

  // ── Re-validate before destructive operations ──
  if (isReplace) {
    const check = await validateBackup(data);
    if (!check.ok) return { ok: false, error: check.error };
  }

  // ── Safety backup before destructive replace ──
  let safetyBackup: PortfolioBackup | undefined;
  if (isReplace) {
    try {
      safetyBackup = await exportFullJson();
    } catch {
      return { ok: false, error: "Failed to create safety backup — aborting replace to protect your data." };
    }
  }

  const fail = (error: string): ImportError => {
    // Capture server-side so failed imports surface in Sentry even when the
    // client only shows a toast. User context is derived from the session,
    // which Sentry already attaches.
    Sentry.captureMessage(`import.importFromJson failed: ${error}`, {
      level: "error",
      tags: { action: "import.importFromJson", mode: isReplace ? "replace" : "merge" },
    });
    return {
      ok: false as const,
      error,
      ...(safetyBackup ? { backup: safetyBackup } : {}),
    };
  };

  // ── Replace mode: clear all existing data first ──
  // Children before parents. crypto_positions, stock_positions, and
  // goal_prices don't have user_id — they're cascade-deleted when their
  // parent asset tables are deleted (ON DELETE CASCADE FKs).
  if (isReplace) {
    // Children before parents comment was historical; the delete uses RLS + user_id
    // filter so FK ordering doesn't matter for soft/hard-delete semantics here.
    // Run in parallel — each delete is isolated to its own table and is bounded
    // by the user's RLS scope.
    const tables = [
      "diary_entries",
      "portfolio_snapshots", "trade_entries",
      "cash_accounts",
      "crypto_assets", "stock_assets",
      "brokers", "wallets", "institutions",
    ] as const;
    const results = await Promise.all(
      tables.map(async (table) => ({
        table,
        ...(await supabase.from(table).delete().eq("user_id", uid)),
      }))
    );
    const firstErr = results.find((r) => r.error);
    if (firstErr) return fail(`Failed to clear ${firstErr.table}: ${firstErr.error!.message}`);
  }

  // ID mapping: old UUID → new UUID
  const instMap = new Map<string, string>();
  const walletMap = new Map<string, string>();
  const brokerMap = new Map<string, string>();
  const cryptoAssetMap = new Map<string, string>();
  const stockAssetMap = new Map<string, string>();

  const counts = {
    institutions: 0, wallets: 0, brokers: 0, cashAccounts: 0,
    cryptoAssets: 0, cryptoPositions: 0, stockAssets: 0, stockPositions: 0,
    tradeEntries: 0, snapshots: 0,
    diaryEntries: 0, goalPrices: 0,
    manualNavUpdates: 0,
  };
  const skipped: ImportResult["skipped"] = {
    institutions: 0, wallets: 0, brokers: 0, cashAccounts: 0,
    cryptoAssets: 0, stockAssets: 0,
    snapshots: 0, diaryEntries: 0, goalPrices: 0,
    manualNavUpdates: 0,
  };

  // ── 1. Institutions ───────────────────────────────────
  const existingInstMap = new Map<string, string>();
  if (!isReplace) {
    const { data: existingInsts } = await supabase
      .from("institutions")
      .select("id, name")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const inst of existingInsts ?? []) {
      existingInstMap.set(inst.name, inst.id);
    }
  }

  for (const inst of data.institutions) {
    const existingId = isReplace ? null : (existingInstMap.get(inst.name) ?? null);

    if (existingId) {
      instMap.set(inst.id, existingId);
      skipped.institutions++;
    } else {
      const { data: created, error } = await supabase
        .from("institutions")
        .insert({ user_id: uid, name: inst.name })
        .select("id")
        .single();
      if (error) return fail(`Institution "${inst.name}": ${error.message}`);
      instMap.set(inst.id, created.id);
      counts.institutions++;
    }
  }

  // ── 2. Wallets ────────────────────────────────────────
  const existingWalletMap = new Map<string, string>();
  if (!isReplace) {
    const { data: existingWallets } = await supabase
      .from("wallets")
      .select("id, name, wallet_type")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const w of existingWallets ?? []) {
      existingWalletMap.set(`${w.name}|${w.wallet_type}`, w.id);
    }
  }

  for (const w of data.wallets) {
    const mappedInstId = w.institution_id ? instMap.get(w.institution_id) ?? null : null;
    const existingId = isReplace ? null : (existingWalletMap.get(`${w.name}|${w.wallet_type}`) ?? null);

    if (existingId) {
      walletMap.set(w.id, existingId);
      skipped.wallets++;
    } else {
      const { data: created, error } = await supabase
        .from("wallets")
        .insert({
          user_id: uid,
          name: w.name,
          wallet_type: w.wallet_type,
          privacy_label: w.privacy_label ?? null,
          chain: w.chain ?? null,
          institution_id: mappedInstId,
        })
        .select("id")
        .single();
      if (error) return fail(`Wallet "${w.name}": ${error.message}`);
      walletMap.set(w.id, created.id);
      counts.wallets++;
    }
  }

  // ── 3. Brokers ────────────────────────────────────────
  const existingBrokerMap = new Map<string, string>();
  if (!isReplace) {
    const { data: existingBrokers } = await supabase
      .from("brokers")
      .select("id, name")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const b of existingBrokers ?? []) {
      existingBrokerMap.set(b.name, b.id);
    }
  }

  for (const b of data.brokers) {
    const mappedInstId = b.institution_id ? instMap.get(b.institution_id) ?? null : null;
    const existingId = isReplace ? null : (existingBrokerMap.get(b.name) ?? null);

    if (existingId) {
      brokerMap.set(b.id, existingId);
      skipped.brokers++;
    } else {
      const { data: created, error } = await supabase
        .from("brokers")
        .insert({
          user_id: uid,
          name: b.name,
          institution_id: mappedInstId,
        })
        .select("id")
        .single();
      if (error) return fail(`Broker "${b.name}": ${error.message}`);
      brokerMap.set(b.id, created.id);
      counts.brokers++;
    }
  }

  // ── 4. Cash Accounts (unified — batch insert) ──────────
  // Data arrives as cashAccounts[] (v3 native or normalized from v1/v2 in validateBackup)
  {
    const existingCashSet = new Set<string>();
    if (!isReplace) {
      const { data: existingCash } = await supabase
        .from("cash_accounts")
        .select("name, currency, wallet_id, broker_id")
        .eq("user_id", uid)
        .is("deleted_at", null);
      for (const ca of existingCash ?? []) {
        // Dedup key: wallet_id|broker_id|name|currency
        existingCashSet.add(`${ca.wallet_id ?? ""}|${ca.broker_id ?? ""}|${ca.name ?? ""}|${ca.currency}`);
      }
    }

    const newRows: Database["public"]["Tables"]["cash_accounts"]["Insert"][] = [];

    for (const ca of data.cashAccounts ?? []) {
      const mappedInstId = ca.institution_id ? instMap.get(ca.institution_id) ?? null : null;
      const mappedWalletId = ca.wallet_id ? walletMap.get(ca.wallet_id) ?? null : null;
      const mappedBrokerId = ca.broker_id ? brokerMap.get(ca.broker_id) ?? null : null;

      const dedupKey = `${mappedWalletId ?? ""}|${mappedBrokerId ?? ""}|${ca.name ?? ""}|${ca.currency}`;
      const found = !isReplace && existingCashSet.has(dedupKey);

      if (found) {
        skipped.cashAccounts++;
      } else {
        newRows.push({
          user_id: uid,
          institution_id: mappedInstId,
          name: ca.name ?? null,
          currency: ca.currency,
          balance: ca.balance,
          apy: ca.apy ?? 0,
          region: ca.region ?? null,
          wallet_id: mappedWalletId,
          broker_id: mappedBrokerId,
          last_was_adjustment: ca.last_was_adjustment ?? false,
          last_was_transfer: ca.last_was_transfer ?? false,
        });
      }
    }

    if (newRows.length > 0) {
      const { error } = await supabase.from("cash_accounts").insert(newRows);
      if (error) return fail(`Cash accounts batch: ${error.message}`);
      counts.cashAccounts = newRows.length;
    }
  }

  // ── 5. Crypto Assets + Positions ──────────────────────
  // Pre-fetch existing positions to avoid N+1 queries in merge mode
  const existingCryptoPosSet = new Set<string>();
  if (!isReplace) {
    const { data: existingCryptoPos } = await supabase
      .from("crypto_positions")
      .select("crypto_asset_id, wallet_id")
      .is("deleted_at", null);
    for (const p of existingCryptoPos ?? []) {
      existingCryptoPosSet.add(`${p.crypto_asset_id}|${p.wallet_id}`);
    }
  }

  const existingCryptoMap = new Map<string, string>();
  if (!isReplace) {
    const { data: existingCrypto } = await supabase
      .from("crypto_assets")
      .select("id, coingecko_id, chain")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const c of existingCrypto ?? []) {
      existingCryptoMap.set(`${c.coingecko_id}|${c.chain ?? ""}`, c.id);
    }
  }

  for (const asset of data.cryptoAssets) {
    const existingId = isReplace ? null : (existingCryptoMap.get(`${asset.coingecko_id}|${asset.chain ?? ""}`) ?? null);

    let newAssetId: string;
    if (existingId) {
      newAssetId = existingId;
      cryptoAssetMap.set(asset.id, newAssetId);
      skipped.cryptoAssets++;
    } else {
      const { data: created, error } = await supabase
        .from("crypto_assets")
        .insert({
          user_id: uid,
          ticker: asset.ticker,
          name: asset.name,
          coingecko_id: /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(asset.coingecko_id)
            ? asset.coingecko_id
            : asset.coingecko_id.replace(/[^a-z0-9-]/gi, "").toLowerCase(),
          chain: asset.chain?.trim() || null,
          subcategory: asset.subcategory ?? null,
          image_url: asset.image_url ?? null,
        })
        .select("id")
        .single();
      if (error) return fail(`Crypto asset "${asset.ticker}": ${error.message}`);
      newAssetId = created.id;
      cryptoAssetMap.set(asset.id, newAssetId);
      counts.cryptoAssets++;
    }

    // Batch positions per asset
    const posRows: Database["public"]["Tables"]["crypto_positions"]["Insert"][] = [];
    for (const pos of asset.positions) {
      const mappedWalletId = walletMap.get(pos.wallet_id);
      if (!mappedWalletId) continue;

      if (!isReplace && existingCryptoPosSet.has(`${newAssetId}|${mappedWalletId}`)) continue;

      posRows.push({
        crypto_asset_id: newAssetId,
        wallet_id: mappedWalletId,
        quantity: pos.quantity,
        acquisition_method: pos.acquisition_method ?? "bought",
        apy: pos.apy ?? 0,
        network: pos.network?.trim() || null,
        last_was_adjustment: pos.last_was_adjustment ?? false,
        last_was_transfer: pos.last_was_transfer ?? false,
      });
    }

    if (posRows.length > 0) {
      const { error } = await supabase.from("crypto_positions").insert(posRows);
      if (error) return fail(`Crypto positions for ${asset.ticker}: ${error.message}`);
      counts.cryptoPositions += posRows.length;
    }
  }

  // ── 5b. Goal Prices ───────────────────────────────────
  // Strategy: DELETE then INSERT. Avoids the PostgREST / partial-unique-index
  // mismatch: `uq_goal_prices_active` is `(crypto_asset_id, label) WHERE
  // deleted_at IS NULL`, which Supabase JS's `.upsert({ onConflict })` cannot
  // target (PostgreSQL requires the `WHERE` clause in `ON CONFLICT`). "Restore
  // from backup" semantics say the backup is the source of truth — wipe the
  // user's existing goal_prices for the imported assets and insert fresh.
  // Goals whose crypto_asset_id doesn't map to a newly-created asset
  // (e.g. cross-portfolio restore) are silently dropped.
  if (data.goalPrices?.length) {
    const goalRows: Database["public"]["Tables"]["goal_prices"]["Insert"][] = [];
    for (const gp of data.goalPrices) {
      const mappedAssetId = cryptoAssetMap.get(gp.crypto_asset_id);
      if (!mappedAssetId) continue;
      goalRows.push({
        crypto_asset_id: mappedAssetId,
        target_price: gp.target_price,
        weight: gp.weight ?? 0.25,
        label: gp.label ?? null,
      });
    }
    if (goalRows.length > 0) {
      // 1. Delete existing goal_prices for the assets being restored.
      //    RLS + FK scope the delete to the current user via crypto_assets.
      const restoredAssetIds = [...new Set(goalRows.map((r) => r.crypto_asset_id as string))];
      const { error: delErr } = await supabase
        .from("goal_prices")
        .delete()
        .in("crypto_asset_id", restoredAssetIds);
      if (delErr) {
        console.warn(`[import] Goal prices pre-delete failed:`, delErr.message);
        skipped.goalPrices += goalRows.length;
      } else {
        // 2. Insert the fresh rows from the backup.
        const { error: insErr } = await supabase.from("goal_prices").insert(goalRows);
        if (insErr) {
          console.warn(`[import] Goal prices insert failed (${goalRows.length} rows):`, insErr.message);
          skipped.goalPrices += goalRows.length;
        } else {
          counts.goalPrices += goalRows.length;
        }
      }
    }
  }

  // ── 6. Stock Assets + Positions ───────────────────────
  // Pre-fetch existing stock assets and positions to avoid N+1 queries
  const existingStockByYahoo = new Map<string, string>();
  const existingStockByTicker = new Map<string, string>();
  const existingStockPosSet = new Set<string>();
  if (!isReplace) {
    const { data: existingStocks } = await supabase
      .from("stock_assets")
      .select("id, ticker, yahoo_ticker")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const s of existingStocks ?? []) {
      if (s.yahoo_ticker) existingStockByYahoo.set(s.yahoo_ticker, s.id);
      else existingStockByTicker.set(s.ticker, s.id);
    }
    const { data: existingStockPos } = await supabase
      .from("stock_positions")
      .select("stock_asset_id, broker_id")
      .is("deleted_at", null);
    for (const p of existingStockPos ?? []) {
      existingStockPosSet.add(`${p.stock_asset_id}|${p.broker_id}`);
    }
  }

  for (const asset of data.stockAssets) {
    let existingId: string | null = null;

    if (!isReplace) {
      existingId = asset.yahoo_ticker
        ? (existingStockByYahoo.get(asset.yahoo_ticker) ?? null)
        : (existingStockByTicker.get(asset.ticker) ?? null);
    }

    let newAssetId: string;
    if (existingId) {
      newAssetId = existingId;
      stockAssetMap.set(asset.id, newAssetId);
      skipped.stockAssets++;
    } else {
      const { data: created, error } = await supabase
        .from("stock_assets")
        .insert({
          user_id: uid,
          ticker: asset.ticker,
          name: asset.name,
          isin: asset.isin ?? null,
          yahoo_ticker: asset.yahoo_ticker
            ? (/^[A-Za-z0-9^=.\-]{1,20}$/.test(asset.yahoo_ticker)
              ? asset.yahoo_ticker
              : asset.yahoo_ticker.replace(/[^A-Za-z0-9^=.\-]/g, "").slice(0, 20) || null)
            : null,
          category: asset.category ?? "individual_stock",
          tags: asset.tags ?? [],
          currency: asset.currency ?? "USD",
          subcategory: asset.subcategory ?? null,
          // v5+: preserve the price-source discriminator. Without this, a
          // backup with kind='manual' assets restores them as 'yahoo' (the
          // DB default) and the chart augmentation pipeline silently never
          // applies — NAV history rows would orphan against an asset whose
          // partition no longer matches.
          kind: asset.kind ?? "yahoo",
        })
        .select("id")
        .single();
      if (error) return fail(`Stock asset "${asset.ticker}": ${error.message}`);
      newAssetId = created.id;
      stockAssetMap.set(asset.id, newAssetId);
      counts.stockAssets++;
    }

    // Batch positions per asset
    const posRows: Database["public"]["Tables"]["stock_positions"]["Insert"][] = [];
    for (const pos of asset.positions) {
      const mappedBrokerId = brokerMap.get(pos.broker_id);
      if (!mappedBrokerId) continue;

      if (!isReplace && existingStockPosSet.has(`${newAssetId}|${mappedBrokerId}`)) continue;

      posRows.push({
        stock_asset_id: newAssetId,
        broker_id: mappedBrokerId,
        quantity: pos.quantity,
        last_was_adjustment: pos.last_was_adjustment ?? false,
        last_was_transfer: pos.last_was_transfer ?? false,
      });
    }

    if (posRows.length > 0) {
      const { error } = await supabase.from("stock_positions").insert(posRows);
      if (error) return fail(`Stock positions for ${asset.ticker}: ${error.message}`);
      counts.stockPositions += posRows.length;
    }
  }

  // ── 6b. Manual NAV updates (v5+ backup field) ──────────
  // Restore the per-asset NAV history for kind='manual' stock_assets. Old
  // asset IDs from the backup are remapped through stockAssetMap to the
  // newly-inserted asset IDs. On conflict (same asset_id + effective_date),
  // we skip — re-importing the same backup is idempotent.
  if (data.manualNavUpdates && data.manualNavUpdates.length > 0) {
    const navRows: Array<{
      user_id: string;
      asset_id: string;
      effective_date: string;
      nav: number;
      note: string | null;
    }> = [];

    for (const nav of data.manualNavUpdates) {
      // Remap to the newly-inserted asset_id. If the backup references an
      // asset_id NOT in stockAssetMap (e.g. partially-edited backup, or a
      // foreign asset_id from another user's portfolio), DROP the row
      // instead of trusting the original UUID — the previous passthrough
      // could plant orphan NAV rows pointing to another user's stock_asset.
      const newAssetId = stockAssetMap.get(nav.asset_id);
      if (!newAssetId) {
        skipped.manualNavUpdates++;
        continue;
      }
      navRows.push({
        user_id: uid,
        asset_id: newAssetId,
        effective_date: nav.effective_date,
        nav: Number(nav.nav),
        note: nav.note ?? null,
      });
    }

    if (navRows.length > 0) {
      // upsert with onConflict on (asset_id, effective_date) so re-imports
      // refresh notes/nav without erroring on the unique index.
      const { error, count } = await supabase
        .from("manual_nav_updates")
        .upsert(navRows, {
          onConflict: "asset_id,effective_date",
          count: "exact",
        });
      if (error) return fail(`Manual NAV updates batch: ${error.message}`);
      // `count` from PostgREST upsert is total rows AFFECTED (inserts + updates
      // combined), not just inserts — so we can't split it. Report all of them
      // under counts.manualNavUpdates. The `skipped.manualNavUpdates` field is
      // populated only by the orphan-asset_id drop above (line 740), which is
      // the genuine "skipped because we refused to import" case.
      counts.manualNavUpdates += count ?? navRows.length;
    }
  }

  // ── 7. Trade Entries (batch upsert by original UUID) ────
  // Dedup via the original `id` from the backup — re-importing the same file
  // is a no-op, while legitimate duplicate trades (different UUIDs) are preserved.
  {
    const tradeRows = data.tradeEntries.map((t) => ({
      ...(t.id ? { id: t.id } : {}),
      user_id: uid,
      trade_date: t.trade_date,
      asset_type: t.asset_type,
      asset_name: t.asset_name,
      action: t.action,
      quantity: t.quantity,
      price: t.price,
      currency: t.currency ?? "USD",
      total_value: t.total_value,
      notes: t.notes ?? null,
    }));

    if (tradeRows.length > 0) {
      const { error } = await supabase
        .from("trade_entries")
        .upsert(tradeRows, { onConflict: "id" });
      if (error) return fail(`Trade entries batch: ${error.message}`);
      counts.tradeEntries = tradeRows.length;
    }
  }

  // ── 8. Snapshots (batch upsert) ───────────────────────
  {
    const snapshotRows = data.snapshots.map((s) => ({
      user_id: uid,
      snapshot_date: s.snapshot_date,
      total_value_usd: s.total_value_usd,
      total_value_eur: s.total_value_eur,
      crypto_value_usd: s.crypto_value_usd,
      stocks_value_usd: s.stocks_value_usd,
      cash_value_usd: s.cash_value_usd,
      crypto_value_eur: s.crypto_value_eur ?? null,
      stocks_value_eur: s.stocks_value_eur ?? null,
      cash_value_eur: s.cash_value_eur ?? null,
      stocks_eur_denominated_value: s.stocks_eur_denominated_value ?? null,
      cash_eur_denominated_value: s.cash_eur_denominated_value ?? null,
    }));

    if (snapshotRows.length > 0) {
      const { error } = await supabase
        .from("portfolio_snapshots")
        .upsert(snapshotRows, { onConflict: "user_id,snapshot_date" });
      if (error) {
        console.error("[import] snapshot upsert failed:", error.message);
        skipped.snapshots += snapshotRows.length;
      } else {
        counts.snapshots = snapshotRows.length;
      }
    }
  }

  // ── 9. Diary Entries (v2+) ────────────────────────────
  if (data.diaryEntries?.length) {
    const rows = data.diaryEntries.map((d) => ({
      user_id: uid,
      entry_date: d.entry_date,
      content: typeof d.content === "string" ? d.content.slice(0, 50000) : "",
    }));
    const { error } = await supabase.from("diary_entries").upsert(rows, { onConflict: "user_id,entry_date" });
    if (error) {
      console.error("[import] Diary entries failed:", error.message);
      // Surface in skipped so the UI can show N lost entries instead of
      // silently reporting success.
      skipped.diaryEntries = rows.length;
    } else {
      counts.diaryEntries = rows.length;
    }
  }

  // ── 10. Profile (v2+) ─────────────────────────────────
  if (data.profile) {
    const profileUpdate: Database["public"]["Tables"]["profiles"]["Update"] = {};
    if (data.profile.display_name && typeof data.profile.display_name === "string" && data.profile.display_name.length <= 100) {
      profileUpdate.display_name = data.profile.display_name;
    }
    if (data.profile.theme && typeof data.profile.theme === "string" && (VALID_THEMES as readonly string[]).includes(data.profile.theme)) {
      profileUpdate.theme = data.profile.theme;
    }
    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await supabase
        .from("profiles")
        .update(profileUpdate)
        .eq("id", uid);
      if (error) {
        console.warn("[import] Profile metadata update failed (non-critical):", error.message);
        skipped.profile = true;
      }
    }
  }

  // activityLog and portfolioShares are export-only (archival) — not imported

  revalidatePath("/dashboard");
  return { ok: true, counts, skipped };
}
