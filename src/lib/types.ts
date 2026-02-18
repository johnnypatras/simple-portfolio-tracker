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

// ─── Exchange Deposits (fiat on exchanges) ──────────────

export interface ExchangeDeposit {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_name: string;   // joined from wallets table
  currency: CurrencyType;
  amount: number;
  apy: number;
  created_at: string;
  updated_at: string;
}

// ─── Portfolio Snapshots ────────────────────────────────

export interface PortfolioSnapshot {
  id: string;
  user_id: string;
  snapshot_date: string;
  total_value_usd: number;
  total_value_eur: number;
  crypto_value_usd: number;
  stocks_value_usd: number;
  cash_value_usd: number;
  created_at: string;
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

export type AssetCategory = "stock" | "etf_ucits" | "etf_non_ucits" | "bond" | "other";

export interface StockAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  isin: string | null;
  yahoo_ticker: string | null;
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

/** Stock asset with nested positions and broker names */
export interface StockAssetWithPositions extends StockAsset {
  positions: (StockPosition & { broker_name: string })[];
}

export interface StockAssetInput {
  ticker: string;
  name: string;
  isin?: string | null;
  yahoo_ticker?: string | null;
  category?: AssetCategory;
  currency?: string;  // ISO currency code, defaults to "USD"
}

// ─── Yahoo Finance API types ──────────────────────────────

export interface YahooSearchResult {
  symbol: string;       // e.g. "VWCE.DE", "AAPL"
  shortname: string;    // e.g. "Vanguard FTSE All-World U.ETF R"
  longname: string;     // e.g. "Vanguard FTSE All-World UCITS ETF USD Accumulation"
  quoteType: string;    // e.g. "ETF", "EQUITY"
  exchDisp: string;     // e.g. "XETRA", "NASDAQ", "London"
  exchange: string;     // e.g. "GER", "NMS", "LSE"
  currency?: string;    // e.g. "EUR", "USD", "GBP" — enriched from chart API
  price?: number;       // current market price — enriched from chart API
}

export interface YahooStockPriceData {
  [yahooTicker: string]: {
    price: number;
    previousClose: number;
    change24h: number;
    currency: string;
    name: string;
  };
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
  price_usd?: number;  // current USD price — enriched from simple/price API
}

export interface CoinGeckoPriceData {
  [coinId: string]: {
    usd: number;
    usd_24h_change?: number;
    eur: number;
    eur_24h_change?: number;
  };
}
