"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useCallback } from "react";
import { toast } from "sonner";
import {
  Clock,
  Plus,
  Pencil,
  Trash2,
  Download,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Bitcoin,
  TrendingUp,
  Wallet,
  Landmark,
  Building2,
  ArrowLeftRight,
  BookOpen,
  Undo2,
  SlidersHorizontal,
  Calendar,
  GitBranch,
  Merge,
  Check,
  X,
} from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { CashflowStatusIcon } from "@/components/ui/cashflow-status-icon";
import { SplitModal } from "@/components/history/split-modal";
import type { ActionType, ActivityLog, EntityType } from "@/lib/types";
import { exportActivityLogsCsv, toggleActivityAdjustment } from "@/lib/actions/activity-log";
import { backdateActivityEntry, unsplitActivityEntry } from "@/lib/actions/splits";
import { undoActivity } from "@/lib/actions/undo";
import { backfillSingleRow } from "@/lib/actions/backfill";
import { useSharedView } from "@/components/shared-view-context";

// ─── Props ──────────────────────────────────────────────

interface ActivityTimelineProps {
  logs: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  currentEntityType?: EntityType;
  currentAction?: ActionType;
  splitChildren?: ActivityLog[];
}

// ─── Entity type display config ─────────────────────────

const ENTITY_LABELS: Record<string, string> = {
  crypto_asset: "Crypto",
  stock_asset: "Stock",
  wallet: "Wallet",
  broker: "Broker",
  cash_account: "Cash Account",
  bank_account: "Bank",
  exchange_deposit: "Exchange",
  broker_deposit: "Broker Dep.",
  crypto_position: "Crypto Pos.",
  stock_position: "Stock Pos.",
  diary_entry: "Diary",
  goal_price: "Goal",
  trade_entry: "Trade",
  institution: "Institution",
};

const ENTITY_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Types" },
  { value: "crypto_asset", label: "Crypto Assets" },
  { value: "crypto_position", label: "Crypto Positions" },
  { value: "stock_asset", label: "Stock Assets" },
  { value: "stock_position", label: "Stock Positions" },
  { value: "wallet", label: "Wallets" },
  { value: "broker", label: "Brokers" },
  { value: "cash_account", label: "Cash Accounts" },
  { value: "bank_account", label: "Bank Accounts" },
  { value: "exchange_deposit", label: "Fiat Deposits" },
  { value: "trade_entry", label: "Trades" },
];

const ACTION_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All Actions" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "removed", label: "Removed" },
  { value: "undone", label: "Undone" },
];

// Entity types that affect cash flow derivation
const CASH_FLOW_ENTITIES: EntityType[] = [
  "cash_account",
  "exchange_deposit", "broker_deposit", "bank_account",
  "crypto_position", "stock_position",
];

// ─── Icon / color helpers ───────────────────────────────

function getEntityIcon(type: EntityType) {
  switch (type) {
    case "crypto_asset":
    case "crypto_position":
      return Bitcoin;
    case "stock_asset":
    case "stock_position":
      return TrendingUp;
    case "wallet":
      return Wallet;
    case "broker":
    case "broker_deposit":
      return Building2;
    case "cash_account":
    case "bank_account":
      return Landmark;
    case "exchange_deposit":
      return ArrowLeftRight;
    case "trade_entry":
      return BookOpen;
    case "institution":
      return Landmark;
    case "manual_nav_update":
      // Same icon used elsewhere for adjustments — the slider conveys
      // "manual value entry" which matches the NAV CRUD semantic.
      return SlidersHorizontal;
    case "diary_entry":
      return BookOpen;
    case "goal_price":
      return TrendingUp;
  }
  // Exhaustive switch — `type` is `never` here. If a future EntityType is
  // added without updating this switch, TypeScript will error on the next
  // line. The fallback return keeps the call site safe at runtime.
  const _exhaustive: never = type;
  void _exhaustive;
  return Clock;
}

