import { ChevronDown, ChevronRight } from "lucide-react";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type { ColumnDef } from "@/lib/column-config";
import type { BankAccount, BrokerDeposit, ExchangeDeposit } from "@/lib/types";

// ── Bank group (computed, not a DB type) ────────────────────

export interface BankGroup {
  bankName: string;
  accounts: BankAccount[];
  totalValue: number;
  region: string;
  weightedApy: number;
}

// ── Exchange group (computed, not a DB type) ─────────────────

export interface ExchangeGroup {
  walletName: string;
  deposits: ExchangeDeposit[];
  totalValue: number;
  weightedApy: number;
}

// ── Broker group (computed, not a DB type) ────────────────────

export interface BrokerGroup {
  brokerName: string;
  deposits: BrokerDeposit[];
  totalValue: number;
  weightedApy: number;
}

// ── Tagged union row type ─────────────────────────────────────

export type CashRow =
  | { type: "bank-group"; data: BankGroup; id: string }
  | { type: "exchange-group"; data: ExchangeGroup; id: string }
  | { type: "broker-group"; data: BrokerGroup; id: string };

// ── Build bank group rows ─────────────────────────────────────

export function buildBankGroupRows(
  accounts: BankAccount[],
  primaryCurrency: string,
  fxRates: FXRates
): CashRow[] {
  const groupMap = new Map<string, BankAccount[]>();
  for (const acct of accounts) {
    const existing = groupMap.get(acct.bank_name) ?? [];
    existing.push(acct);
    groupMap.set(acct.bank_name, existing);
  }

  const rows: CashRow[] = [];
  for (const [bankName, accts] of groupMap) {
    const totalValue = accts.reduce(
      (sum, a) =>
        sum + convertToBase(a.balance, a.currency, primaryCurrency, fxRates),
      0
    );

    // Weighted average APY (weight = converted value)
    const weightedApy =
      totalValue > 0
        ? accts.reduce(
            (sum, a) =>
              sum +
              a.apy *
                (convertToBase(
                  a.balance,
                  a.currency,
                  primaryCurrency,
                  fxRates
                ) /
                  totalValue),
            0
          )
        : accts.reduce((sum, a) => sum + a.apy, 0) / accts.length;

    // Region: shared if all the same, "—" if mixed
    const regions = [...new Set(accts.map((a) => a.region))];
    const region = regions.length === 1 ? regions[0] : "—";

    rows.push({
      type: "bank-group",
      id: `bank-group:${bankName}`,
      data: {
        bankName,
        accounts: accts.sort((a, b) => b.balance - a.balance),
        totalValue,
        region,
        weightedApy,
      },
    });
  }

  // Sort by total value descending
  rows.sort((a, b) => {
    const av = a.type === "bank-group" ? a.data.totalValue : 0;
    const bv = b.type === "bank-group" ? b.data.totalValue : 0;
    return bv - av;
  });

  return rows;
}

// ── Build exchange group rows ───────────────────────────────────

export function buildExchangeGroupRows(
  deposits: ExchangeDeposit[],
  primaryCurrency: string,
  fxRates: FXRates
): CashRow[] {
  const groupMap = new Map<string, ExchangeDeposit[]>();
  for (const dep of deposits) {
    const existing = groupMap.get(dep.wallet_name) ?? [];
    existing.push(dep);
    groupMap.set(dep.wallet_name, existing);
  }

  const rows: CashRow[] = [];
  for (const [walletName, deps] of groupMap) {
    const totalValue = deps.reduce(
      (sum, d) =>
        sum + convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
      0
    );

    const weightedApy =
      totalValue > 0
        ? deps.reduce(
            (sum, d) =>
              sum +
              d.apy *
                (convertToBase(d.amount, d.currency, primaryCurrency, fxRates) /
                  totalValue),
            0
          )
        : deps.reduce((sum, d) => sum + d.apy, 0) / deps.length;

    rows.push({
      type: "exchange-group",
      id: `exchange-group:${walletName}`,
      data: {
        walletName,
        deposits: deps.sort((a, b) => b.amount - a.amount),
        totalValue,
        weightedApy,
      },
    });
  }

  rows.sort((a, b) => {
    const av = a.type === "exchange-group" ? a.data.totalValue : 0;
    const bv = b.type === "exchange-group" ? b.data.totalValue : 0;
    return bv - av;
  });

  return rows;
}

