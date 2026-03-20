// ─── Domain types (shared across server actions + portfolio logic) ───

export type AssetClass = "crypto" | "stocks" | "cash";

export interface CashFlowEvent {
  date: string;       // YYYY-MM-DD
  amount_usd: number; // positive = deposit, negative = withdrawal
  amount_eur?: number; // EUR amount via historical rate (avoids USD round-trip for EUR entities)
  asset_class?: AssetClass;
  entity_name?: string;
}

// ─── Database entity types ──────────────────────────────

export type WalletType = "custodial" | "non_custodial";
export type PrivacyLabel = "anon" | "doxxed";
/** User's base/display currency (EUR or USD) */
export type BaseCurrency = "USD" | "EUR";
/** Any ISO 4217 currency code */
export type CurrencyType = string;

// ─── User Profile ───────────────────────────────────────

export type UserRole = "admin" | "user";
export type UserStatus = "pending" | "active" | "suspended";

export interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  primary_currency: BaseCurrency;
  theme: string | null;
  role: UserRole;
  status: UserStatus;
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
  deleted_at?: string | null;
}

export interface Broker {
  id: string;
  user_id: string;
  name: string;
  institution_id: string | null;
  created_at: string;
  deleted_at?: string | null;
}

/** @deprecated Use CashAccount */
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
  last_was_adjustment?: boolean;
  last_was_transfer?: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// ─── Institutions ───────────────────────────────────────

export interface Institution {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
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
  "Sui", "Aptos", "Tron", "Stellar", "TON",
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

/** @deprecated Use CashAccountInput */
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

/** @deprecated Use CashAccountInput */
export interface ExchangeDepositInput {
  wallet_id: string;
  currency: CurrencyType;
  amount: number;
  apy?: number;
}

// ─── Exchange Deposits (fiat on exchanges) ──────────────

/** @deprecated Use CashAccount */
export interface ExchangeDeposit {
  id: string;
  user_id: string;
  wallet_id: string;
  wallet_name: string;   // joined from wallets table
  currency: CurrencyType;
  amount: number;
  apy: number;
  last_was_adjustment?: boolean;
  last_was_transfer?: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// ─── Broker Deposits (fiat on brokers) ───────────────────

/** @deprecated Use CashAccountInput */
export interface BrokerDepositInput {
  broker_id: string;
  currency: CurrencyType;
  amount: number;
  apy?: number;
}

/** @deprecated Use CashAccount */
export interface BrokerDeposit {
  id: string;
  user_id: string;
  broker_id: string;
  broker_name: string;   // joined from brokers table
  currency: CurrencyType;
  amount: number;
  apy: number;
  last_was_adjustment?: boolean;
  last_was_transfer?: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// ─── Unified Cash Account ───────────────────────────────

export interface CashAccount {
  id: string;
  user_id: string;
  institution_id: string | null;
  name: string | null;
  currency: string;
  balance: number;
  apy: number;
  region: string | null;
  wallet_id: string | null;
  broker_id: string | null;
  last_was_adjustment: boolean;
  last_was_transfer: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Flattened display names from JOINs (populated by getCashAccounts / getSharedPortfolio)
  institution_name?: string | null;
  wallet_name?: string | null;
  broker_name?: string | null;
}

export interface CashAccountInput {
  institution_id?: string;
  name?: string | null;
  currency: string;
  balance: number;
  apy?: number;
  region?: string | null;
  wallet_id?: string | null;
  broker_id?: string | null;
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
  crypto_value_eur: number | null;
  stocks_value_eur: number | null;
  cash_value_eur: number | null;
  stocks_eur_denominated_value: number | null;
  cash_eur_denominated_value: number | null;
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
  image_url: string | null;
  created_at: string;
  deleted_at?: string | null;
}

export interface CryptoPosition {
  id: string;
  crypto_asset_id: string;
  wallet_id: string;
  quantity: number;
  acquisition_method: string;
  apy: number;
  last_was_adjustment?: boolean;
  last_was_transfer?: boolean;
  updated_at: string;
  deleted_at?: string | null;
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
  image_url?: string | null;
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
  deleted_at?: string | null;
}

export interface StockPosition {
  id: string;
  stock_asset_id: string;
  broker_id: string;
  quantity: number;
  last_was_adjustment?: boolean;
  last_was_transfer?: boolean;
  updated_at: string;
  deleted_at?: string | null;
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
    regularMarketTime?: number;
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
  deleted_at?: string | null;
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

// ─── Diary Entries ─────────────────────────────────────

export interface DiaryEntry {
  id: string;
  user_id: string;
  entry_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

// ─── Goal Prices ───────────────────────────────────────

export interface GoalPrice {
  id: string;
  crypto_asset_id: string;
  target_price: number;
  weight: number;
  label: string | null;
}

// ─── Activity Log / Audit Trail ────────────────────────

export type FlowStatus = "complete" | "pending" | "failed" | null;

export type ActionType = "created" | "updated" | "removed" | "undone";
export type EntityType =
  | "crypto_asset"
  | "stock_asset"
  | "wallet"
  | "broker"
  | "cash_account"
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
  entity_id: string | null;
  entity_table: string | null;
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown> | null;
  undone_at: string | null;
  is_adjustment: boolean;
  delta_usd: number | null;
  delta_eur: number | null;
  transfer_group_id: string | null;
  compensates_for: string | null;
  cashflow_amount_usd: number | null;
  cashflow_amount_eur: number | null;
  cashflow_asset_class: AssetClass | null;
  cashflow_status: FlowStatus;
  delta_status: FlowStatus;
  cashflow_attempted_at: string | null;
  delta_attempted_at: string | null;
  created_at: string;
}

// ─── Portfolio Transfers ────────────────────────────────

export type TransferMode = "sell" | "buy" | "move";

export type TransferSide =
  | { type: "crypto_position"; assetId: string; walletId: string; quantity: number }
  | { type: "stock_position";  assetId: string; brokerId: string; quantity: number }
  | { type: "cash_account";    accountId: string; amount: number };

export interface TransferInput {
  mode: TransferMode;
  source?: TransferSide;
  destination: TransferSide;
  newCryptoAsset?: CryptoAssetInput;
  newStockAsset?: StockAssetInput;
  newBroker?: { name: string };
  newWallet?: { name: string };
  newCashDeposit?: { amount: number; currency: string; isAdjustment: boolean };
  /** ISO date string (YYYY-MM-DD) for backdated transfers. Defaults to today. */
  effectiveDate?: string;
}

export type TransferResult =
  | { success: true; transferGroupId: string; partialFailure?: boolean }
  | { success: false; error: string; transferGroupId?: string; partialFailure?: boolean };

// ─── Adjustment Deltas (chart enrichment) ───────────────

export interface AdjustmentDelta {
  date: string;
  cumulative_usd: number;
  cumulative_eur: number;
  crypto_cumulative_usd: number;
  crypto_cumulative_eur: number;
  stocks_cumulative_usd: number;
  stocks_cumulative_eur: number;
  cash_cumulative_usd: number;
  cash_cumulative_eur: number;
}

// ─── Command Palette ─────────────────────────────────────

/** Flat portfolio item for command palette search. */
export interface HoldingItem {
  id: string;
  type: "crypto" | "stock" | "cash";
  name: string;
  ticker?: string;
  value: number;
  change24h?: number;
  icon?: string | null;
  detailPath: string;
  /** Total quantity held (crypto/stock only) */
  quantity?: number;
  /** Price per unit in primary currency (crypto/stock only) */
  pricePerUnit?: number;
  /** Native currency of the asset (e.g., "USD", "EUR") */
  currency?: string;
}
