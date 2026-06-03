"use client";

import { useEffect, useId, useState } from "react";
import { X, Pencil } from "lucide-react";
import FocusTrap from "focus-trap-react";
import type { TransactionKind } from "@/lib/transaction-kind";
import { fmtCurrency, formatQuantity } from "@/lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TransactionDisplayRow {
  id: string;
  kind: TransactionKind;
  /** Signed (direction in the sign). Display magnitude with a +/- cue. */
  quantity: number;
  /** Cost/cashflow (or delta) in `currency`; null = unknown/market-derived → show "—". */
  amount: number | null;
  currency: "EUR" | "USD";
  /** ISO date string, e.g. "2026-03-14" or full ISO. */
  date: string;
}

export interface TransactionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  assetName: string;
  assetClass: "crypto" | "stock" | "cash";
  rows: TransactionDisplayRow[];
  onEdit: (rowId: string) => void;
  onAddFirst?: () => void;
}

// ── Filter chip definitions ───────────────────────────────────────────────────

type FilterChipKey = "all" | "buy" | "sell" | "yield" | "deposit" | "withdrawal";

interface FilterChip {
  key: FilterChipKey;
  label: string;
  kind: TransactionKind | null; // null = All
}

const CRYPTO_STOCK_CHIPS: FilterChip[] = [
  { key: "all",   label: "All",   kind: null },
  { key: "buy",   label: "Buys",  kind: "buy" },
  { key: "sell",  label: "Sells", kind: "sell" },
  { key: "yield", label: "Yield", kind: "yield" },
];

const CASH_CHIPS: FilterChip[] = [
  { key: "all",        label: "All",          kind: null },
  { key: "deposit",    label: "Deposits",     kind: "deposit" },
  { key: "withdrawal", label: "Withdrawals",  kind: "withdrawal" },
  { key: "yield",      label: "Yield",        kind: "yield" },
];

function getFilterChips(assetClass: "crypto" | "stock" | "cash"): FilterChip[] {
  return assetClass === "cash" ? CASH_CHIPS : CRYPTO_STOCK_CHIPS;
}

// ── Kind badge ────────────────────────────────────────────────────────────────

const KIND_BADGE_CLASSES: Record<TransactionKind, string> = {
  buy:        "bg-blue-500/15 text-blue-400",
  sell:       "bg-red-500/15 text-red-400",
  yield:      "bg-emerald-500/15 text-emerald-400",
  deposit:    "bg-blue-500/15 text-blue-400",
  withdrawal: "bg-red-500/15 text-red-400",
  transfer:   "bg-teal-500/15 text-teal-400",
  adjustment: "bg-amber-500/15 text-amber-400",
};

const KIND_LABEL: Record<TransactionKind, string> = {
  buy:        "Buy",
  sell:       "Sell",
  yield:      "Yield",
  deposit:    "Deposit",
  withdrawal: "Withdrawal",
  transfer:   "Transfer",
  adjustment: "Adjustment",
};