// ── Build broker group rows ────────────────────────────────────

export function buildBrokerGroupRows(
  deposits: BrokerDeposit[],
  primaryCurrency: string,
  fxRates: FXRates
): CashRow[] {
  const groupMap = new Map<string, BrokerDeposit[]>();
  for (const dep of deposits) {
    const existing = groupMap.get(dep.broker_name) ?? [];
    existing.push(dep);
    groupMap.set(dep.broker_name, existing);
  }

  const rows: CashRow[] = [];
  for (const [brokerName, deps] of groupMap) {
    const totalValue = deps.reduce(
      (sum, d) =>
        sum + convertToBase(d.amount, d.currency, primaryCurrency, fxRates),
      0
    );

    const weightedApy =
      totalValue > 0
        ? deps.reduce(
            (sum, d) =>
              sum +
              d.apy *
                (convertToBase(d.amount, d.currency, primaryCurrency, fxRates) /
                  totalValue),
            0
          )
        : deps.reduce((sum, d) => sum + d.apy, 0) / deps.length;

    rows.push({
      type: "broker-group",
      id: `broker-group:${brokerName}`,
      data: {
        brokerName,
        deposits: deps.sort((a, b) => b.amount - a.amount),
        totalValue,
        weightedApy,
      },
    });
  }

  rows.sort((a, b) => {
    const av = a.type === "broker-group" ? a.data.totalValue : 0;
    const bv = b.type === "broker-group" ? b.data.totalValue : 0;
    return bv - av;
  });

  return rows;
}

// ── Shared formatter ─────────────────────────────────────────

export function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ═══════════════════════════════════════════════════════════════
// Unified Cash Columns
// ═══════════════════════════════════════════════════════════════

