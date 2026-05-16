import { ChevronDown, ChevronRight } from "lucide-react";
import { convertToBase } from "@/lib/prices/fx";
import type { FXRates } from "@/lib/prices/fx";
import type { ColumnDef } from "@/lib/column-config";
import { formatCurrency } from "@/lib/format";
import type { CashAccount } from "@/lib/types";
import { countryName } from "@/lib/types";

// ── Cash group (computed, not a DB type) ────────────────────

export interface CashGroup {
  /** Display name for the group (institution name, wallet name, broker name, or bank name fallback) */
  groupName: string;
  /** Origin type derived from FKs */
  origin: "Bank" | "Exchange" | "Broker";
  accounts: CashAccount[];
  totalValue: number;
  region: string;
  weightedApy: number;
}

// ── Tagged union row type ─────────────────────────────────────

export type CashRow = { type: "cash-group"; data: CashGroup; id: string };

// ── Derive origin from CashAccount FKs ──────────────────────

function deriveOrigin(cash: CashAccount): "Bank" | "Exchange" | "Broker" {
  if (cash.wallet_id) return "Exchange";
  if (cash.broker_id) return "Broker";
  return "Bank";
}

// ── Derive group key: use institution/wallet/broker name ─────

function deriveGroupKey(cash: CashAccount): string {
  if (cash.wallet_id) return `wallet:${cash.wallet_name ?? cash.wallet_id}`;
  if (cash.broker_id) return `broker:${cash.broker_name ?? cash.broker_id}`;
  return `inst:${cash.institution_name ?? cash.institution_id ?? "Unknown"}`;
}

function deriveGroupName(cash: CashAccount): string {
  if (cash.wallet_id) return cash.wallet_name ?? "Unknown Exchange";
  if (cash.broker_id) return cash.broker_name ?? "Unknown Broker";
  return cash.institution_name ?? "Unknown Bank";
}

// ── Build unified cash group rows ─────────────────────────────

export function buildCashGroupRows(
  cashAccounts: CashAccount[],
  primaryCurrency: string,
  fxRates: FXRates
): CashRow[] {
  const groupMap = new Map<string, CashAccount[]>();
  for (const acct of cashAccounts) {
    const key = deriveGroupKey(acct);
    const existing = groupMap.get(key) ?? [];
    existing.push(acct);
    groupMap.set(key, existing);
  }

  const rows: CashRow[] = [];
  for (const [key, accts] of groupMap) {
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
                (convertToBase(a.balance, a.currency, primaryCurrency, fxRates) /
                  totalValue),
            0
          )
        : accts.length > 0
          ? accts.reduce((sum, a) => sum + a.apy, 0) / accts.length
          : 0;

    // Country: shared if all the same, "" if mixed or not applicable
    const regions = [...new Set(accts.map((a) => a.region).filter(Boolean))];
    const region = regions.length === 1 ? (regions[0] ?? "") : "";

    const origin = deriveOrigin(accts[0]);
    const groupName = deriveGroupName(accts[0]);

    rows.push({
      type: "cash-group",
      id: `cash-group:${key}`,
      data: {
        groupName,
        origin,
        accounts: accts.sort((a, b) => b.balance - a.balance),
        totalValue,
        region,
        weightedApy,
      },
    });
  }

  // Sort by total value descending
  rows.sort((a, b) => b.data.totalValue - a.data.totalValue);

  return rows;
}


// ═══════════════════════════════════════════════════════════════
// Unified Cash Columns
// ═══════════════════════════════════════════════════════════════

export function getCashColumns(handlers: {
  onEdit: (c: CashAccount) => void;
  onDelete: (id: string, opts?: { isAdjustment: boolean }) => void;
  isExpanded: (id: string) => boolean;
  toggleExpand: (id: string) => void;
}): ColumnDef<CashRow>[] {
  return [
    // ── Name (pinned left) ────────────────────────────────
    {
      key: "name",
      label: "Account / Wallet",
      header: "Account",
      pinned: "left",
      align: "left",
      renderCell: (row) => {
        const expanded = handlers.isExpanded(row.id);
        const { groupName, accounts, origin } = row.data;
        const itemLabel = origin === "Bank" ? "account" : "deposit";
        return (
          <button
            onClick={() => handlers.toggleExpand(row.id)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${groupName}`}
            className="flex items-center gap-2 text-left min-w-0"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
            )}
            <span className="text-sm font-medium text-zinc-200">
              {groupName}
            </span>
            <span className="text-xs text-zinc-400">
              {accounts.length} {itemLabel}
              {accounts.length !== 1 ? "s" : ""}
            </span>
          </button>
        );
      },
    },

    // ── Type (derived from FKs) ─────────────────────────────
    {
      key: "type",
      label: "Type",
      header: "Type",
      align: "left",
      hiddenBelow: "lg",
      renderCell: (row) => (
        <span className="text-xs text-zinc-400">{row.data.origin}</span>
      ),
    },

    // ── Currency (shared) ────────────────────────────────
    {
      key: "currency",
      label: "Currency",
      header: "Currency",
      align: "left",
      renderCell: (row) => {
        const currencies = [...new Set(row.data.accounts.map((a) => a.currency))];
        return (
          <span className="text-xs text-zinc-400">
            {currencies.join(", ")}
          </span>
        );
      },
    },

    // ── Balance / Amount (shared) ──────────────────────────
    {
      key: "balance",
      label: "Balance / Amount",
      header: "Balance",
      align: "right",
      width: "w-28",
      renderCell: (row, ctx) => (
        <span className="text-sm font-medium text-zinc-200 tabular-nums">
          {formatCurrency(row.data.totalValue, ctx.primaryCurrency)}
        </span>
      ),
    },

    // ── APY (shared) ───────────────────────────────────────
    {
      key: "apy",
      label: "APY",
      header: "APY",
      align: "right",
      width: "w-16",
      hiddenBelow: "md",
      renderCell: (row) =>
        row.data.weightedApy > 0 ? (
          <span className="text-sm text-emerald-400">
            ~{row.data.weightedApy.toFixed(2)}%
          </span>
        ) : (
          <span className="text-sm text-zinc-400">&mdash;</span>
        ),
    },

    // ── Country (bank-relevant) ────────────────────────────
    {
      key: "region",
      label: "Country",
      header: "Country",
      align: "right",
      width: "w-20",
      hiddenBelow: "md",
      renderCell: (row) =>
        row.data.region ? (
          <span className="text-xs text-zinc-400">{countryName(row.data.region)}</span>
        ) : null,
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
      renderCell: (row, ctx) => (
        <span className="text-sm font-medium text-zinc-200 tabular-nums">
          {formatCurrency(row.data.totalValue, ctx.primaryCurrency)}
        </span>
      ),
    },

    // ── Actions (pinned right) ─────────────────────────────
    {
      key: "actions",
      label: "Actions",
      header: "",
      pinned: "right",
      align: "right",
      width: "w-20",
      renderCell: () => {
        // Groups have no actions — edit/delete lives on the expanded sub-rows
        return null;
      },
    },
  ];
}
