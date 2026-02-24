// ─── Database entity types ──────────────────────────────

export type WalletType = "custodial" | "non_custodial";
export type PrivacyLabel = "anon" | "doxxed";
export type CurrencyType = "USD" | "EUR";
/** @deprecated Use CurrencyType instead */
export type Currency = CurrencyType;

// ─── User Profile ───────────────────────────────────────

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  primary_currency: CurrencyType;
  theme: string | null;
  created_at: string;
  updated_at: string;
}

export interface Wallet {
  id: string;
  user_id: string;
  name: string;
  wallet_type: WalletType;
  privacy_label: PrivacyLabel | null;
  chain: string | null;
  institution_id: string | null;
  created_at: string;
}

export interface Broker {
  id: string;
  user_id: string;
  name: string;
  institution_id: string | null;
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
  institution_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Institutions ───────────────────────────────────────

export interface Institution {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type InstitutionRole = "wallet" | "broker" | "bank";

export interface InstitutionWithRoles extends Institution {
  roles: InstitutionRole[];
}

// ─── Form input types (for create/update) ───────────────

export interface WalletInput {
  name: string;
  wallet_type: WalletType;
  privacy_label?: PrivacyLabel | null;
  chain?: string | null;
}

/** All EVM-compatible chains. The "evm" token in wallet.chain expands to these. */
export const EVM_CHAINS = [
  "Ethereum", "BNB Chain", "Polygon", "Arbitrum", "Optimism", "Avalanche",
  "Base", "Fantom", "Cronos", "Celo", "Mantle", "Blast", "Linea", "zkSync", "Scroll",
] as const;

const EVM_SET = new Set<string>(EVM_CHAINS);

/** Non-EVM chains that need explicit selection. */
export const NON_EVM_CHAINS = [
  "Bitcoin", "Solana", "Cardano", "Polkadot", "NEAR", "Cosmos",
  "Sui", "Aptos", "Tron", "Stellar",
] as const;

/**
 * Parse wallet chain string into an expanded array of chain names.
 * The special token "evm" expands to all EVM-compatible chains.
 * Returns [] for null/empty (= any chain).
 */
export function parseWalletChains(chain: string | null | undefined): string[] {
  if (!chain) return [];
  const tokens = chain.split(",").map((c) => c.trim()).filter(Boolean);
  const result: string[] = [];
  for (const t of tokens) {
    if (t.toLowerCase() === "evm") {
      for (const c of EVM_CHAINS) {
        if (!result.includes(c)) result.push(c);
      }
    } else {
      if (!result.includes(t)) result.push(t);
    }
  }
  return result;
}

/** Check if a chain name is EVM-compatible. */
export function isEvmChain(chain: string): boolean {
  return EVM_SET.has(chain);
}

/** Serialize chain selection back to storage string. Uses "evm" shorthand when possible. */
export function serializeChains(chains: string[]): string | null {
  const filtered = chains.filter(Boolean);
  if (filtered.length === 0) return null;

  // Check if all EVM chains are selected — collapse to "evm" token
  const hasAllEvm = EVM_CHAINS.every((c) => filtered.includes(c));
  const nonEvmSelected = filtered.filter((c) => !EVM_SET.has(c));

  if (hasAllEvm) {
    const parts = ["evm", ...nonEvmSelected];
    return parts.join(",");
  }
  return filtered.join(",");
}

/** Get the raw tokens stored in chain (without expanding "evm"). For display purposes. */
export function getWalletChainTokens(chain: string | null | undefined): string[] {
  if (!chain) return [];
  return chain.split(",").map((c) => c.trim()).filter(Boolean);
}

export interface BrokerInput {
  name: string;
}

export interface BankAccountInput {
  name: string;
  bank_name: string;
  country?: string;
  currency?: CurrencyType;
  balance?: number;
  apy?: number;
}

// ─── Countries (for bank/institution country dropdown) ──────

export const COUNTRIES = [
  { code: "GR", name: "Greece" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "AT", name: "Austria" },
  { code: "PT", name: "Portugal" },
  { code: "IE", name: "Ireland" },
  { code: "FI", name: "Finland" },
  { code: "LU", name: "Luxembourg" },
  { code: "CY", name: "Cyprus" },
  { code: "MT", name: "Malta" },
  { code: "EE", name: "Estonia" },
  { code: "LV", name: "Latvia" },
  { code: "LT", name: "Lithuania" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "HR", name: "Croatia" },
  { code: "GB", name: "United Kingdom" },
  { code: "CH", name: "Switzerland" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czech Republic" },
  { code: "RO", name: "Romania" },
  { code: "BG", name: "Bulgaria" },
  { code: "HU", name: "Hungary" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan" },
  { code: "SG", name: "Singapore" },
  { code: "HK", name: "Hong Kong" },
  { code: "AE", name: "UAE" },
] as const;

const COUNTRY_MAP: Map<string, string> = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** Look up a country name from its code. Falls back to the code itself. */
export function countryName(code: string): string {
  return COUNTRY_MAP.get(code) ?? code;
}

export interface ExchangeDepositInput {
  wallet_id: string;
  currency: CurrencyType;
  amount: number;
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

// ─── Broker Deposits (fiat on brokers) ───────────────────

export interface BrokerDepositInput {
  broker_id: string;
  currency: CurrencyType;
  amount: number;
  apy?: number;
}

export interface BrokerDeposit {
  id: string;
  user_id: string;
  broker_id: string;
  broker_name: string;   // joined from brokers table
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

// ─── Crypto acquisition types ───────────────────────────

export type AcquisitionType = "bought" | "swapped" | "mined" | "staked" | "airdrop" | "other";

export const ACQUISITION_TYPES: { value: AcquisitionType; label: string }[] = [
  { value: "bought", label: "Bought" },
  { value: "swapped", label: "Swapped" },
  { value: "mined", label: "Mined" },
  { value: "staked", label: "Staked" },
  { value: "airdrop", label: "Airdrop" },
  { value: "other", label: "Other" },
];

// ─── Crypto entities ────────────────────────────────────

export interface CryptoAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  coingecko_id: string;
  chain: string | null;
  subcategory: string | null;
  created_at: string;
}

export interface CryptoPosition {
  id: string;
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
  acquisition_method: string;
  apy: number;
  updated_at: string;
}

/** Crypto asset with nested positions and wallet names */
export interface CryptoAssetWithPositions extends CryptoAsset {
  positions: (CryptoPosition & { wallet_name: string; wallet_type: WalletType })[];
}

export interface CryptoAssetInput {
  ticker: string;
  name: string;
  coingecko_id: string;
  chain?: string | null;
  subcategory?: string | null;
}

export interface CryptoPositionInput {
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
  acquisition_method?: string;
  apy?: number;
}

// ─── Stock/ETF entities ─────────────────────────────────

export type AssetCategory = "individual_stock" | "etf" | "bond_fixed_income" | "other";

export interface StockAsset {
  id: string;
  user_id: string;
  ticker: string;
  name: string;
  isin: string | null;
  yahoo_ticker: string | null;
  category: AssetCategory;
  tags: string[];  // theme/strategy tags (e.g. ["S&P 500", "World"])
  currency: string;  // free-form ISO currency code (USD, EUR, GBP, CHF, etc.)
  subcategory: string | null;  // instrument subtype (e.g. "ETF UCITS", "ETF UCITS Bonds")
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
  tags?: string[];
  currency?: string;  // ISO currency code, defaults to "USD"
  subcategory?: string | null;
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

export interface YahooDividendData {
  trailingYield: number;    // trailing 12-month yield as % (e.g. 2.60)
  annualDividend: number;   // sum of last 12m dividends per share (native currency)
  dividendCount: number;    // payment count in last 12m (4 = quarterly, 2 = semi-annual)
  currency: string;
}

export type YahooDividendMap = { [yahooTicker: string]: YahooDividendData };

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

// ─── Trade Diary ────────────────────────────────────────

export type TradeAssetType = "crypto" | "stock" | "cash" | "other";
export type TradeAction = "buy" | "sell";

export interface TradeEntry {
  id: string;
  user_id: string;
  trade_date: string;
  asset_type: TradeAssetType;
  asset_name: string;
  action: TradeAction;
  quantity: number;
  price: number;
  currency: string;
  total_value: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeEntryInput {
  trade_date: string;
  asset_type: TradeAssetType;
  asset_name: string;
  action: TradeAction;
  quantity: number;
  price: number;
  currency?: string;
  notes?: string;
}

// ─── Activity Log / Audit Trail ────────────────────────

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
  | "broker_deposit"
  | "diary_entry"
  | "goal_price"
  | "trade_entry"
  | "institution";

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
