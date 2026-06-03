import type { ReactNode } from "react";
import type { FXRates } from "@/lib/prices/fx";
import type { AssetPnL } from "@/lib/portfolio/cost-basis";

// ── Context passed to every renderCell / renderHeader ────────

export interface RenderContext {
  primaryCurrency: string;
  fxRates: FXRates;
  /**
   * Per-asset cost-basis P&L, keyed by AssetKey (`crypto:{id}` / `stock:{id}` /
   * `cash:{accountId}`). Optional — absent when the cost-basis transaction read
   * was skipped or failed (graceful degradation); column renderers then show
   * "—". EUR is the authoritative headline; USD diverges legitimately by FX
   * timing. See {@link AssetPnL}.
   */
  pnlByAsset?: Record<string, AssetPnL>;
}

// ── Generic column definition ────────────────────────────────

export interface ColumnDef<TRow> {
  /** Unique key for this column, e.g. "balance", "apy" */
  key: string;
  /** Human-readable label shown in the settings popover */
  label: string;
  /** Text rendered in the thead (can differ from label) */
  header: string;
  /** Pinned columns are always visible and cannot be reordered */
  pinned?: "left" | "right";
  /** Whether this column is visible by default (default: true) */
  defaultVisible?: boolean;
  /** Text alignment — maps to "text-left", "text-center", or "text-right" */
  align?: "left" | "center" | "right";
  /** Hide this column below a Tailwind breakpoint */
  hiddenBelow?: "sm" | "md" | "lg" | "xl";
  /** Fixed Tailwind width class, e.g. "w-28" */
  width?: string;
  /** Optional scope tag — when set, the column only applies to tables
   *  whose ID matches (e.g. "bank", "exchange"). Undefined = all tables. */
  appliesTo?: string;
  /** Render the table cell content */
  renderCell: (row: TRow, ctx: RenderContext) => ReactNode;
  /** Optional override for the header cell content */
  renderHeader?: (ctx: RenderContext) => ReactNode;
}

// ── Sort direction ────────────────────────────────────────────

export type SortDirection = "asc" | "desc";

// ── Persisted column configuration state ─────────────────────

export interface ColumnConfigState {
  /** Schema version — bump to invalidate stale localStorage */
  version: number;
  /** Ordered list of visible non-pinned column keys */
  visibleKeys: string[];
}