export function getCashColumns(handlers: {
  onEditBank: (b: BankAccount) => void;
  onDeleteBank: (id: string) => void;
  onEditExchange: (d: ExchangeDeposit) => void;
  onDeleteExchange: (id: string) => void;
  onEditBrokerDeposit: (d: BrokerDeposit) => void;
  onDeleteBrokerDeposit: (id: string) => void;
  isExpanded: (id: string) => boolean;
  toggleExpand: (id: string) => void;
}): ColumnDef<CashRow>[] {
  return [
    // ── Name / Wallet (pinned left) ────────────────────────
    {
      key: "name",
      label: "Account / Wallet",
      header: "Account",
      pinned: "left",
      align: "left",
      renderCell: (row) => {
        if (row.type === "bank-group") {
          const expanded = handlers.isExpanded(row.id);
          return (
            <button
              onClick={() => handlers.toggleExpand(row.id)}
              className="flex items-center gap-2 text-left min-w-0"
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              )}
              <span className="text-sm font-medium text-zinc-200">
                {row.data.bankName}
              </span>
              <span className="text-xs text-zinc-600">
                {row.data.accounts.length} account
                {row.data.accounts.length !== 1 ? "s" : ""}
              </span>
            </button>
          );
        }
        if (row.type === "exchange-group") {
          const expanded = handlers.isExpanded(row.id);
          return (
            <button
              onClick={() => handlers.toggleExpand(row.id)}
              className="flex items-center gap-2 text-left min-w-0"
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              )}
              <span className="text-sm font-medium text-zinc-200">
                {row.data.walletName}
              </span>
              <span className="text-xs text-zinc-600">
                {row.data.deposits.length} deposit
                {row.data.deposits.length !== 1 ? "s" : ""}
              </span>
            </button>
          );
        }
        if (row.type === "broker-group") {
          const expanded = handlers.isExpanded(row.id);
          return (
            <button
              onClick={() => handlers.toggleExpand(row.id)}
              className="flex items-center gap-2 text-left min-w-0"
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              )}
              <span className="text-sm font-medium text-zinc-200">
                {row.data.brokerName}
              </span>
              <span className="text-xs text-zinc-600">
                {row.data.deposits.length} deposit
                {row.data.deposits.length !== 1 ? "s" : ""}
              </span>
            </button>
          );
        }
        return null;
      },
    },

    // ── Bank (bank-only) ───────────────────────────────────
    {
      key: "bank",
      label: "Bank",
      header: "Bank",
      align: "left",
      hiddenBelow: "lg",
      appliesTo: "bank",
      renderCell: () => {
        // Bank name is already shown in the group's "name" column
        return null;
      },
    },

    // ── Currency (shared) ────────────────────────────────
    {
      key: "currency",
      label: "Currency",
      header: "Currency",
      align: "left",
      renderCell: (row) => {
        if (row.type === "bank-group") {
          const currencies = [
            ...new Set(row.data.accounts.map((a) => a.currency)),
          ];
          return (
            <span className="text-xs text-zinc-500">
              {currencies.length === 1 ? currencies[0] : "—"}
            </span>
          );
        }
        if (row.type === "exchange-group" || row.type === "broker-group") {
          const currencies = [
            ...new Set(row.data.deposits.map((d) => d.currency)),
          ];
          return (
            <span className="text-xs text-zinc-500">
              {currencies.length === 1 ? currencies[0] : "—"}
            </span>
          );
        }
        return null;
      },
    },

    // ── Balance / Amount (shared) ──────────────────────────
    {
      key: "balance",
      label: "Balance / Amount",
      header: "Balance",
      align: "right",
      width: "w-28",
      renderCell: (row, ctx) => {
        if (row.type === "bank-group") {
          return (
            <span className="text-sm font-medium text-zinc-200 tabular-nums">
              {formatCurrency(row.data.totalValue, ctx.primaryCurrency)}
            </span>
          );
        }
        if (row.type === "exchange-group" || row.type === "broker-group") {
          return (
            <span className="text-sm font-medium text-zinc-200 tabular-nums">
              {formatCurrency(row.data.totalValue, ctx.primaryCurrency)}
            </span>
          );
        }
        return null;
      },
    },

    // ── Value in base currency (shared) ────────────────────
    {
      key: "value",
      label: "Value",
      header: "Value",
      align: "right",
      width: "w-28",
      hiddenBelow: "sm",
      renderHeader: (ctx) => `Value (${ctx.primaryCurrency})`,
      renderCell: (row, ctx) => {
        if (row.type === "bank-group" || row.type === "exchange-group" || row.type === "broker-group") {
          return (
            <span className="text-sm font-medium text-zinc-200 tabular-nums">
              {formatCurrency(row.data.totalValue, ctx.primaryCurrency)}
            </span>
          );
        }
        return null;
      },
    },

    // ── APY (shared) ───────────────────────────────────────
    {
      key: "apy",
      label: "APY",
      header: "APY",
      align: "right",
      width: "w-16",
      hiddenBelow: "md",
      renderCell: (row) => {
        if (row.type === "bank-group" || row.type === "exchange-group" || row.type === "broker-group") {
          return row.data.weightedApy > 0 ? (
            <span className="text-sm text-emerald-400">
              ~{row.data.weightedApy.toFixed(1)}%
            </span>
          ) : (
            <span className="text-sm text-zinc-600">—</span>
          );
        }
        return null;
      },
    },

    // ── Region (bank-only) ─────────────────────────────────
    {
      key: "region",
      label: "Region",
      header: "Region",
      align: "right",
      width: "w-16",
      hiddenBelow: "md",
      appliesTo: "bank",
      renderCell: (row) => {
        if (row.type === "bank-group") {
          return (
            <span className="text-xs text-zinc-500">{row.data.region}</span>
          );
        }
        // exchange-group: no region concept
        return null;
      },
    },

    // ── Actions (pinned right) ─────────────────────────────
    {
      key: "actions",
      label: "Actions",
      header: "",
      pinned: "right",
      align: "right",
      width: "w-20",
      renderCell: (row) => {
        // Groups have no actions — edit/delete lives on the expanded sub-rows
        if (row.type === "bank-group" || row.type === "exchange-group" || row.type === "broker-group") return null;
        return null;
      },
    },
  ];
}
