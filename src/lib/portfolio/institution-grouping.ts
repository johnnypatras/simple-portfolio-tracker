/**
 * Institution grouping — pure computation, no React.
 *
 * Groups wallets, brokers, crypto/stock positions, and cash entities
 * under their parent institutions for the accounts page view.
 */

import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type {
  InstitutionWithRoles,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  Wallet,
  Broker,
  CashAccount,
  CoinGeckoPriceData,
  YahooStockPriceData,
  BaseCurrency,
} from "@/lib/types";

// ── Types ──────────────────────────────────────────────────

/** A crypto position enriched with asset-level info for display */
export interface CryptoRow {
  assetId: string;
  positionId: string;
  ticker: string;
  name: string;
  coingeckoId: string;
  quantity: number;
  priceBase: number;
  valueBase: number;
  walletName: string;
  apy: number;
  change24h: number;
}

/** A stock position enriched with asset-level info for display */
export interface StockRow {
  assetId: string;
  positionId: string;
  ticker: string;
  yahooTicker: string;
  name: string;
  quantity: number;
  priceBase: number;
  valueBase: number;
  currency: string;
  brokerName: string;
  change24h: number;
}

/** Cash item (bank account, exchange deposit, or broker deposit) */
export interface CashDepositRow {
  id: string;
  type: "bank" | "exchange_deposit" | "broker_deposit";
  label: string;
  currency: string;
  amount: number;
  valueBase: number;
  apy: number;
}

/** Grouped data for a single institution */
export interface InstitutionGroup {
  institution: InstitutionWithRoles;
  crypto: CryptoRow[];
  stocks: StockRow[];
  cash: CashDepositRow[];
  totalValue: number;
  change24h: { valueChange: number; percentChange: number };
}

export interface GroupingInput {
  institutions: InstitutionWithRoles[];
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  wallets: Wallet[];
  brokers: Broker[];
  cashAccounts: CashAccount[];
  cryptoPrices: CoinGeckoPriceData;
  stockPrices: YahooStockPriceData;
  fxRates: FXRates;
  primaryCurrency: BaseCurrency;
}

// ── Main function ──────────────────────────────────────────

/**
 * Build institution groups from all portfolio entities.
 * Returns sorted array of InstitutionGroup (by value descending, then name).
 */