function getActionIcon(action: ActionType) {
  switch (action) {
    case "created":
      return Plus;
    case "updated":
      return Pencil;
    case "removed":
      return Trash2;
    case "undone":
      return Undo2;
  }
}

function getActionColor(action: ActionType) {
  switch (action) {
    case "created":
      return "bg-emerald-500/15 text-emerald-400";
    case "updated":
      return "bg-blue-500/15 text-blue-400";
    case "removed":
      return "bg-red-500/15 text-red-400";
    case "undone":
      return "bg-amber-500/15 text-amber-400";
  }
}

function getEntityBadgeColor(type: EntityType) {
  switch (type) {
    case "crypto_asset":
    case "crypto_position":
      return "bg-orange-500/15 text-orange-400";
    case "stock_asset":
    case "stock_position":
      return "bg-blue-500/15 text-blue-400";
    case "wallet":
      return "bg-purple-500/15 text-purple-400";
    case "broker":
    case "broker_deposit":
      return "bg-cyan-500/15 text-cyan-400";
    case "cash_account":
    case "bank_account":
      return "bg-green-500/15 text-green-400";
    case "exchange_deposit":
      return "bg-amber-500/15 text-amber-400";
    case "trade_entry":
      return "bg-pink-500/15 text-pink-400";
    case "institution":
      return "bg-green-500/15 text-green-400";
    case "manual_nav_update":
      // Matches the project's private_equity asset_category color (violet).
      return "bg-violet-500/15 text-violet-400";
    case "diary_entry":
      return "bg-zinc-700/40 text-zinc-300";
    case "goal_price":
      return "bg-fuchsia-500/15 text-fuchsia-400";
  }
  // Exhaustive switch — TS-error if a future EntityType isn't handled.
  const _exhaustive: never = type;
  void _exhaustive;
  return "bg-zinc-500/15 text-zinc-400";
}

// ─── Date grouping helpers ──────────────────────────────

function getDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const entryDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );

  if (entryDate.getTime() === today.getTime()) return "Today";
  if (entryDate.getTime() === yesterday.getTime()) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function getTimeLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function groupByDate(logs: ActivityLog[]): Map<string, ActivityLog[]> {
  const groups = new Map<string, ActivityLog[]>();
  for (const log of logs) {
    const label = getDateLabel(log.created_at);
    const existing = groups.get(label);
    if (existing) {
      existing.push(log);
    } else {
      groups.set(label, [log]);
    }
  }
  return groups;
}

// ─── Snapshot diff for "updated" entries ─────────────────

/** Columns to skip when diffing snapshots — system/meta fields. */
const SKIP_DIFF_COLUMNS = new Set([
  "id", "user_id", "created_at", "updated_at", "deleted_at",
  "last_was_adjustment", "last_was_transfer",
]);

/** Human-readable labels for known columns. */
const FIELD_LABELS: Record<string, string> = {
  apy: "APY",
  amount: "Amount",
  balance: "Balance",
  quantity: "Qty",
  currency: "Currency",
  name: "Name",
  ticker: "Ticker",
  broker_id: "Broker",
  wallet_id: "Wallet",
  institution_id: "Institution",
  category: "Category",
  subcategory: "Subcategory",
  chain: "Chain",
  isin: "ISIN",
  stock_asset_id: "Asset",
  wallet_type: "Type",
};

/** Format a snapshot value for display. */
function formatDiffValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "number") {
    return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Build a human-readable change summary from before/after snapshots. */
export function describeChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): string | null {
  if (!before || !after) return null;
  const changes: string[] = [];
  for (const key of Object.keys(after)) {
    if (SKIP_DIFF_COLUMNS.has(key)) continue;
    const bVal = before[key];
    const aVal = after[key];
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      const label = FIELD_LABELS[key] ?? key.replace(/_/g, " ");
      changes.push(`${label}: ${formatDiffValue(bVal)} → ${formatDiffValue(aVal)}`);
    }
  }
  if (changes.length === 0) return null;
  if (changes.length <= 3) return changes.join(", ");
  return `${changes.slice(0, 3).join(", ")} +${changes.length - 3} more`;
}

