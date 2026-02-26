"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { PortfolioBackup } from "@/lib/actions/export";

// ─── Types ──────────────────────────────────────────────

export interface ImportResult {
  ok: true;
  counts: {
    institutions: number;
    wallets: number;
    brokers: number;
    bankAccounts: number;
    cryptoAssets: number;
    cryptoPositions: number;
    stockAssets: number;
    stockPositions: number;
    exchangeDeposits: number;
    brokerDeposits: number;
    tradeEntries: number;
    snapshots: number;
  };
  skipped: {
    institutions: number;
    wallets: number;
    brokers: number;
    bankAccounts: number;
    cryptoAssets: number;
    stockAssets: number;
    exchangeDeposits: number;
    brokerDeposits: number;
    snapshots: number;
  };
}

export interface ImportError {
  ok: false;
  error: string;
}

// ─── Validation ─────────────────────────────────────────

export async function validateBackup(
  data: unknown
): Promise<{ ok: true; preview: PortfolioBackup } | { ok: false; error: string }> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Invalid JSON: expected an object" };
  }

  const d = data as Record<string, unknown>;

  if (d.version !== 1) {
    return { ok: false, error: `Unsupported backup version: ${d.version}` };
  }

  const requiredArrays = [
    "institutions", "wallets", "brokers", "cryptoAssets", "stockAssets",
    "bankAccounts", "exchangeDeposits", "brokerDeposits", "tradeEntries", "snapshots",
  ];

  for (const key of requiredArrays) {
    if (!Array.isArray(d[key])) {
      return { ok: false, error: `Missing or invalid field: ${key}` };
    }
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

  // ── Replace mode: clear all existing data first ──
  if (mode === "replace") {
    const tables = [
      "activity_log", "portfolio_snapshots", "diary_entries", "trade_entries",
      "exchange_deposits", "broker_deposits", "stock_assets", "crypto_assets",
      "bank_accounts", "brokers", "wallets", "institutions",
    ];
    for (const table of tables) {
      const { error } = await supabase.from(table).delete().eq("user_id", uid);
      if (error) return { ok: false, error: `Failed to clear ${table}: ${error.message}` };
    }
  }

  // ID mapping: old UUID → new UUID
  const instMap = new Map<string, string>();
  const walletMap = new Map<string, string>();
  const brokerMap = new Map<string, string>();
  const cryptoAssetMap = new Map<string, string>();
  const stockAssetMap = new Map<string, string>();

  const counts = {
    institutions: 0, wallets: 0, brokers: 0, bankAccounts: 0,
    cryptoAssets: 0, cryptoPositions: 0, stockAssets: 0, stockPositions: 0,
    exchangeDeposits: 0, brokerDeposits: 0, tradeEntries: 0, snapshots: 0,
  };
  const skipped = {
    institutions: 0, wallets: 0, brokers: 0, bankAccounts: 0,
    cryptoAssets: 0, stockAssets: 0, exchangeDeposits: 0, brokerDeposits: 0,
    snapshots: 0,
  };

  // ── 1. Institutions ───────────────────────────────────
  for (const inst of data.institutions) {
    // Dedup by name
    const { data: existing } = await supabase
      .from("institutions")
      .select("id")
      .eq("user_id", uid)
      .eq("name", inst.name)
      .is("deleted_at", null)
      .limit(1);

    if (existing && existing.length > 0) {
      instMap.set(inst.id, existing[0].id);
      skipped.institutions++;
    } else {
      const { data: created, error } = await supabase
        .from("institutions")
        .insert({ user_id: uid, name: inst.name })
        .select("id")
        .single();
      if (error) return { ok: false, error: `Institution "${inst.name}": ${error.message}` };
      instMap.set(inst.id, created.id);
      counts.institutions++;
    }
  }

  // ── 2. Wallets ────────────────────────────────────────
  for (const w of data.wallets) {
    const mappedInstId = w.institution_id ? instMap.get(w.institution_id) ?? null : null;

    // Dedup by name + wallet_type
    const { data: existing } = await supabase
      .from("wallets")
      .select("id")
      .eq("user_id", uid)
      .eq("name", w.name)
      .eq("wallet_type", w.wallet_type)
      .is("deleted_at", null)
      .limit(1);

    if (existing && existing.length > 0) {
      walletMap.set(w.id, existing[0].id);
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
      if (error) return { ok: false, error: `Wallet "${w.name}": ${error.message}` };
      walletMap.set(w.id, created.id);
      counts.wallets++;
    }
  }

  // ── 3. Brokers ────────────────────────────────────────
  for (const b of data.brokers) {
    const mappedInstId = b.institution_id ? instMap.get(b.institution_id) ?? null : null;

    const { data: existing } = await supabase
      .from("brokers")
      .select("id")
      .eq("user_id", uid)
      .eq("name", b.name)
      .is("deleted_at", null)
      .limit(1);

    if (existing && existing.length > 0) {
      brokerMap.set(b.id, existing[0].id);
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
      if (error) return { ok: false, error: `Broker "${b.name}": ${error.message}` };
      brokerMap.set(b.id, created.id);
      counts.brokers++;
    }
  }

  // ── 4. Bank Accounts ──────────────────────────────────
  for (const ba of data.bankAccounts) {
    const mappedInstId = ba.institution_id ? instMap.get(ba.institution_id) ?? null : null;

    const { data: existing } = await supabase
      .from("bank_accounts")
      .select("id")
      .eq("user_id", uid)
      .eq("name", ba.name)
      .eq("currency", ba.currency)
      .is("deleted_at", null)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped.bankAccounts++;
    } else {
      const { error } = await supabase
        .from("bank_accounts")
        .insert({
          user_id: uid,
          name: ba.name,
          bank_name: ba.bank_name,
          region: ba.region,
          currency: ba.currency,
          balance: ba.balance,
          apy: ba.apy,
          institution_id: mappedInstId,
        });
      if (error) return { ok: false, error: `Bank account "${ba.name}": ${error.message}` };
      counts.bankAccounts++;
    }
  }

  // ── 5. Crypto Assets + Positions ──────────────────────
  for (const asset of data.cryptoAssets) {
    // Dedup by coingecko_id (more reliable than ticker)
    const { data: existing } = await supabase
      .from("crypto_assets")
      .select("id")
      .eq("user_id", uid)
      .eq("coingecko_id", asset.coingecko_id)
      .is("deleted_at", null)
      .limit(1);

    let newAssetId: string;
    if (existing && existing.length > 0) {
      newAssetId = existing[0].id;
      cryptoAssetMap.set(asset.id, newAssetId);
      skipped.cryptoAssets++;
    } else {
      const { data: created, error } = await supabase
        .from("crypto_assets")
        .insert({
          user_id: uid,
          ticker: asset.ticker,
          name: asset.name,
          coingecko_id: asset.coingecko_id,
          chain: asset.chain ?? null,
          subcategory: asset.subcategory ?? null,
          image_url: asset.image_url ?? null,
        })
        .select("id")
        .single();
      if (error) return { ok: false, error: `Crypto asset "${asset.ticker}": ${error.message}` };
      newAssetId = created.id;
      cryptoAssetMap.set(asset.id, newAssetId);
      counts.cryptoAssets++;
    }

    // Import positions for this asset
    for (const pos of asset.positions) {
      const mappedWalletId = walletMap.get(pos.wallet_id);
      if (!mappedWalletId) continue; // wallet wasn't imported/found

      // Check if position already exists for this asset+wallet
      const { data: existingPos } = await supabase
        .from("crypto_positions")
        .select("id")
        .eq("crypto_asset_id", newAssetId)
        .eq("wallet_id", mappedWalletId)
        .is("deleted_at", null)
        .limit(1);

      if (existingPos && existingPos.length > 0) continue; // skip duplicate

      const { error } = await supabase
        .from("crypto_positions")
        .insert({
          crypto_asset_id: newAssetId,
          wallet_id: mappedWalletId,
          quantity: pos.quantity,
          acquisition_method: pos.acquisition_method ?? "bought",
          apy: pos.apy ?? 0,
        });
      if (error) return { ok: false, error: `Crypto position ${asset.ticker}/${pos.wallet_name}: ${error.message}` };
      counts.cryptoPositions++;
    }
  }

  // ── 6. Stock Assets + Positions ───────────────────────
  for (const asset of data.stockAssets) {
    // Dedup by ticker
    const { data: existing } = await supabase
      .from("stock_assets")
      .select("id")
      .eq("user_id", uid)
      .eq("ticker", asset.ticker)
      .is("deleted_at", null)
      .limit(1);

    let newAssetId: string;
    if (existing && existing.length > 0) {
      newAssetId = existing[0].id;
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
          yahoo_ticker: asset.yahoo_ticker ?? null,
          category: asset.category ?? "individual_stock",
          tags: asset.tags ?? [],
          currency: asset.currency ?? "USD",
          subcategory: asset.subcategory ?? null,
        })
        .select("id")
        .single();
      if (error) return { ok: false, error: `Stock asset "${asset.ticker}": ${error.message}` };
      newAssetId = created.id;
      stockAssetMap.set(asset.id, newAssetId);
      counts.stockAssets++;
    }

    // Import positions for this asset
    for (const pos of asset.positions) {
      const mappedBrokerId = brokerMap.get(pos.broker_id);
      if (!mappedBrokerId) continue; // broker wasn't imported/found

      const { data: existingPos } = await supabase
        .from("stock_positions")
        .select("id")
        .eq("stock_asset_id", newAssetId)
        .eq("broker_id", mappedBrokerId)
        .is("deleted_at", null)
        .limit(1);

      if (existingPos && existingPos.length > 0) continue; // skip duplicate

      const { error } = await supabase
        .from("stock_positions")
        .insert({
          stock_asset_id: newAssetId,
          broker_id: mappedBrokerId,
          quantity: pos.quantity,
        });
      if (error) return { ok: false, error: `Stock position ${asset.ticker}/${pos.broker_name}: ${error.message}` };
      counts.stockPositions++;
    }
  }

  // ── 7. Exchange Deposits ──────────────────────────────
  for (const dep of data.exchangeDeposits) {
    const mappedWalletId = walletMap.get(dep.wallet_id);
    if (!mappedWalletId) continue;

    const { data: existing } = await supabase
      .from("exchange_deposits")
      .select("id")
      .eq("user_id", uid)
      .eq("wallet_id", mappedWalletId)
      .eq("currency", dep.currency)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped.exchangeDeposits++;
    } else {
      const { error } = await supabase
        .from("exchange_deposits")
        .insert({
          user_id: uid,
          wallet_id: mappedWalletId,
          currency: dep.currency,
          amount: dep.amount,
          apy: dep.apy ?? 0,
        });
      if (error) return { ok: false, error: `Exchange deposit ${dep.wallet_name}/${dep.currency}: ${error.message}` };
      counts.exchangeDeposits++;
    }
  }

  // ── 8. Broker Deposits ────────────────────────────────
  for (const dep of data.brokerDeposits) {
    const mappedBrokerId = brokerMap.get(dep.broker_id);
    if (!mappedBrokerId) continue;

    const { data: existing } = await supabase
      .from("broker_deposits")
      .select("id")
      .eq("user_id", uid)
      .eq("broker_id", mappedBrokerId)
      .eq("currency", dep.currency)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped.brokerDeposits++;
    } else {
      const { error } = await supabase
        .from("broker_deposits")
        .insert({
          user_id: uid,
          broker_id: mappedBrokerId,
          currency: dep.currency,
          amount: dep.amount,
          apy: dep.apy ?? 0,
        });
      if (error) return { ok: false, error: `Broker deposit ${dep.broker_name}/${dep.currency}: ${error.message}` };
      counts.brokerDeposits++;
    }
  }

  // ── 9. Trade Entries ──────────────────────────────────
  // Always import (no natural dedup key)
  for (const t of data.tradeEntries) {
    const { error } = await supabase
      .from("trade_entries")
      .insert({
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
      });
    if (error) return { ok: false, error: `Trade entry "${t.asset_name}": ${error.message}` };
    counts.tradeEntries++;
  }

  // ── 10. Snapshots ─────────────────────────────────────
  // Upsert by date (unique constraint: user_id + snapshot_date)
  for (const s of data.snapshots) {
    const { error } = await supabase
      .from("portfolio_snapshots")
      .upsert(
        {
          user_id: uid,
          snapshot_date: s.snapshot_date,
          total_value_usd: s.total_value_usd,
          total_value_eur: s.total_value_eur,
          crypto_value_usd: s.crypto_value_usd,
          stocks_value_usd: s.stocks_value_usd,
          cash_value_usd: s.cash_value_usd,
        },
        { onConflict: "user_id,snapshot_date" }
      );
    if (error) {
      skipped.snapshots++;
    } else {
      counts.snapshots++;
    }
  }

  revalidatePath("/dashboard");
  return { ok: true, counts, skipped };
}