export function buildInstitutionGroups(input: GroupingInput): InstitutionGroup[] {
  const {
    institutions, cryptoAssets, stockAssets, wallets, brokers,
    cashAccounts,
    cryptoPrices, stockPrices, fxRates, primaryCurrency,
  } = input;

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";

  // wallet_id → group key (institution_id or synthetic __wallet__<id>)
  const walletToInst = new Map<string, string>();
  // Virtual groups for standalone wallets without institution
  const walletVirtualGroups = new Map<string, InstitutionGroup>();

  for (const w of wallets) {
    if (w.institution_id) {
      walletToInst.set(w.id, w.institution_id);
    } else {
      const virtualId = `__wallet__${w.id}`;
      walletToInst.set(w.id, virtualId);
      walletVirtualGroups.set(virtualId, {
        institution: {
          id: virtualId,
          user_id: w.user_id,
          name: w.name,
          roles: ["wallet"],
          created_at: w.created_at,
          updated_at: w.created_at,
        },
        crypto: [],
        stocks: [],
        cash: [],
        totalValue: 0,
        change24h: { valueChange: 0, percentChange: 0 },
      });
    }
  }

  // broker_id → group key (institution_id or synthetic __broker__<id>)
  const brokerToInst = new Map<string, string>();
  const brokerVirtualGroups = new Map<string, InstitutionGroup>();

  for (const b of brokers) {
    if (b.institution_id) {
      brokerToInst.set(b.id, b.institution_id);
    } else {
      const virtualId = `__broker__${b.id}`;
      brokerToInst.set(b.id, virtualId);
      brokerVirtualGroups.set(virtualId, {
        institution: {
          id: virtualId,
          user_id: b.user_id,
          name: b.name,
          roles: ["broker"],
          created_at: b.created_at,
          updated_at: b.created_at,
        },
        crypto: [],
        stocks: [],
        cash: [],
        totalValue: 0,
        change24h: { valueChange: 0, percentChange: 0 },
      });
    }
  }

  // Initialize groups per real institution
  const groupMap = new Map<string, InstitutionGroup>();
  for (const inst of institutions) {
    groupMap.set(inst.id, {
      institution: inst,
      crypto: [],
      stocks: [],
      cash: [],
      totalValue: 0,
      change24h: { valueChange: 0, percentChange: 0 },
    });
  }

  function getGroup(instId: string | undefined): InstitutionGroup | undefined {
    if (!instId) return undefined;
    return groupMap.get(instId) ?? walletVirtualGroups.get(instId) ?? brokerVirtualGroups.get(instId);
  }

  // ── Crypto positions ─────────────────────────────────
  const changeKey = `${currencyKey}_24h_change` as "usd_24h_change" | "eur_24h_change";
  for (const asset of cryptoAssets) {
    const price = cryptoPrices[asset.coingecko_id];
    const priceBase = price?.[currencyKey] ?? 0;
    const assetChange24h = price?.[changeKey] ?? 0;

    for (const pos of asset.positions) {
      const instId = walletToInst.get(pos.wallet_id);
      const group = getGroup(instId);
      if (!group) continue;

      const valueBase = pos.quantity * priceBase;
      group.crypto.push({
        assetId: asset.id,
        positionId: pos.id,
        ticker: asset.ticker,
        name: asset.name,
        coingeckoId: asset.coingecko_id,
        quantity: pos.quantity,
        priceBase,
        valueBase,
        walletName: pos.wallet_name,
        apy: pos.apy,
        change24h: assetChange24h,
      });
      group.totalValue += valueBase;
    }
  }

  // ── Stock positions ──────────────────────────────────
  for (const asset of stockAssets) {
    const key = asset.yahoo_ticker || asset.ticker;
    const priceData = stockPrices[key];
    if (!priceData) continue;

    for (const pos of asset.positions) {
      const instId = brokerToInst.get(pos.broker_id);
      const group = getGroup(instId);
      if (!group) continue;

      const valueNative = pos.quantity * priceData.price;
      const valueBase = convertToBase(valueNative, asset.currency, primaryCurrency, fxRates);
      const priceInBase = convertToBase(priceData.price, asset.currency, primaryCurrency, fxRates);

      group.stocks.push({
        assetId: asset.id,
        positionId: pos.id,
        ticker: asset.ticker,
        yahooTicker: key,
        name: asset.name,
        quantity: pos.quantity,
        priceBase: priceInBase,
        valueBase,
        currency: asset.currency,
        brokerName: pos.broker_name,
        change24h: priceData.change24h,
      });
      group.totalValue += valueBase;
    }
  }

  // ── Cash accounts ───────────────────────────────────
  for (const cash of cashAccounts) {
    // Derive institution group: use institution_id directly,
    // or fall back to wallet/broker indirection for exchange/broker deposits
    const instId = cash.institution_id
      ?? (cash.wallet_id ? walletToInst.get(cash.wallet_id) : undefined)
      ?? (cash.broker_id ? brokerToInst.get(cash.broker_id) : undefined);
    const group = getGroup(instId);
    if (!group) continue;

    const type: "bank" | "exchange_deposit" | "broker_deposit" =
      cash.wallet_id ? "exchange_deposit" : cash.broker_id ? "broker_deposit" : "bank";
    const valueBase = convertToBase(cash.balance, cash.currency, primaryCurrency, fxRates);
    group.cash.push({
      id: cash.id,
      type,
      label: cash.name ?? "Fiat deposit",
      currency: cash.currency,
      amount: cash.balance,
      valueBase,
      apy: cash.apy,
    });
    group.totalValue += valueBase;
  }

  // ── Compute 24h change per group ─────────────────────
  const allGroupMaps = [groupMap, walletVirtualGroups, brokerVirtualGroups];
  for (const map of allGroupMaps) {
    for (const group of map.values()) {
      let totalPrev = 0;
      for (const row of group.crypto) {
        const change = cryptoPrices[row.coingeckoId]?.[changeKey] ?? 0;
        const prev = Math.abs(change) > 0.0001
          ? row.valueBase / (1 + change / 100)
          : row.valueBase;
        totalPrev += prev;
      }
      for (const row of group.stocks) {
        const priceData = stockPrices[row.yahooTicker];
        if (priceData?.previousClose) {
          const prevNative = row.quantity * priceData.previousClose;
          totalPrev += convertToBase(prevNative, row.currency, primaryCurrency, fxRates);
        } else {
          totalPrev += row.valueBase;
        }
      }
      for (const row of group.cash) {
        totalPrev += row.valueBase;
      }

      const currentVal = group.totalValue;
      const valueChange = currentVal - totalPrev;
      const percentChange = totalPrev > 0 ? (valueChange / totalPrev) * 100 : 0;
      group.change24h = { valueChange, percentChange };
    }
  }

  // Combine real institutions + per-wallet virtual groups
  const allGroups = [
    ...Array.from(groupMap.values()),
    ...Array.from(walletVirtualGroups.values()),
    ...Array.from(brokerVirtualGroups.values()),
  ];

  return allGroups.sort(
    (a, b) => b.totalValue - a.totalValue || a.institution.name.localeCompare(b.institution.name)
  );
}