// ─── Transfer grouping ──────────────────────────────────

type TimelineItem =
  | { type: "single"; entry: ActivityLog }
  | { type: "transfer"; groupId: string; entries: ActivityLog[] }
  | { type: "split"; parent: ActivityLog; children: ActivityLog[] };

/** Merge entries sharing a transfer_group_id into grouped items. */
function groupTransfers(
  dateGroups: Map<string, ActivityLog[]>
): Map<string, TimelineItem[]> {
  const result = new Map<string, TimelineItem[]>();

  for (const [dateLabel, entries] of dateGroups) {
    const items: TimelineItem[] = [];
    const transferMap = new Map<string, ActivityLog[]>();
    const placed = new Set<string>();

    for (const entry of entries) {
      if (entry.transfer_group_id) {
        const group = transferMap.get(entry.transfer_group_id);
        if (group) group.push(entry);
        else transferMap.set(entry.transfer_group_id, [entry]);
      }
    }

    for (const entry of entries) {
      if (placed.has(entry.id)) continue;
      placed.add(entry.id);

      if (entry.transfer_group_id) {
        const group = transferMap.get(entry.transfer_group_id)!;
        if (group.length >= 2) {
          for (const e of group) placed.add(e.id);
          items.push({ type: "transfer", groupId: entry.transfer_group_id, entries: group });
        } else {
          items.push({ type: "single", entry });
        }
      } else {
        items.push({ type: "single", entry });
      }
    }

    result.set(dateLabel, items);
  }

  return result;
}

/** Replace single items whose ID appears as split_from_id with grouped split items. */
function groupSplits(
  dateGroups: Map<string, TimelineItem[]>,
  splitChildren: ActivityLog[]
): Map<string, TimelineItem[]> {
  if (splitChildren.length === 0) return dateGroups;

  // Build map: parentId → children
  const childrenByParent = new Map<string, ActivityLog[]>();
  for (const child of splitChildren) {
    if (!child.split_from_id) continue;
    const existing = childrenByParent.get(child.split_from_id);
    if (existing) existing.push(child);
    else childrenByParent.set(child.split_from_id, [child]);
  }

  const result = new Map<string, TimelineItem[]>();
  for (const [dateLabel, items] of dateGroups) {
    const mapped = items.map((item): TimelineItem => {
      if (item.type !== "single") return item;
      const children = childrenByParent.get(item.entry.id);
      if (children && children.length > 0) {
        return { type: "split", parent: item.entry, children };
      }
      return item;
    });
    result.set(dateLabel, mapped);
  }
  return result;
}

/** Check if effective_date differs from created_at date. */
function hasEffectiveDate(log: ActivityLog): boolean {
  if (!log.effective_date) return false;
  const createdDate = log.created_at.split("T")[0];
  return log.effective_date !== createdDate;
}

/** Format effective_date for display. */
function formatEffectiveDate(effectiveDate: string): string {
  return new Date(effectiveDate + "T00:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Identify source (negative delta) and destination (positive delta) legs. */
export function identifyTransferLegs(entries: ActivityLog[]): {
  source: ActivityLog;
  dest: ActivityLog;
} {
  if (entries.length < 2) return { source: entries[0], dest: entries[0] };

  const d0 = entries[0].delta_eur ?? entries[0].delta_usd ?? 0;
  const d1 = entries[1].delta_eur ?? entries[1].delta_usd ?? 0;
  return d0 <= d1
    ? { source: entries[0], dest: entries[1] }
    : { source: entries[1], dest: entries[0] };
}

/** Extract institution/location name from an entity_name. */
function extractLocation(entityName: string): string | null {
  // "Payroll (Alpha Bank)" → "Alpha Bank"
  const parenMatch = entityName.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) return parenMatch[1];
  // "6984 EUR on Trading212" → "Trading212"
  const onMatch = entityName.match(/ on (.+)$/);
  if (onMatch) return onMatch[1];
  return null;
}

const _transferFmtCache = new Map<string, Intl.NumberFormat>();
function getTransferFmt(currency: string, maxFractionDigits: number): Intl.NumberFormat {
  const key = `${currency}:${maxFractionDigits}`;
  let fmt = _transferFmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: maxFractionDigits,
    });
    _transferFmtCache.set(key, fmt);
  }
  return fmt;
}

