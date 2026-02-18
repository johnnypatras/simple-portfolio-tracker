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
