"use client";

import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Bitcoin,
  TrendingUp,
  Landmark,
  Building2,
  Shield,
  Pencil,
  Plus,
} from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import { EditInstitutionModal } from "@/components/accounts/edit-institution-modal";
import { AddInstitutionModal } from "@/components/accounts/add-institution-modal";
import type {
  InstitutionWithRoles,
  CryptoAssetWithPositions,
  StockAssetWithPositions,
  Wallet,
  Broker,
  BankAccount,
  ExchangeDeposit,
  BrokerDeposit,
  CoinGeckoPriceData,
  YahooStockPriceData,
  YahooDividendMap,
} from "@/lib/types";

// ── Types ────────────────────────────────────────────────

/** A crypto position enriched with asset-level info for display */
interface CryptoRow {
  assetId: string;
  positionId: string;
  ticker: string;
  name: string;
  coingeckoId: string;
  quantity: number;
  priceBase: number;
  valueBase: number;
  walletName: string;
}

/** A stock position enriched with asset-level info for display */
interface StockRow {
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
}

/** Cash item (bank account, exchange deposit, or broker deposit) */
interface CashRow {
  id: string;
  type: "bank" | "exchange_deposit" | "broker_deposit";
  label: string;
  currency: string;
  amount: number;
  valueBase: number;
  apy: number;
}

/** Grouped data for a single institution */
interface InstitutionGroup {
  institution: InstitutionWithRoles;
  crypto: CryptoRow[];
  stocks: StockRow[];
  cash: CashRow[];
  totalValue: number;
}

// ── Props ────────────────────────────────────────────────

interface AccountsViewProps {
  institutions: InstitutionWithRoles[];
  cryptoAssets: CryptoAssetWithPositions[];
  stockAssets: StockAssetWithPositions[];
  wallets: Wallet[];
  brokers: Broker[];
  bankAccounts: BankAccount[];
  exchangeDeposits: ExchangeDeposit[];
  brokerDeposits: BrokerDeposit[];
  cryptoPrices: CoinGeckoPriceData;
  stockPrices: YahooStockPriceData;
  fxRates: FXRates;
  dividends: YahooDividendMap;
  primaryCurrency: string;
}

// ── Component ────────────────────────────────────────────