/** Format absolute delta as currency string. */
function formatTransferAmount(log: ActivityLog): string | null {
  const delta = log.delta_eur ?? log.delta_usd;
  if (delta == null || delta === 0) return null;
  const abs = Math.abs(delta);
  const cur = log.delta_eur != null ? "EUR" : "USD";
  return getTransferFmt(cur, abs >= 100 ? 0 : 2).format(abs);
}

/** Extract quantity change from before/after snapshots. */
function extractQtyChange(log: ActivityLog): number | null {
  const before = log.before_snapshot?.quantity;
  const after = log.after_snapshot?.quantity;
  if (typeof before === "number" && typeof after === "number") {
    return Math.abs(before - after);
  }
  return null;
}

/** Build a human-readable transfer summary line. */
export function buildTransferSummary(source: ActivityLog, dest: ActivityLog): string {
  const srcLoc = extractLocation(source.entity_name);
  const destLoc = extractLocation(dest.entity_name);

  // Both locations extractable (cash transfers) → "€6984 transferred from Alpha Bank → Trading212"
  if (srcLoc && destLoc) {
    const amount = formatTransferAmount(source);
    if (amount) return `${amount} transferred from ${srcLoc} → ${destLoc}`;
    return `Transferred from ${srcLoc} → ${destLoc}`;
  }

  // Same entity (position move between brokers/wallets) → "5 VWCE transferred"
  if (source.entity_name === dest.entity_name) {
    const qty = extractQtyChange(source);
    if (qty != null) return `${qty} ${source.entity_name} transferred`;
    return `${source.entity_name} transferred`;
  }

  // Mixed types, partial location info
  const amount = formatTransferAmount(source);
  if (amount) return `${amount} from ${source.entity_name} → ${dest.entity_name}`;
  return `${source.entity_name} → ${dest.entity_name}`;
}

// ─── Main component ─────────────────────────────────────