function KindBadge({ kind }: { kind: TransactionKind }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${KIND_BADGE_CLASSES[kind]}`}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

// ── Date formatting ───────────────────────────────────────────────────────────

/** Format locale-stably — always YYYY-MM-DD. */
function formatDate(dateStr: string): string {
  return dateStr.slice(0, 10);
}

// ── Quantity display ──────────────────────────────────────────────────────────

function formatQty(qty: number): string {
  const abs = Math.abs(qty);
  const formatted = formatQuantity(abs, 6);
  return qty < 0 ? `-${formatted}` : `+${formatted}`;
}

// ── Transaction row component ─────────────────────────────────────────────────

function TransactionRow({
  row,
  onEdit,
}: {
  row: TransactionDisplayRow;
  onEdit: (id: string) => void;
}) {
  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
      {/* Kind badge */}
      <div className="shrink-0">
        <KindBadge kind={row.kind} />
      </div>

      {/* Quantity */}
      <div className="w-24 shrink-0 text-right font-mono text-sm text-zinc-100">
        {formatQty(row.quantity)}
      </div>

      {/* Amount */}
      <div className="w-28 shrink-0 text-right text-sm text-zinc-100">
        {row.amount !== null ? fmtCurrency(row.amount, row.currency) : "—"}
      </div>

      {/* Date */}
      <div className="flex-1 text-sm text-zinc-400">
        {formatDate(row.date)}
      </div>

      {/* Edit button */}
      <button
        type="button"
        aria-label="Edit transaction"
        onClick={() => onEdit(row.id)}
        className="shrink-0 p-1 rounded text-zinc-400 hover:text-zinc-300 hover:bg-zinc-700 transition-colors md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
      >
        <Pencil aria-hidden="true" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Consecutive-yield grouping ────────────────────────────────────────────────

/**
 * A "display item" is either a single row, or a yield-group.
 * Yield runs > 2 rows are collapsed: first 2 shown, rest behind an expand toggle.
 */
type SingleItem = { type: "row"; row: TransactionDisplayRow };
type GroupItem = {
  type: "group";
  /** Unique key for this group. */
  key: string;
  rows: TransactionDisplayRow[];
};
type DisplayItem = SingleItem | GroupItem;

function buildDisplayItems(rows: TransactionDisplayRow[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    if (row.kind !== "yield") {
      items.push({ type: "row", row });
      i++;
      continue;
    }

    // Start of a yield run — collect all consecutive yields
    let runEnd = i + 1;
    while (runEnd < rows.length && rows[runEnd].kind === "yield") {
      runEnd++;
    }

    const runRows = rows.slice(i, runEnd);
    if (runRows.length > 2) {
      items.push({
        type: "group",
        key: `yield-group-${row.id}`,
        rows: runRows,
      });
    } else {
      // Run ≤ 2: render flat
      for (const r of runRows) {
        items.push({ type: "row", row: r });
      }
    }

    i = runEnd;
  }

  return items;
}

// ── Yield group component ─────────────────────────────────────────────────────

function YieldGroup({
  groupKey,
  rows,
  expanded,
  onToggle,
  onEdit,
}: {
  groupKey: string;
  rows: TransactionDisplayRow[];
  expanded: boolean;
  onToggle: (key: string) => void;
  onEdit: (id: string) => void;
}) {
  const alwaysVisible = rows.slice(0, 2);
  const hidden = rows.slice(2);

  return (
    <div>
      {alwaysVisible.map((r) => (
        <TransactionRow key={r.id} row={r} onEdit={onEdit} />
      ))}

      {!expanded && (
        <button
          type="button"
          aria-expanded={false}
          aria-label={`Show ${hidden.length} more yield transactions`}
          onClick={() => onToggle(groupKey)}
          className="w-full px-4 py-2 text-left text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors border-b border-zinc-800/50"
        >
          + {hidden.length} more
        </button>
      )}

      {expanded && (
        <>
          {hidden.map((r) => (
            <TransactionRow key={r.id} row={r} onEdit={onEdit} />
          ))}
          <button
            type="button"
            aria-expanded={true}
            aria-label="Show fewer yield transactions"
            onClick={() => onToggle(groupKey)}
            className="w-full px-4 py-2 text-left text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors border-b border-zinc-800/50"
          >
            Show less
          </button>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TransactionsDrawer({
  isOpen,
  onClose,
  assetName,
  assetClass,
  rows,
  onEdit,
  onAddFirst,
}: TransactionsDrawerProps) {
  const titleId = useId();
  const [activeFilter, setActiveFilter] = useState<FilterChipKey>("all");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Tracks the previous isOpen value so we can detect a closed→open transition
  // and reset transient state inline during render (React's "derived state from prev render" idiom).
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  // Esc-to-close (identical to Modal)
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Reset transient state when the drawer (re)opens so a new asset starts clean.
  // Calling setState during render on a state-derived-from-props change is the
  // React-recommended alternative to useEffect for synchronous resets
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setActiveFilter("all");
      setExpandedGroups(new Set());
    }
  }

  if (!isOpen) return null;

  const chips = getFilterChips(assetClass);

  // Filter rows
  const activeChip = chips.find((c) => c.key === activeFilter) ?? chips[0];
  const filteredRows =
    activeChip.kind === null
      ? rows
      : rows.filter((r) => r.kind === activeChip.kind);

  // Pure + O(n) over a per-asset list (typically <200 rows) — cheap enough to recompute each render; no useMemo needed.
  const displayItems = buildDisplayItems(filteredRows);

  function handleChipClick(chipKey: FilterChipKey) {
    setActiveFilter(chipKey);
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <FocusTrap focusTrapOptions={{ initialFocus: false, allowOutsideClick: true }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="fixed inset-y-0 right-0 w-full max-w-md bg-zinc-900 border-l border-zinc-800 shadow-2xl flex flex-col outline-none"
        >
          {/* ── Header ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
            <h2 id={titleId} className="text-base font-semibold text-zinc-100">
              Transactions — {assetName}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded-lg text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <X aria-hidden="true" className="w-4 h-4" />
            </button>
          </div>

          {/* ── Filter chips ───────────────────────────────────────── */}
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-zinc-800 shrink-0 flex-wrap">
            {chips.map((chip) => {
              const isActive = activeFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => handleChipClick(chip.key)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-blue-600 text-zinc-100"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>

          {/* ── Scrollable list ────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto">
            {/* Empty state: no rows at all */}
            {rows.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4 py-16">
                <p className="text-sm text-zinc-400">No transactions yet</p>
                {onAddFirst && (
                  <button
                    type="button"
                    onClick={onAddFirst}
                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                  >
                    Add the first one
                  </button>
                )}
              </div>
            )}

            {/* No-match state: rows exist but filter returns nothing */}
            {rows.length > 0 && filteredRows.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-4 py-16">
                <p className="text-sm text-zinc-400">
                  No {activeChip.label} transactions
                </p>
                <button
                  type="button"
                  onClick={() => setActiveFilter("all")}
                  className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg transition-colors"
                >
                  Clear filter
                </button>
              </div>
            )}

            {/* Normal list */}
            {filteredRows.length > 0 && (
              <div>
                {displayItems.map((item) => {
                  if (item.type === "row") {
                    return (
                      <TransactionRow
                        key={item.row.id}
                        row={item.row}
                        onEdit={onEdit}
                      />
                    );
                  }
                  // item.type === "group"
                  return (
                    <YieldGroup
                      key={item.key}
                      groupKey={item.key}
                      rows={item.rows}
                      expanded={expandedGroups.has(item.key)}
                      onToggle={toggleGroup}
                      onEdit={onEdit}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
