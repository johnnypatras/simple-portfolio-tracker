/**
 * One-time backfill script for `stocks_eur_denominated_value` and
 * `cash_eur_denominated_value` in portfolio_snapshots.
 *
 * These columns were added by migration 050 but left NULL because they
 * require historical reconstruction from activity_log data and Yahoo
 * historical prices.
 *
 * Usage:
 *   npx tsx scripts/backfill-eur-denominated.ts
 *
 * Requires `.env.local` with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load environment from .env.local ────────────────────

function loadEnv(): void {
  const envPath = resolve(process.cwd(), ".env.local");
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    console.error("ERROR: .env.local not found. Run this script from the project root.");
    process.exit(1);
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Types ───────────────────────────────────────────────

interface Snapshot {
  id: string;
  user_id: string;
  snapshot_date: string;
  total_value_usd: number;
}

interface CashEntity {
  id: string;
  entity_type: "bank_account" | "exchange_deposit" | "broker_deposit";
  currency: string;
  current_amount: number;
}

interface StockPositionEntity {
  id: string;
  stock_asset_id: string;
  current_quantity: number;
}

interface StockAssetInfo {
  id: string;
  ticker: string;
  yahoo_ticker: string | null;
  currency: string;
}

// ─── Yahoo v8 chart historical prices ────────────────────

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Map of YYYY-MM-DD → close price */
type PriceHistory = Map<string, number>;