export function AccountsView({
  institutions,
  cryptoAssets,
  stockAssets,
  wallets,
  brokers,
  bankAccounts,
  exchangeDeposits,
  brokerDeposits,
  cryptoPrices,
  stockPrices,
  fxRates,
  primaryCurrency,
}: AccountsViewProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingInstitution, setEditingInstitution] = useState<InstitutionWithRoles | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const currencyKey = primaryCurrency.toLowerCase() as "usd" | "eur";

  // ── Build lookup maps ──────────────────────────────────
  const groups = useMemo(() => {
    // wallet_id → group key (institution_id or synthetic __wallet__<id>)
    const walletToInst = new Map<string, string>();
    // Virtual groups for non-custodial wallets (each wallet = its own entity)
    const walletVirtualGroups = new Map<string, InstitutionGroup>();

    for (const w of wallets) {
      if (w.institution_id) {
        walletToInst.set(w.id, w.institution_id);
      } else {
        // Each non-custodial wallet is its own independent entity
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
        });
      }
    }

    // broker_id → institution_id
    const brokerToInst = new Map<string, string>();
    for (const b of brokers) {
      if (b.institution_id) brokerToInst.set(b.id, b.institution_id);
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
      });
    }

    function getGroup(instId: string | undefined): InstitutionGroup | undefined {
      if (!instId) return undefined;
      return groupMap.get(instId) ?? walletVirtualGroups.get(instId);
    }

    // ── Crypto positions ──────────────────────────────
    for (const asset of cryptoAssets) {
      const price = cryptoPrices[asset.coingecko_id];
      const priceBase = price?.[currencyKey] ?? 0;

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
        });
        group.totalValue += valueBase;
      }
    }

    // ── Stock positions ───────────────────────────────
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
        });
        group.totalValue += valueBase;
      }
    }

    // ── Bank accounts (always linked to a real institution) ──
    for (const bank of bankAccounts) {
      if (!bank.institution_id) continue;
      const group = getGroup(bank.institution_id);
      if (!group) continue;

      const valueBase = convertToBase(bank.balance, bank.currency, primaryCurrency, fxRates);
      group.cash.push({
        id: bank.id,
        type: "bank",
        label: bank.name,
        currency: bank.currency,
        amount: bank.balance,
        valueBase,
        apy: bank.apy,
      });
      group.totalValue += valueBase;
    }

    // ── Exchange deposits (via wallet → institution) ──
    for (const dep of exchangeDeposits) {
      const instId = walletToInst.get(dep.wallet_id);
      const group = getGroup(instId);
      if (!group) continue;

      const valueBase = convertToBase(dep.amount, dep.currency, primaryCurrency, fxRates);
      group.cash.push({
        id: dep.id,
        type: "exchange_deposit",
        label: `Exchange deposit (${dep.wallet_name})`,
        currency: dep.currency,
        amount: dep.amount,
        valueBase,
        apy: dep.apy,
      });
      group.totalValue += valueBase;
    }

    // ── Broker deposits (via broker → institution) ───
    for (const dep of brokerDeposits) {
      const instId = brokerToInst.get(dep.broker_id);
      const group = getGroup(instId);
      if (!group) continue;

      const valueBase = convertToBase(dep.amount, dep.currency, primaryCurrency, fxRates);
      group.cash.push({
        id: dep.id,
        type: "broker_deposit",
        label: `Broker deposit (${dep.broker_name})`,
        currency: dep.currency,
        amount: dep.amount,
        valueBase,
        apy: dep.apy,
      });
      group.totalValue += valueBase;
    }

    // Combine real institutions + per-wallet virtual groups
    const allGroups = [
      ...Array.from(groupMap.values()),
      ...Array.from(walletVirtualGroups.values()),
    ];

    // Sort by total value descending, then alphabetically
    return allGroups.sort(
      (a, b) => b.totalValue - a.totalValue || a.institution.name.localeCompare(b.institution.name)
    );
  }, [
    institutions, cryptoAssets, stockAssets, wallets, brokers,
    bankAccounts, exchangeDeposits, brokerDeposits,
    cryptoPrices, stockPrices, fxRates, primaryCurrency, currencyKey,
  ]);

  // ── Expand/collapse ────────────────────────────────────
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Total across all institutions
  const grandTotal = groups.reduce((sum, g) => sum + g.totalValue, 0);
  const nonEmptyGroups = groups.filter(
    (g) => g.crypto.length > 0 || g.stocks.length > 0 || g.cash.length > 0
  );

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          {nonEmptyGroups.length} institution{nonEmptyGroups.length !== 1 ? "s" : ""} with assets
          <span className="mx-2 text-zinc-600">|</span>
          Total: <span className="text-zinc-200 font-medium">{formatCurrency(grandTotal, primaryCurrency)}</span>
        </p>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Institution
        </button>
      </div>

      {/* Institution cards */}
      {groups.map((group) => {
        const { institution, crypto, stocks, cash, totalValue } = group;
        const isEmpty = crypto.length === 0 && stocks.length === 0 && cash.length === 0;
        const isExpanded = expandedIds.has(institution.id);
        const isSelfCustody = institution.id.startsWith("__wallet__");
        const HeaderIcon = isSelfCustody ? Shield : Building2;

        return (
          <div
            key={institution.id}
            className={`group border rounded-xl overflow-hidden ${
              isSelfCustody
                ? "border-amber-900/40 bg-amber-950/10"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            {/* Clickable header */}
            <button
              onClick={() => toggleExpand(institution.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/30 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
                )}
                <HeaderIcon className={`w-4 h-4 shrink-0 ${isSelfCustody ? "text-amber-500/70" : "text-zinc-400"}`} />
                <span className="font-medium text-zinc-100 truncate">
                  {institution.name}
                </span>
                {/* Role badges */}
                <div className="flex gap-1.5">
                  {isSelfCustody ? (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-500/70">
                      self-custody
                    </span>
                  ) : (
                    institution.roles.map((role) => (
                      <span
                        key={role}
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500"
                      >
                        {role}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 pl-4">
                {/* Edit button — only for real institutions */}
                {!isSelfCustody && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingInstitution(institution);
                    }}
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                <div className="text-right">
                  {isEmpty ? (
                    <span className="text-sm text-zinc-600">No assets</span>
                  ) : (
                    <span className="text-sm font-medium text-zinc-200">
                      {formatCurrency(totalValue, primaryCurrency)}
                    </span>
                  )}
                </div>
              </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="px-4 pb-4 space-y-4 border-t border-zinc-800/50">
                {/* Crypto section */}
                {crypto.length > 0 && (
                  <AssetSection
                    icon={<Bitcoin className="w-3.5 h-3.5" />}
                    label="Crypto"
                    count={crypto.length}
                    totalValue={crypto.reduce((s, c) => s + c.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {crypto
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div
                          key={row.positionId}
                          className="flex items-center justify-between py-1.5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-zinc-200 font-medium">{row.ticker}</span>
                            <span className="text-zinc-500 truncate">{row.name}</span>
                            <span className="text-zinc-600 text-xs">on {row.walletName}</span>
                          </div>
                          <div className="text-right shrink-0 pl-4 flex items-baseline gap-3">
                            <span className="text-zinc-500 text-xs tabular-nums">
                              {formatQuantity(row.quantity)}
                            </span>
                            <span className="text-zinc-300 tabular-nums">
                              {formatCurrency(row.valueBase, primaryCurrency)}
                            </span>
                          </div>
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Stocks section */}
                {stocks.length > 0 && (
                  <AssetSection
                    icon={<TrendingUp className="w-3.5 h-3.5" />}
                    label="Equities"
                    count={stocks.length}
                    totalValue={stocks.reduce((s, st) => s + st.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {stocks
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div
                          key={row.positionId}
                          className="flex items-center justify-between py-1.5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-zinc-200 font-medium">{row.ticker}</span>
                            <span className="text-zinc-500 truncate">{row.name}</span>
                            <span className="text-zinc-600 text-xs">via {row.brokerName}</span>
                          </div>
                          <div className="text-right shrink-0 pl-4 flex items-baseline gap-3">
                            <span className="text-zinc-500 text-xs tabular-nums">
                              {row.quantity} shares
                            </span>
                            <span className="text-zinc-300 tabular-nums">
                              {formatCurrency(row.valueBase, primaryCurrency)}
                            </span>
                          </div>
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Cash section */}
                {cash.length > 0 && (
                  <AssetSection
                    icon={<Landmark className="w-3.5 h-3.5" />}
                    label="Cash"
                    count={cash.length}
                    totalValue={cash.reduce((s, c) => s + c.valueBase, 0)}
                    primaryCurrency={primaryCurrency}
                  >
                    {cash
                      .sort((a, b) => b.valueBase - a.valueBase)
                      .map((row) => (
                        <div
                          key={row.id}
                          className="flex items-center justify-between py-1.5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-zinc-200">{row.label}</span>
                            {row.apy > 0 && (
                              <span className="text-emerald-500/70 text-xs">
                                {row.apy}% APY
                              </span>
                            )}
                          </div>
                          <div className="text-right shrink-0 pl-4 flex items-baseline gap-3">
                            <span className="text-zinc-500 text-xs tabular-nums">
                              {formatCurrency(row.amount, row.currency)}
                            </span>
                            {row.currency !== primaryCurrency && (
                              <span className="text-zinc-300 tabular-nums">
                                {formatCurrency(row.valueBase, primaryCurrency)}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                  </AssetSection>
                )}

                {/* Empty state */}
                {crypto.length === 0 && stocks.length === 0 && cash.length === 0 && (
                  <div className="pt-3 text-center text-sm text-zinc-600">
                    No assets linked to this institution yet
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Empty state when no institutions */}
      {groups.length === 0 && (
        <div className="text-center py-16">
          <Building2 className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">
            No institutions yet. Create one to get started.
          </p>
        </div>
      )}

      {/* Modals */}
      {editingInstitution && (
        <EditInstitutionModal
          open={!!editingInstitution}
          onClose={() => setEditingInstitution(null)}
          institution={editingInstitution}
        />
      )}
      <AddInstitutionModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
      />
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────

function AssetSection({
  icon,
  label,
  count,
  totalValue,
  primaryCurrency,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  totalValue: number;
  primaryCurrency: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-zinc-400">
          {icon}
          <span className="text-xs font-medium uppercase tracking-wider">
            {label} ({count})
          </span>
        </div>
        <span className="text-xs text-zinc-500 tabular-nums">
          {formatCurrency(totalValue, primaryCurrency)}
        </span>
      </div>
      <div className="pl-5 border-l border-zinc-800/50">{children}</div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────

/** Format crypto quantities: full precision, trimming trailing zeros */
function formatQuantity(qty: number): string {
  if (qty >= 1) return qty.toLocaleString("en-US", { maximumFractionDigits: 4 });
  // For small quantities, show up to 8 decimal places
  return qty.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