export function ActivityTimeline({
  logs,
  total,
  page,
  limit,
  currentEntityType,
  currentAction,
  splitChildren = [],
}: ActivityTimelineProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { isReadOnly, shareToken } = useSharedView();
  const [expandedTransfers, setExpandedTransfers] = useState<Set<string>>(new Set());
  const [expandedSplits, setExpandedSplits] = useState<Set<string>>(new Set());
  const [backdatingId, setBackdatingId] = useState<string | null>(null);
  const [backdateValue, setBackdateValue] = useState("");
  const [splitEntry, setSplitEntry] = useState<ActivityLog | null>(null);

  const totalPages = Math.ceil(total / limit);

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      // Reset to page 1 when filters change
      if (key !== "page") {
        params.delete("page");
      }
      // Anon share viewers stay on /share/[token]/history — the authed
      // /dashboard/history path would be rejected by the auth proxy.
      const basePath = isReadOnly && shareToken
        ? `/share/${shareToken}/history`
        : "/dashboard/history";
      startTransition(() => {
        router.push(`${basePath}?${params.toString()}`);
      });
    },
    [router, searchParams, isReadOnly, shareToken]
  );

  async function handleUndo(logId: string) {
    try {
      const result = await undoActivity(logId);
      if (result.success) {
        toast.success(result.message);
        startTransition(() => {
          router.refresh();
        });
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Failed to undo action");
    }
  }

  async function handleExportCsv() {
    try {
      const csv = await exportActivityLogsCsv();
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `activity-history-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Failed to export CSV");
    }
  }

  async function handleToggleAdjustment(logId: string, isAdjustment: boolean) {
    try {
      await toggleActivityAdjustment(logId, isAdjustment);
      startTransition(() => { router.refresh(); });
      toast.success(isAdjustment ? "Marked as adjustment" : "Marked as transaction");
    } catch {
      toast.error("Failed to update");
    }
  }

  function toggleTransferExpand(groupId: string) {
    setExpandedTransfers((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function toggleSplitExpand(parentId: string) {
    setExpandedSplits((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  async function handleBackdate(logId: string, date: string) {
    try {
      const result = await backdateActivityEntry(logId, date || null);
      if (result.success) {
        toast.success(result.message);
        setBackdatingId(null);
        startTransition(() => { router.refresh(); });
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Failed to set effective date");
    }
  }

  async function handleUnsplit(parentId: string) {
    try {
      const result = await unsplitActivityEntry(parentId);
      if (result.success) {
        toast.success(result.message);
        startTransition(() => { router.refresh(); });
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Failed to unsplit");
    }
  }

  const grouped = groupSplits(
    groupTransfers(groupByDate(logs)),
    splitChildren
  );

  return (
    <div className={isPending ? "opacity-60 transition-opacity" : ""}>
      {/* Filter bar */}
      <div className="mb-6 space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={currentEntityType ?? ""}
            onChange={(e) => updateFilter("type", e.target.value)}
            aria-label="Filter by entity type"
            className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          >
            {ENTITY_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            value={currentAction ?? ""}
            onChange={(e) => updateFilter("action", e.target.value)}
            aria-label="Filter by action"
            className="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          >
            {ACTION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className="flex-1" />

          {!isReadOnly && total > 0 && (
            <button
              onClick={handleExportCsv}
              className="shrink-0 p-2 text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 rounded-lg hover:bg-zinc-800/80 transition-colors"
              aria-label="Export CSV"
              title="Export CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <span className="text-xs text-zinc-400">
          {total} {total === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Empty state */}
      {logs.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-12 text-center">
          <Clock className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-400 font-medium">No activity yet</p>
          <p className="text-xs text-zinc-400 mt-1">
            Changes to your portfolio will appear here
          </p>
        </div>
      ) : (
        <>
          {/* Timeline grouped by date */}
          <div className="space-y-6">
            {Array.from(grouped.entries()).map(([dateLabel, items]) => (
              <div key={dateLabel}>
                {/* Date header */}
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    {dateLabel}
                  </span>
                  <div className="flex-1 h-px bg-zinc-800/50" />
                </div>

                {/* Entries */}
                <div className="space-y-1">
                  {items.map((item) => {
                    if (item.type === "transfer") {
                      const { source, dest } = identifyTransferLegs(item.entries);
                      const isExpanded = expandedTransfers.has(item.groupId);
                      const isUndone = item.entries.some((e) => e.undone_at);
                      const entityTypes = [...new Set(item.entries.map((e) => e.entity_type))];
                      const summaryText = buildTransferSummary(source, dest);

                      return (
                        <div
                          key={`xfer-${item.groupId}`}
                          className={`border-l-2 border-teal-500/30 rounded-r-lg ${isUndone ? "opacity-50" : ""}`}
                        >
                          {/* Transfer header */}
                          <div className="flex items-start gap-3 px-3 py-2.5 rounded-r-lg hover:bg-zinc-900/50 transition-colors group">
                            <div className="shrink-0 p-1.5 rounded-lg bg-teal-500/15 text-teal-400 mt-0.5">
                              <ArrowLeftRight className="w-3.5 h-3.5" />
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-zinc-200">Transfer</span>
                                {entityTypes.map((type) => {
                                  const Icon = getEntityIcon(type);
                                  return (
                                    <span
                                      key={type}
                                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${getEntityBadgeColor(type)}`}
                                    >
                                      <Icon className="w-2.5 h-2.5" />
                                      {ENTITY_LABELS[type] ?? type}
                                    </span>
                                  );
                                })}
                              </div>
                              <p className="text-xs text-zinc-400 mt-0.5 truncate">
                                {summaryText}
                              </p>
                            </div>

                            <div className="shrink-0 flex items-center gap-2 mt-0.5">
                              <button
                                onClick={() => toggleTransferExpand(item.groupId)}
                                className="p-1 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-all"
                                aria-label={isExpanded ? "Collapse" : "Show details"}
                                title={isExpanded ? "Collapse" : "Show details"}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                )}
                              </button>
                              {isUndone ? (
                                <span className="text-[10px] font-medium text-zinc-400 bg-zinc-800/50 px-1.5 py-0.5 rounded">
                                  Undone
                                </span>
                              ) : !isReadOnly ? (
                                <ConfirmButton
                                  onConfirm={() => handleUndo(source.id)}
                                  confirmLabel="Undo?"
                                  confirmLabelClassName="text-amber-400"
                                  className="md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto p-1 rounded text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                                  title="Undo this transfer"
                                >
                                  <Undo2 className="w-3.5 h-3.5" />
                                </ConfirmButton>
                              ) : null}
                              <span className="text-xs text-zinc-400">
                                {getTimeLabel(source.created_at)}
                              </span>
                            </div>
                          </div>

                          {/* Expanded legs */}
                          {isExpanded && (
                            <div className="ml-[2.75rem] space-y-0.5 pb-2">
                              {item.entries.map((leg) => {
                                const LegIcon = getActionIcon(leg.action);
                                const legColor = getActionColor(leg.action);
                                return (
                                  <div key={leg.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs">
                                    <div className={`shrink-0 p-1 rounded ${legColor}`}>
                                      <LegIcon className="w-2.5 h-2.5" />
                                    </div>
                                    <span className="text-zinc-400 shrink-0">{leg.entity_name}</span>
                                    <span className="text-zinc-400 truncate">{leg.description}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    }

                    if (item.type === "split") {
                      const { parent, children } = item;
                      const isExpanded = expandedSplits.has(parent.id);
                      const EntityIcon = getEntityIcon(parent.entity_type);
                      const entityColor = getEntityBadgeColor(parent.entity_type);

                      return (
                        <div
                          key={`split-${parent.id}`}
                          className="border-l-2 border-violet-500/30 rounded-r-lg"
                        >
                          {/* Split header */}
                          <div className="flex items-start gap-3 px-3 py-2.5 rounded-r-lg hover:bg-zinc-900/50 transition-colors group">
                            <div className="shrink-0 p-1.5 rounded-lg bg-violet-500/15 text-violet-400 mt-0.5">
                              <GitBranch className="w-3.5 h-3.5" />
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-zinc-200 truncate">
                                  {parent.entity_name}
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${entityColor}`}
                                >
                                  <EntityIcon className="w-2.5 h-2.5" />
                                  {ENTITY_LABELS[parent.entity_type] ?? parent.entity_type}
                                </span>
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-violet-500/15 text-violet-400">
                                  Split
                                </span>
                                {parent.is_adjustment && (
                                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-500/15 text-amber-400" title="Not a real transaction — portfolio balance correction">
                                    Adj.
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-zinc-400 mt-0.5 truncate">
                                Split into {children.length} date allocations
                              </p>
                            </div>

                            <div className="shrink-0 flex items-center gap-2 mt-0.5">
                              {!isReadOnly && (
                                <ConfirmButton
                                  onConfirm={() => handleUnsplit(parent.id)}
                                  confirmLabel="Unsplit?"
                                  confirmLabelClassName="text-violet-400"
                                  className="md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto p-1 rounded text-zinc-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all"
                                  title="Unsplit — restore original entry"
                                >
                                  <Merge className="w-3.5 h-3.5" />
                                </ConfirmButton>
                              )}
                              <button
                                onClick={() => toggleSplitExpand(parent.id)}
                                className="p-1 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-all"
                                aria-label={isExpanded ? "Collapse" : "Show split details"}
                                title={isExpanded ? "Collapse" : "Show split details"}
                              >
                                {isExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <span className="text-xs text-zinc-400">
                                {getTimeLabel(parent.created_at)}
                              </span>
                            </div>
                          </div>

                          {/* Expanded children */}
                          {isExpanded && (
                            <div className="ml-[2.75rem] space-y-0.5 pb-2">
                              {children.map((child) => {
                                const ChildActionIcon = getActionIcon(child.action);
                                const childColor = getActionColor(child.action);
                                const splitQty = child.details?.split_quantity;
                                return (
                                  <div key={child.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs">
                                    <div className={`shrink-0 p-1 rounded ${childColor}`}>
                                      <ChildActionIcon className="w-2.5 h-2.5" />
                                    </div>
                                    {splitQty != null && (
                                      <span className="text-zinc-300 shrink-0 font-medium">
                                        {Number(splitQty).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                                      </span>
                                    )}
                                    {child.effective_date && (
                                      <span className="text-[10px] text-sky-400 flex items-center gap-1 shrink-0">
                                        <Calendar className="w-3 h-3" />
                                        {formatEffectiveDate(child.effective_date)}
                                      </span>
                                    )}
                                    <span className="text-zinc-400 truncate">{child.description}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    }

                    const log = item.entry;
                    const EntityIcon = getEntityIcon(log.entity_type);
                    const ActionIcon = getActionIcon(log.action);
                    const actionColor = getActionColor(log.action);
                    const entityColor = getEntityBadgeColor(log.entity_type);
                    const canSplit = !log.undone_at && !log.split_from_id
                      && !log.transfer_group_id && !log.compensates_for
                      && (log.cashflow_status === "complete" || log.delta_status === "complete");

                    return (
                      <div
                        key={log.id}
                        className={`flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-900/50 transition-colors group ${log.undone_at ? "opacity-50" : ""} ${log.action === "undone" ? "border-l-2 border-amber-500/40" : ""}`}
                      >
                        {/* Action icon */}
                        <div
                          className={`shrink-0 p-1.5 rounded-lg ${actionColor} mt-0.5`}
                        >
                          <ActionIcon className="w-3.5 h-3.5" />
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-zinc-200 truncate">
                              {log.entity_name}
                            </span>
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${entityColor}`}
                            >
                              <EntityIcon className="w-2.5 h-2.5" />
                              {ENTITY_LABELS[log.entity_type] ??
                                log.entity_type}
                            </span>
                            {log.action === "undone" && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-500/15 text-amber-400">
                                <Undo2 className="w-2.5 h-2.5" />
                                Undo
                              </span>
                            )}
                            {log.compensates_for && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-500/15 text-amber-400" title="Compensating undo — reversed a previous action">
                                <Undo2 className="w-2.5 h-2.5" />
                                Undo
                              </span>
                            )}
                            {log.transfer_group_id && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-teal-500/15 text-teal-400" title="Part of a sell/buy/move transfer">
                                Xfer
                              </span>
                            )}
                            {!log.transfer_group_id && !log.compensates_for && log.is_adjustment && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-amber-500/15 text-amber-400" title="Not a real transaction — portfolio balance correction">
                                Adj.
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-400 mt-0.5 truncate">
                            {(log.action === "updated" && describeChanges(log.before_snapshot, log.after_snapshot)) || log.description}
                          </p>
                          {/* Effective date annotation */}
                          {hasEffectiveDate(log) && (
                            <span className="text-[10px] text-sky-400 flex items-center gap-1 mt-0.5">
                              <Calendar className="w-3 h-3" />
                              Effective: {formatEffectiveDate(log.effective_date!)}
                            </span>
                          )}
                          {/* Inline backdate date picker */}
                          {backdatingId === log.id && (
                            <div className="flex items-center gap-2 mt-1">
                              <input
                                type="date"
                                value={backdateValue}
                                max={new Date().toISOString().split("T")[0]}
                                className="px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-sky-500/70"
                                onChange={(e) => setBackdateValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") setBackdatingId(null);
                                  if (e.key === "Enter") handleBackdate(log.id, backdateValue);
                                }}
                                autoFocus
                              />
                              <button
                                onClick={() => handleBackdate(log.id, backdateValue)}
                                className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors"
                                title="Set effective date"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setBackdatingId(null)}
                                className="p-1 rounded text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Action buttons / Adjustment toggle / Undo / Undone badge / Time */}
                        <div className="shrink-0 flex items-center gap-2 mt-0.5">
                          {/* Calendar (backdate) button */}
                          {!isReadOnly && !log.undone_at && !log.split_from_id && (
                            <button
                              onClick={() => {
                              if (backdatingId === log.id) {
                                setBackdatingId(null);
                              } else {
                                setBackdatingId(log.id);
                                setBackdateValue(log.effective_date ?? log.created_at.split("T")[0]);
                              }
                            }}
                              className={`p-1 rounded transition-all ${
                                hasEffectiveDate(log)
                                  ? "text-sky-400 bg-sky-500/10"
                                  : "md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
                              }`}
                              aria-label="Set effective date"
                              title="Set effective date"
                            >
                              <Calendar className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {/* GitBranch (split) button */}
                          {!isReadOnly && canSplit && (
                            <button
                              onClick={() => setSplitEntry(log)}
                              className="md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto p-1 rounded text-zinc-600 hover:text-violet-400 hover:bg-violet-500/10 transition-all"
                              aria-label="Split into multiple dates"
                              title="Split into multiple dates"
                            >
                              <GitBranch className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {!isReadOnly && !log.undone_at && CASH_FLOW_ENTITIES.includes(log.entity_type) && (
                            <button
                              onClick={() => handleToggleAdjustment(log.id, !log.is_adjustment)}
                              className={`p-1 rounded transition-all ${
                                log.is_adjustment
                                  ? "text-amber-400 bg-amber-500/10"
                                  : "md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
                              }`}
                              aria-label={log.is_adjustment ? "Marked as adjustment — click to count as transaction" : "Mark as portfolio adjustment"}
                              title={log.is_adjustment ? "Marked as adjustment — click to count as transaction" : "Mark as portfolio adjustment"}
                            >
                              <SlidersHorizontal className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {log.undone_at ? (
                            <span className="text-[10px] font-medium text-zinc-400 bg-zinc-800/50 px-1.5 py-0.5 rounded">
                              Undone
                            </span>
                          ) : !isReadOnly && log.entity_id ? (
                            <ConfirmButton
                              onConfirm={() => handleUndo(log.id)}
                              confirmLabel="Undo?"
                              confirmLabelClassName="text-amber-400"
                              className="md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto p-1 rounded text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                              title="Undo this action"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                            </ConfirmButton>
                          ) : null}
                          {/* Status icon for pending/failed cashflows */}
                          <CashflowStatusIcon
                            cashflowStatus={log.cashflow_status}
                            deltaStatus={log.delta_status}
                            onRetry={!isReadOnly ? async () => {
                              const result = await backfillSingleRow(log.id);
                              if (result.success) {
                                router.refresh();
                              }
                              return result;
                            } : undefined}
                          />
                          <span className="text-xs text-zinc-400">
                            {getTimeLabel(log.created_at)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-8 pt-4 border-t border-zinc-800/50">
              <span className="text-xs text-zinc-400">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => updateFilter("page", String(page - 1))}
                  disabled={page <= 1}
                  aria-label="Previous page"
                  className="p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => updateFilter("page", String(page + 1))}
                  disabled={page >= totalPages}
                  aria-label="Next page"
                  className="p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <SplitModal
        entry={splitEntry}
        onClose={() => setSplitEntry(null)}
        onSplit={async (parentId, legs) => {
          const { splitActivityEntry } = await import("@/lib/actions/splits");
          const result = await splitActivityEntry(parentId, legs);
          if (result.success) {
            toast.success(result.message);
            startTransition(() => { router.refresh(); });
          }
          return result;
        }}
      />
    </div>
  );
}