async function fetchYahooHistory(ticker: string): Promise<PriceHistory> {
  const map: PriceHistory = new Map();
  try {
    const url = `${CHART_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      console.warn(`  [yahoo] No data for ${ticker} (HTTP ${res.status})`);
      return map;
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return map;

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      map.set(date, close);
    }
  } catch (err) {
    console.warn(`  [yahoo] Error fetching ${ticker}:`, err);
  }
  return map;
}

/**
 * Get the close price for a date, falling back to the nearest earlier trading day.
 */
function getPriceForDate(history: PriceHistory, date: string): number | null {
  if (history.size === 0) return null;

  // Direct hit
  const direct = history.get(date);
  if (direct != null) return direct;

  // Find nearest earlier date
  const sortedDates = [...history.keys()].sort();
  let bestDate: string | null = null;
  for (const d of sortedDates) {
    if (d <= date) bestDate = d;
    else break;
  }

  if (bestDate) return history.get(bestDate) ?? null;

  // If all dates are after the requested date, no valid price
  return null;
}

// ─── Activity log reconstruction ─────────────────────────

/**
 * Get the state of an entity at a given date by finding the most recent
 * activity_log entry on or before that date.
 *
 * Returns the `after_snapshot` JSONB, or null if entity didn't exist / was deleted.
 */
async function getEntityStateAtDate(
  userId: string,
  entityId: string,
  entityType: string,
  date: string
): Promise<Record<string, unknown> | null> {
  const endOfDay = `${date}T23:59:59.999Z`;

  const { data, error } = await supabase
    .from("activity_log")
    .select("after_snapshot, action")
    .eq("user_id", userId)
    .eq("entity_id", entityId)
    .eq("entity_type", entityType)
    .is("undone_at", null)
    .lte("created_at", endOfDay)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`  [activity_log] Error querying ${entityType}/${entityId}: ${error.message}`);
    return null;
  }

  if (!data) {
    // No activity_log entry before this date — entity didn't exist yet
    // (or was created before activity_log existed — handled by caller as fallback)
    return null;
  }

  // "removed" action: after_snapshot is null → entity was deleted
  if (data.action === "removed" || data.after_snapshot == null) {
    return null;
  }

  const snapshot = data.after_snapshot as Record<string, unknown>;

  // Entity was soft-deleted at this point
  if (snapshot.deleted_at != null) {
    return null;
  }

  return snapshot;
}

/**
 * Check if an entity has ANY activity_log entries at all.
 * If not, it predates the activity_log system and we use current DB values as fallback.
 */
async function hasActivityLogEntries(
  userId: string,
  entityId: string,
  entityType: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from("activity_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("entity_id", entityId)
    .eq("entity_type", entityType)
    .is("undone_at", null)
    .limit(1);

  if (error) return false;
  return (count ?? 0) > 0;
}

// ─── Data fetching helpers ───────────────────────────────

async function fetchUsersWithSnapshots(): Promise<string[]> {
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("user_id")
    .gt("total_value_usd", 0);

  if (error) {
    console.error("Failed to fetch users:", error.message);
    return [];
  }

  const userIds = [...new Set((data ?? []).map((r) => r.user_id as string))];
  return userIds;
}

async function fetchUserPrimaryCurrency(userId: string): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("primary_currency")
    .eq("id", userId)
    .single();

  return (data?.primary_currency as string) ?? "EUR";
}

async function fetchUserSnapshots(userId: string): Promise<Snapshot[]> {
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("id, user_id, snapshot_date, total_value_usd")
    .eq("user_id", userId)
    .gt("total_value_usd", 0)
    .order("snapshot_date", { ascending: true });

  if (error) {
    console.error(`  Failed to fetch snapshots for ${userId}: ${error.message}`);
    return [];
  }

  return (data ?? []) as Snapshot[];
}

async function fetchCashEntities(userId: string, primaryCurrency: string): Promise<CashEntity[]> {
  const entities: CashEntity[] = [];

  // Bank accounts with primary currency
  const { data: banks } = await supabase
    .from("bank_accounts")
    .select("id, currency, balance")
    .eq("user_id", userId)
    .eq("currency", primaryCurrency);

  for (const b of banks ?? []) {
    entities.push({
      id: b.id,
      entity_type: "bank_account",
      currency: b.currency,
      current_amount: b.balance ?? 0,
    });
  }

  // Exchange deposits with primary currency
  const { data: exchangeDeps } = await supabase
    .from("exchange_deposits")
    .select("id, currency, amount")
    .eq("user_id", userId)
    .eq("currency", primaryCurrency);

  for (const d of exchangeDeps ?? []) {
    entities.push({
      id: d.id,
      entity_type: "exchange_deposit",
      currency: d.currency,
      current_amount: d.amount ?? 0,
    });
  }

  // Broker deposits with primary currency
  const { data: brokerDeps } = await supabase
    .from("broker_deposits")
    .select("id, currency, amount")
    .eq("user_id", userId)
    .eq("currency", primaryCurrency);

  for (const d of brokerDeps ?? []) {
    entities.push({
      id: d.id,
      entity_type: "broker_deposit",
      currency: d.currency,
      current_amount: d.amount ?? 0,
    });
  }

  return entities;
}

async function fetchEurStockAssets(userId: string, primaryCurrency: string): Promise<StockAssetInfo[]> {
  const { data } = await supabase
    .from("stock_assets")
    .select("id, ticker, yahoo_ticker, currency")
    .eq("user_id", userId)
    .eq("currency", primaryCurrency);

  return (data ?? []).map((a) => ({
    id: a.id as string,
    ticker: a.ticker as string,
    yahoo_ticker: a.yahoo_ticker as string | null,
    currency: a.currency as string,
  }));
}

async function fetchStockPositions(userId: string, assetIds: string[]): Promise<StockPositionEntity[]> {
  if (assetIds.length === 0) return [];

  const { data } = await supabase
    .from("stock_positions")
    .select("id, stock_asset_id, quantity")
    .in("stock_asset_id", assetIds);

  // Filter: we can't scope by user_id directly (positions don't have user_id),
  // but the asset IDs are already user-scoped.
  // Also include soft-deleted positions — they may have existed in historical snapshots.
  // The activity_log reconstruction handles deletion status at each date.
  void userId; // used indirectly via assetIds

  return (data ?? []).map((p) => ({
    id: p.id as string,
    stock_asset_id: p.stock_asset_id as string,
    current_quantity: (p.quantity as number) ?? 0,
  }));
}

// ─── Main backfill logic ─────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface BackfillResult {
  snapshot_id: string;
  snapshot_date: string;
  cash_eur_denominated_value: number;
  stocks_eur_denominated_value: number;
}

async function backfillUser(userId: string): Promise<BackfillResult[]> {
  const primaryCurrency = await fetchUserPrimaryCurrency(userId);
  console.log(`  Primary currency: ${primaryCurrency}`);

  // Only backfill EUR-denominated columns for EUR users.
  // For USD users, "home currency" is USD — there are no EUR-denominated
  // positions to track, so both columns should be 0.
  if (primaryCurrency !== "EUR") {
    console.log(`  Skipping: primary currency is ${primaryCurrency}, not EUR`);
    const snapshots = await fetchUserSnapshots(userId);
    const results: BackfillResult[] = [];
    for (const snap of snapshots) {
      results.push({
        snapshot_id: snap.id,
        snapshot_date: snap.snapshot_date,
        cash_eur_denominated_value: 0,
        stocks_eur_denominated_value: 0,
      });
    }
    // Batch update all to 0
    if (results.length > 0) {
      for (const r of results) {
        await supabase
          .from("portfolio_snapshots")
          .update({
            cash_eur_denominated_value: 0,
            stocks_eur_denominated_value: 0,
          })
          .eq("id", r.snapshot_id);
      }
      console.log(`  Set ${results.length} snapshots to 0 (non-EUR user)`);
    }
    return results;
  }

  // Fetch EUR cash entities
  const cashEntities = await fetchCashEntities(userId, primaryCurrency);
  console.log(`  EUR cash entities: ${cashEntities.length} (${cashEntities.map((e) => e.entity_type).join(", ") || "none"})`);

  // Fetch EUR-traded stock assets + their positions
  const eurStockAssets = await fetchEurStockAssets(userId, primaryCurrency);
  console.log(`  EUR stock assets: ${eurStockAssets.length} (${eurStockAssets.map((a) => a.ticker).join(", ") || "none"})`);

  const stockPositions = await fetchStockPositions(
    userId,
    eurStockAssets.map((a) => a.id)
  );
  console.log(`  EUR stock positions: ${stockPositions.length}`);

  // Build asset ID → asset info map
  const assetMap = new Map(eurStockAssets.map((a) => [a.id, a]));

  // Fetch Yahoo historical prices for EUR-traded tickers
  const tickerPriceHistories = new Map<string, PriceHistory>();
  const tickers = new Set(eurStockAssets.map((a) => a.yahoo_ticker || a.ticker));

  for (const ticker of tickers) {
    console.log(`  Fetching Yahoo history for ${ticker}...`);
    const history = await fetchYahooHistory(ticker);
    console.log(`    Got ${history.size} trading days`);
    tickerPriceHistories.set(ticker, history);
    // Rate-limit: small delay between Yahoo requests
    await sleep(500);
  }

  // Check which entities have activity_log entries (for fallback logic)
  const cashHasLog = new Map<string, boolean>();
  for (const entity of cashEntities) {
    const has = await hasActivityLogEntries(userId, entity.id, entity.entity_type);
    cashHasLog.set(entity.id, has);
  }

  const posHasLog = new Map<string, boolean>();
  for (const pos of stockPositions) {
    const has = await hasActivityLogEntries(userId, pos.id, "stock_position");
    posHasLog.set(pos.id, has);
  }

  // Process each snapshot
  const snapshots = await fetchUserSnapshots(userId);
  const results: BackfillResult[] = [];

  for (const snap of snapshots) {
    let cashEurValue = 0;
    let stocksEurValue = 0;

    // ── Cash reconstruction ──
    for (const entity of cashEntities) {
      const hasLog = cashHasLog.get(entity.id) ?? false;

      if (!hasLog) {
        // Entity predates activity_log — use current DB value for all dates
        cashEurValue += entity.current_amount;
        continue;
      }

      const state = await getEntityStateAtDate(
        userId,
        entity.id,
        entity.entity_type,
        snap.snapshot_date
      );

      if (!state) {
        // Entity didn't exist at this date or was deleted
        continue;
      }

      // Extract balance/amount from after_snapshot
      const amountField =
        entity.entity_type === "bank_account" ? "balance" : "amount";
      const amount = (state[amountField] as number) ?? 0;

      // Verify currency is still primary currency
      const snapshotCurrency = state.currency as string | undefined;
      if (snapshotCurrency && snapshotCurrency !== primaryCurrency) {
        // Currency was changed at some point — skip this entry for this date
        continue;
      }

      cashEurValue += amount;
    }

    // ── Stock reconstruction ──
    for (const pos of stockPositions) {
      const asset = assetMap.get(pos.stock_asset_id);
      if (!asset) continue;

      const hasLog = posHasLog.get(pos.id) ?? false;
      let quantity: number;

      if (!hasLog) {
        // Position predates activity_log — use current quantity
        quantity = pos.current_quantity;
      } else {
        const state = await getEntityStateAtDate(
          userId,
          pos.id,
          "stock_position",
          snap.snapshot_date
        );

        if (!state) {
          // Position didn't exist at this date or was deleted
          continue;
        }

        quantity = (state.quantity as number) ?? 0;
      }

      if (Math.abs(quantity) < 1e-12) continue;

      // Look up historical price
      const ticker = asset.yahoo_ticker || asset.ticker;
      const history = tickerPriceHistories.get(ticker);
      if (!history || history.size === 0) continue;

      const price = getPriceForDate(history, snap.snapshot_date);
      if (price == null) continue;

      stocksEurValue += quantity * price;
    }

    const cashRounded = round2(cashEurValue);
    const stocksRounded = round2(stocksEurValue);

    results.push({
      snapshot_id: snap.id,
      snapshot_date: snap.snapshot_date,
      cash_eur_denominated_value: cashRounded,
      stocks_eur_denominated_value: stocksRounded,
    });

    // Update the snapshot
    const { error } = await supabase
      .from("portfolio_snapshots")
      .update({
        cash_eur_denominated_value: cashRounded,
        stocks_eur_denominated_value: stocksRounded,
      })
      .eq("id", snap.id);

    if (error) {
      console.error(`  ERROR updating ${snap.snapshot_date}: ${error.message}`);
    } else {
      console.log(
        `  ${snap.snapshot_date}: cash_eur=${cashRounded}, stocks_eur=${stocksRounded}`
      );
    }
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry point ─────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Backfill EUR-denominated snapshot values ===\n");

  const userIds = await fetchUsersWithSnapshots();
  console.log(`Found ${userIds.length} user(s) with snapshots\n`);

  const allResults: BackfillResult[] = [];

  for (const userId of userIds) {
    console.log(`\nProcessing user: ${userId}`);
    const results = await backfillUser(userId);
    allResults.push(...results);
  }

  // ── Summary table ──
  console.log("\n=== Summary ===\n");
  console.log(
    "Date".padEnd(12) +
    "Cash EUR-denom".padEnd(18) +
    "Stocks EUR-denom".padEnd(20)
  );
  console.log("-".repeat(50));

  for (const r of allResults) {
    console.log(
      r.snapshot_date.padEnd(12) +
      r.cash_eur_denominated_value.toFixed(2).padStart(14).padEnd(18) +
      r.stocks_eur_denominated_value.toFixed(2).padStart(16).padEnd(20)
    );
  }

  console.log(`\nTotal: ${allResults.length} snapshots updated.`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
