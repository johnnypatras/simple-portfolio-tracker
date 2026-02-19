export type Currency = "USD" | "EUR";
export type WalletType = "custodial" | "non_custodial";
export type PrivacyLabel = "anon" | "doxxed" | null;
export type AssetCategory =
  | "stock"
  | "etf_ucits"
  | "etf_non_ucits"
  | "bond"
  | "other";
export type ActionType = "created" | "updated" | "removed";
export type EntityType =
  | "crypto_asset"
  | "stock_asset"
  | "wallet"
  | "broker"
  | "bank_account"
  | "exchange_deposit"
  | "crypto_position"
  | "stock_position"
  | "diary_entry"
  | "goal_price";

// ─── User Profile ────────────────────────────
export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  primary_currency: Currency;
  created_at: string;
  updated_at: string;
}

// ─── Wallets (Crypto exchanges & self-custody) ─
export interface Wallet {
  id: string;
  user_id: string;
  name: string;
  wallet_type: WalletType;
  privacy_label: PrivacyLabel;
  created_at: string;
}

// ─── Brokers (Stock/ETF platforms) ────────────
export interface Broker {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

// ─── Bank Accounts ───────────────────────────
export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  bank_name: string;
  region: string;
  currency: Currency;
  balance: number;
  apy: number;
  created_at: string;
  updated_at: string;
}

// ─── Crypto Assets ───────────────────────────
export interface CryptoAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  coingecko_id: string;
  chain: string | null;
  created_at: string;
}

export interface CryptoPosition {
  id: string;
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
  acquisition_method: string;
  updated_at: string;
}

export interface GoalPrice {
  id: string;
  crypto_asset_id: string;
  target_price: number;
  weight: number;
  label: string | null;
}

// ─── Stock/ETF Assets ────────────────────────
export interface StockAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  isin: string | null;
  category: AssetCategory;
  currency: string;  // free-form ISO currency code (USD, EUR, GBP, CHF, etc.)
  created_at: string;
}

export interface StockPosition {
  id: string;
  stock_asset_id: string;
  broker_id: string;
  quantity: number;
  updated_at: string;
}

// ─── Exchange Deposits (fiat on exchanges) ───
export interface ExchangeDeposit {
  id: string;
  user_id: string;
  wallet_id: string;
  currency: Currency;
  amount: number;
  apy: number;
  created_at: string;
  updated_at: string;
}

// ─── Activity Log ────────────────────────────
export interface ActivityLog {
  id: string;
  user_id: string;
  action: ActionType;
  entity_type: EntityType;
  entity_name: string;
  description: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

// ─── Diary ───────────────────────────────────
export interface DiaryEntry {
  id: string;
  user_id: string;
  entry_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// ─── Invite Codes ────────────────────────────
export interface InviteCode {
  id: string;
  code: string;
  created_by: string;
  used_by: string | null;
  used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// ─── Portfolio Snapshots ─────────────────────
export interface PortfolioSnapshot {
  id: string;
  user_id: string;
  total_value_usd: number;
  total_value_eur: number;
  crypto_value_usd: number;
  stocks_value_usd: number;
  cash_value_usd: number;
  snapshot_date: string;
  created_at: string;
}
