// ─── Database entity types ──────────────────────────────

export type WalletType = "custodial" | "non_custodial";
export type PrivacyLabel = "anon" | "doxxed";
export type CurrencyType = "USD" | "EUR";

export interface Wallet {
  id: string;
  user_id: string;
  name: string;
  wallet_type: WalletType;
  privacy_label: PrivacyLabel | null;
  created_at: string;
}

export interface Broker {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  bank_name: string;
  region: string;
  currency: CurrencyType;
  balance: number;
  apy: number;
  created_at: string;
  updated_at: string;
}

// ─── Form input types (for create/update) ───────────────

export interface WalletInput {
  name: string;
  wallet_type: WalletType;
  privacy_label?: PrivacyLabel | null;
}

export interface BrokerInput {
  name: string;
}

export interface BankAccountInput {
  name: string;
  bank_name: string;
  region?: string;
  currency?: CurrencyType;
  balance?: number;
  apy?: number;
}

// ─── Crypto entities ────────────────────────────────────

export interface CryptoAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  coingecko_id: string;
  chain: string | null;
  acquisition_method: string | null;
  created_at: string;
}

export interface CryptoPosition {
  id: string;
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
  updated_at: string;
}

/** Crypto asset with nested positions and wallet names */
export interface CryptoAssetWithPositions extends CryptoAsset {
  positions: (CryptoPosition & { wallet_name: string })[];
}

export interface CryptoAssetInput {
  ticker: string;
  name: string;
  coingecko_id: string;
  chain?: string | null;
  acquisition_method?: string | null;
}

export interface CryptoPositionInput {
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
}

// ─── Stock/ETF entities ─────────────────────────────────

export type AssetCategory = "stock" | "etf_sp500" | "etf_world" | "bond" | "other";

export interface StockAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  isin: string | null;
  category: AssetCategory;
  currency: CurrencyType;
  created_at: string;
}

export interface StockPosition {
  id: string;
  stock_asset_id: string;
  broker_id: string;
  quantity: number;
  updated_at: string;
}

/** Stock asset with nested positions and broker names */
export interface StockAssetWithPositions extends StockAsset {
  positions: (StockPosition & { broker_name: string })[];
}

export interface StockAssetInput {
  ticker: string;
  name: string;
  isin?: string | null;
  category?: AssetCategory;
  currency?: CurrencyType;
}

export interface StockPositionInput {
  stock_asset_id: string;
  broker_id: string;
  quantity: number;
}

// ─── CoinGecko API types ────────────────────────────────

export interface CoinGeckoSearchResult {
  id: string;
  name: string;
  symbol: string;
  thumb: string;
  large: string;
  market_cap_rank: number | null;
}

export interface CoinGeckoPriceData {
  [coinId: string]: {
    usd: number;
    usd_24h_change?: number;
    eur: number;
    eur_24h_change?: number;
  };
}
