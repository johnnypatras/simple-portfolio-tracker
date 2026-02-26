"use server";

import { getCryptoAssetsWithPositions } from "@/lib/actions/crypto";
import { getStockAssetsWithPositions } from "@/lib/actions/stocks";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { getTradeEntries } from "@/lib/actions/trades";
import { getSnapshots } from "@/lib/actions/snapshots";
import { getProfile } from "@/lib/actions/profile";
import type {
  Wallet,
  Broker,
  InstitutionWithRoles,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  TradeEntry,
  PortfolioSnapshot,
} from "@/lib/types";

// ─── CSV helper ─────────────────────────────────────────

function escapeCsv(s: string | number | null | undefined): string {
  if (s == null) return "";
  const str = String(s);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}

// ─── Full JSON backup ───────────────────────────────────

export interface PortfolioBackup {
  version: number;
  exportedAt: string;
  primaryCurrency: string;
  institutions: InstitutionWithRoles[];
  wallets: Wallet[];
  brokers: Broker[];
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  tradeEntries: TradeEntry[];
  snapshots: PortfolioSnapshot[];
}

export async function exportFullJson(): Promise<PortfolioBackup> {
  const [
    profile,
    institutions,
    wallets,
    brokers,
    cryptoAssets,
    stockAssets,
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    tradeEntries,
    snapshots,
  ] = await Promise.all([
    getProfile(),
    getInstitutionsWithRoles(),
    getWallets(),
    getBrokers(),
    getCryptoAssetsWithPositions(),
    getStockAssetsWithPositions(),
    getBankAccounts(),
    getExchangeDeposits(),
    getBrokerDeposits(),
    getTradeEntries(),
    getSnapshots(99999), // all snapshots
  ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    primaryCurrency: profile.primary_currency,
    institutions,
    wallets,
    brokers,
    cryptoAssets,
    stockAssets,
    bankAccounts,
    exchangeDeposits,
    brokerDeposits,
    tradeEntries,
    snapshots,
  };
}

// ─── CSV: Crypto Holdings ───────────────────────────────

export async function exportCryptoCsv(): Promise<string> {
  const assets = await getCryptoAssetsWithPositions();

  const headers = [
    "Ticker", "Name", "CoinGecko ID", "Chain", "Subcategory",
    "Wallet", "Wallet Type", "Quantity", "Acquisition Method", "APY %",
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
    "Broker", "Quantity",
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
        asset.created_at,
        pos.updated_at,
      ]);
    }
  }

  return toCsv(headers, rows);
}

// ─── CSV: Cash (Banks + Exchange Deposits + Broker Deposits) ──

export async function exportCashCsv(): Promise<string> {
  const [banks, exDeps, brDeps] = await Promise.all([
    getBankAccounts(),
    getExchangeDeposits(),
    getBrokerDeposits(),
  ]);

  const headers = [
    "Type", "Account Name", "Institution", "Currency", "Amount", "APY %", "Region",
    "Created", "Updated",
  ];

  const rows: (string | number | null)[][] = [];

  for (const b of banks) {
    rows.push(["Bank Account", b.name, b.bank_name, b.currency, b.balance, b.apy, b.region, b.created_at, b.updated_at]);
  }
  for (const d of exDeps) {
    rows.push(["Fiat Deposit (Exchange)", null, d.wallet_name, d.currency, d.amount, d.apy, null, d.created_at, d.updated_at]);
  }
  for (const d of brDeps) {
    rows.push(["Fiat Deposit (Broker)", null, d.broker_name, d.currency, d.amount, d.apy, null, d.created_at, d.updated_at]);
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
  const snapshots = await getSnapshots(99999);

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
