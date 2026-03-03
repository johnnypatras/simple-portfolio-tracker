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
    diaryEntries: number;
    goalPrices: number;
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

  // Accept v1 and v2
  if (d.version !== 1 && d.version !== 2) {
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

  // Validate item shapes
  const shapeRules: Record<string, string[]> = {
    institutions: ["id", "name"],
    wallets: ["id", "name", "wallet_type"],
    brokers: ["id", "name"],
    cryptoAssets: ["id", "ticker", "name", "coingecko_id"],
    stockAssets: ["id", "ticker", "name"],
    bankAccounts: ["name", "currency", "balance"],
    exchangeDeposits: ["wallet_id", "currency", "amount"],
    brokerDeposits: ["broker_id", "currency", "amount"],
    tradeEntries: ["asset_name", "quantity", "price"],
    snapshots: ["snapshot_date", "total_value_usd"],
  };

  for (const [key, fields] of Object.entries(shapeRules)) {
    const arr = d[key] as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (!hasRequiredFields(arr[i], fields)) {
        return { ok: false, error: `${key}[${i}] is missing required fields: ${fields.join(", ")}` };
      }
    }
  }

  // v2 optional arrays — validate shape only when present
  const v2ShapeRules: Record<string, string[]> = {
    diaryEntries: ["entry_date", "content"],
    goalPrices: ["crypto_asset_id", "target_price"],
  };

  for (const [key, fields] of Object.entries(v2ShapeRules)) {
    if (Array.isArray(d[key])) {
      const arr = d[key] as unknown[];
      for (let i = 0; i < arr.length; i++) {
        if (!hasRequiredFields(arr[i], fields)) {
          return { ok: false, error: `${key}[${i}] is missing required fields: ${fields.join(", ")}` };
        }
      }
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
  const isReplace = mode === "replace";

  // ── Re-validate before destructive operations ──
  if (isReplace) {
    const check = await validateBackup(data);
    if (!check.ok) return { ok: false, error: check.error };
  }

  // ── Replace mode: clear all existing data first ──
  // Children before parents. crypto_positions, stock_positions, and
  // goal_prices don't have user_id — they're cascade-deleted when their
  // parent asset tables are deleted (ON DELETE CASCADE FKs).
  if (isReplace) {
    const tables = [
      "diary_entries",
      "portfolio_snapshots", "trade_entries",
      "exchange_deposits", "broker_deposits",
      "crypto_assets", "stock_assets",
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
    diaryEntries: 0, goalPrices: 0,
  };
  const skipped = {
    institutions: 0, wallets: 0, brokers: 0, bankAccounts: 0,
    cryptoAssets: 0, stockAssets: 0, exchangeDeposits: 0, brokerDeposits: 0,
    snapshots: 0,
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
      if (error) return { ok: false, error: `Institution "${inst.name}": ${error.message}` };
      instMap.set(inst.id, created.id);
      counts.institutions++;
    }
  }

  // ── 2. Wallets ────────────────────────────────────────
  for (const w of data.wallets) {
    const mappedInstId = w.institution_id ? instMap.get(w.institution_id) ?? null : null;
    let existingId: string | null = null;

    if (!isReplace) {
      const { data: existing } = await supabase
        .from("wallets")
        .select("id")
        .eq("user_id", uid)
        .eq("name", w.name)
        .eq("wallet_type", w.wallet_type)
        .is("deleted_at", null)
        .limit(1);
      if (existing && existing.length > 0) existingId = existing[0].id;
    }

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
      if (error) return { ok: false, error: `Wallet "${w.name}": ${error.message}` };
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
      if (error) return { ok: false, error: `Broker "${b.name}": ${error.message}` };
      brokerMap.set(b.id, created.id);
      counts.brokers++;
    }
  }

  // ── 4. Bank Accounts (batch insert) ───────────────────
  {
    const newRows: Record<string, unknown>[] = [];

    for (const ba of data.bankAccounts) {
      const mappedInstId = ba.institution_id ? instMap.get(ba.institution_id) ?? null : null;
      let found = false;

      if (!isReplace) {
        const { data: existing } = await supabase
          .from("bank_accounts")
          .select("id")
          .eq("user_id", uid)
          .eq("name", ba.name)
          .eq("currency", ba.currency)
          .is("deleted_at", null)
          .limit(1);
        if (existing && existing.length > 0) found = true;
      }

      if (found) {
        skipped.bankAccounts++;
      } else {
        newRows.push({
          user_id: uid,
          name: ba.name,
          bank_name: ba.bank_name,
          region: ba.region,
          currency: ba.currency,
          balance: ba.balance,
          apy: ba.apy,
          institution_id: mappedInstId,
          last_was_adjustment: ba.last_was_adjustment ?? false,
          last_was_transfer: ba.last_was_transfer ?? false,
        });
      }
    }

    if (newRows.length > 0) {
      const { error } = await supabase.from("bank_accounts").insert(newRows);
      if (error) return { ok: false, error: `Bank accounts batch: ${error.message}` };
      counts.bankAccounts = newRows.length;
    }
  }

  // ── 5. Crypto Assets + Positions ──────────────────────
  const existingCryptoMap = new Map<string, string>();
  if (!isReplace) {
    const { data: existingCrypto } = await supabase
      .from("crypto_assets")
      .select("id, coingecko_id")
      .eq("user_id", uid)
      .is("deleted_at", null);
    for (const c of existingCrypto ?? []) {
      existingCryptoMap.set(c.coingecko_id, c.id);
    }
  }

  for (const asset of data.cryptoAssets) {
    const existingId = isReplace ? null : (existingCryptoMap.get(asset.coingecko_id) ?? null);

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

    // Batch positions per asset
    const posRows: Record<string, unknown>[] = [];
    for (const pos of asset.positions) {
      const mappedWalletId = walletMap.get(pos.wallet_id);
      if (!mappedWalletId) continue;

      if (!isReplace) {
        const { data: existingPos } = await supabase
          .from("crypto_positions")
          .select("id")
          .eq("crypto_asset_id", newAssetId)
          .eq("wallet_id", mappedWalletId)
          .is("deleted_at", null)
          .limit(1);
        if (existingPos && existingPos.length > 0) continue;
      }

      posRows.push({
        crypto_asset_id: newAssetId,
        wallet_id: mappedWalletId,
        quantity: pos.quantity,
        acquisition_method: pos.acquisition_method ?? "bought",
        apy: pos.apy ?? 0,
        last_was_adjustment: pos.last_was_adjustment ?? false,
        last_was_transfer: pos.last_was_transfer ?? false,
      });
    }

    if (posRows.length > 0) {
      const { error } = await supabase.from("crypto_positions").insert(posRows);
      if (error) return { ok: false, error: `Crypto positions for ${asset.ticker}: ${error.message}` };
      counts.cryptoPositions += posRows.length;
    }
  }

  // ── 5b. Goal Prices ───────────────────────────────────
  if (data.goalPrices?.length) {
    for (const gp of data.goalPrices) {
      const mappedAssetId = cryptoAssetMap.get(gp.crypto_asset_id);
      if (!mappedAssetId) continue;

      const { error } = await supabase
        .from("goal_prices")
        .upsert(
          {
            crypto_asset_id: mappedAssetId,
            target_price: gp.target_price,
            weight: gp.weight ?? 0.25,
            label: gp.label ?? null,
          },
          { onConflict: "crypto_asset_id,label" }
        );
      if (error) continue; // best-effort — don't fail import for goal prices
      counts.goalPrices++;
    }
  }

  // ── 6. Stock Assets + Positions ───────────────────────
  for (const asset of data.stockAssets) {
    let existingId: string | null = null;

    if (!isReplace) {
      if (asset.yahoo_ticker) {
        const { data: existing } = await supabase
          .from("stock_assets")
          .select("id")
          .eq("user_id", uid)
          .eq("yahoo_ticker", asset.yahoo_ticker)
          .is("deleted_at", null)
          .limit(1);
        if (existing && existing.length > 0) existingId = existing[0].id;
      } else {
        const { data: existing } = await supabase
          .from("stock_assets")
          .select("id")
          .eq("user_id", uid)
          .eq("ticker", asset.ticker)
          .is("yahoo_ticker", null)
          .is("deleted_at", null)
          .limit(1);
        if (existing && existing.length > 0) existingId = existing[0].id;
      }
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

    // Batch positions per asset
    const posRows: Record<string, unknown>[] = [];
    for (const pos of asset.positions) {
      const mappedBrokerId = brokerMap.get(pos.broker_id);
      if (!mappedBrokerId) continue;

      if (!isReplace) {
        const { data: existingPos } = await supabase
          .from("stock_positions")
          .select("id")
          .eq("stock_asset_id", newAssetId)
          .eq("broker_id", mappedBrokerId)
          .is("deleted_at", null)
          .limit(1);
        if (existingPos && existingPos.length > 0) continue;
      }

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
      if (error) return { ok: false, error: `Stock positions for ${asset.ticker}: ${error.message}` };
      counts.stockPositions += posRows.length;
    }
  }

  // ── 7. Exchange Deposits (batch insert) ────────────────
  {
    const newRows: Record<string, unknown>[] = [];

    for (const dep of data.exchangeDeposits) {
      const mappedWalletId = walletMap.get(dep.wallet_id);
      if (!mappedWalletId) continue;
      let found = false;

      if (!isReplace) {
        const { data: existing } = await supabase
          .from("exchange_deposits")
          .select("id")
          .eq("user_id", uid)
          .eq("wallet_id", mappedWalletId)
          .eq("currency", dep.currency)
          .is("deleted_at", null)
          .limit(1);
        if (existing && existing.length > 0) found = true;
      }

      if (found) {
        skipped.exchangeDeposits++;
      } else {
        newRows.push({
          user_id: uid,
          wallet_id: mappedWalletId,
          currency: dep.currency,
          amount: dep.amount,
          apy: dep.apy ?? 0,
          last_was_adjustment: dep.last_was_adjustment ?? false,
          last_was_transfer: dep.last_was_transfer ?? false,
        });
      }
    }

    if (newRows.length > 0) {
      const { error } = await supabase.from("exchange_deposits").insert(newRows);
      if (error) return { ok: false, error: `Exchange deposits batch: ${error.message}` };
      counts.exchangeDeposits = newRows.length;
    }
  }

  // ── 8. Broker Deposits (batch insert) ──────────────────
  {
    const newRows: Record<string, unknown>[] = [];

    for (const dep of data.brokerDeposits) {
      const mappedBrokerId = brokerMap.get(dep.broker_id);
      if (!mappedBrokerId) continue;
      let found = false;

      if (!isReplace) {
        const { data: existing } = await supabase
          .from("broker_deposits")
          .select("id")
          .eq("user_id", uid)
          .eq("broker_id", mappedBrokerId)
          .eq("currency", dep.currency)
          .is("deleted_at", null)
          .limit(1);
        if (existing && existing.length > 0) found = true;
      }

      if (found) {
        skipped.brokerDeposits++;
      } else {
        newRows.push({
          user_id: uid,
          broker_id: mappedBrokerId,
          currency: dep.currency,
          amount: dep.amount,
          apy: dep.apy ?? 0,
          last_was_adjustment: dep.last_was_adjustment ?? false,
          last_was_transfer: dep.last_was_transfer ?? false,
        });
      }
    }

    if (newRows.length > 0) {
      const { error } = await supabase.from("broker_deposits").insert(newRows);
      if (error) return { ok: false, error: `Broker deposits batch: ${error.message}` };
      counts.brokerDeposits = newRows.length;
    }
  }

  // ── 9. Trade Entries (batch upsert by original UUID) ────
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
      if (error) return { ok: false, error: `Trade entries batch: ${error.message}` };
      counts.tradeEntries = tradeRows.length;
    }
  }

  // ── 10. Snapshots (batch upsert) ───────────────────────
  {
    const snapshotRows = data.snapshots.map((s) => ({
      user_id: uid,
      snapshot_date: s.snapshot_date,
      total_value_usd: s.total_value_usd,
      total_value_eur: s.total_value_eur,
      crypto_value_usd: s.crypto_value_usd,
      stocks_value_usd: s.stocks_value_usd,
      cash_value_usd: s.cash_value_usd,
    }));

    if (snapshotRows.length > 0) {
      const { error } = await supabase
        .from("portfolio_snapshots")
        .upsert(snapshotRows, { onConflict: "user_id,snapshot_date" });
      if (error) {
        skipped.snapshots += snapshotRows.length;
      } else {
        counts.snapshots = snapshotRows.length;
      }
    }
  }

  // ── 11. Diary Entries (v2) ─────────────────────────────
  if (data.diaryEntries?.length) {
    const rows = data.diaryEntries.map((d) => ({
      user_id: uid,
      entry_date: d.entry_date,
      content: d.content,
    }));
    const { error } = await supabase.from("diary_entries").insert(rows);
    if (!error) counts.diaryEntries = rows.length;
  }

  // ── 12. Profile (v2) ──────────────────────────────────
  if (data.profile) {
    await supabase
      .from("profiles")
      .update({
        display_name: data.profile.display_name,
        theme: data.profile.theme,
      })
      .eq("id", uid);
  }

  // activityLog and portfolioShares are export-only (archival) — not imported

  revalidatePath("/dashboard");
  return { ok: true, counts, skipped };
}
