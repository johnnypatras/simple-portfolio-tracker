"use client";

import { useState, useEffect, useId, useCallback } from "react";
import { Loader2, Plus, Pencil, Trash2, X, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { upsertManualNav, deleteManualNav } from "@/lib/actions/manual-nav";
import { navStaleness } from "@/lib/manual-nav";
import { formatCurrency } from "@/lib/format";
import { STALE_NAV_DAYS_THRESHOLD, MAX_NAV_NOTE_LENGTH } from "@/lib/constants";
import type { StockAssetWithPositions } from "@/lib/types";

interface UpdateNavModalProps {
  open: boolean;
  onClose: () => void;
  asset: StockAssetWithPositions;
}

interface NavRow {
  id: string;
  effective_date: string;
  nav: number;
  note: string | null;
}

export function UpdateNavModal({ open, onClose, asset }: UpdateNavModalProps) {
  const id = useId();
  const today = new Date().toISOString().split("T")[0];

  const [navs, setNavs] = useState<NavRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state for add OR edit
  const [editingDate, setEditingDate] = useState<string | null>(null); // null = adding new
  const [formDate, setFormDate] = useState(today);
  const [formNav, setFormNav] = useState("");
  const [formNote, setFormNote] = useState("");

  const fetchNavs = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: fetchErr } = await supabase
        .from("manual_nav_updates")
        .select("id, effective_date, nav, note")
        .eq("asset_id", asset.id)
        .order("effective_date", { ascending: false });
      if (fetchErr) throw new Error(fetchErr.message);
      setNavs(
        (data ?? []).map((row) => ({
          id: row.id as string,
          effective_date: row.effective_date as string,
          nav: Number(row.nav),
          note: (row.note as string | null) ?? null,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load NAV history");
    } finally {
      setLoading(false);
    }
  }, [asset.id, open]);

  useEffect(() => {
    void fetchNavs();
  }, [fetchNavs]);

  useEffect(() => {
    if (!open) {
      setEditingDate(null);
      setFormDate(today);
      setFormNav("");
      setFormNote("");
      setError(null);
    }
  }, [open, today]);

  function startEdit(row: NavRow) {
    setEditingDate(row.effective_date);
    setFormDate(row.effective_date);
    setFormNav(String(row.nav));
    setFormNote(row.note ?? "");
  }

  function cancelEdit() {
    setEditingDate(null);
    setFormDate(today);
    setFormNav("");
    setFormNote("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const navNum = parseFloat(formNav);
    if (!formDate || isNaN(navNum) || navNum <= 0) {
      setError("Provide a valid date and a positive NAV value.");
      return;
    }

    setSubmitting(true);
    try {
      await upsertManualNav({
        asset_id: asset.id,
        effective_date: formDate,
        nav: navNum,
        note: formNote.trim() || null,
      });
      toast.success(
        editingDate ? "NAV updated" : `NAV recorded for ${asset.ticker}`,
      );
      await fetchNavs();
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save NAV");
    } finally {
      setSubmitting(false);
    }
  }

  // In-modal delete confirmation. Replaces native confirm() which broke the
  // FocusTrap and shipped unstyled OS chrome inside the dark-themed modal.
  const [confirmDeleteDate, setConfirmDeleteDate] = useState<string | null>(null);

  async function handleDelete(row: NavRow) {
    setError(null);
    try {
      await deleteManualNav({
        asset_id: asset.id,
        effective_date: row.effective_date,
      });
      toast.success(`${asset.ticker} NAV entry removed`);
      setConfirmDeleteDate(null);
      await fetchNavs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete NAV");
      setConfirmDeleteDate(null);
    }
  }

  const isEditing = editingDate !== null;
  const latest = navs[0]; // sorted DESC
  const stale = latest ? navStaleness(latest.effective_date) : null;
  const isStale = stale && stale.daysAgo > STALE_NAV_DAYS_THRESHOLD;

  return (
    <Modal open={open} onClose={onClose} title={`${asset.ticker} — NAV History`}>
      <div className="space-y-4">
        {/* Header: asset summary + staleness */}
        <div className="flex items-center justify-between bg-zinc-900/40 border border-zinc-800/50 rounded-lg px-3 py-2">
          <div>
            <div className="text-sm font-medium text-zinc-100">{asset.name}</div>
            <div className="text-[10px] text-zinc-400">
              {asset.ticker} · {asset.currency}
            </div>
          </div>
          {latest && (
            <div className="text-right">
              <div className="text-sm tabular-nums text-zinc-200">
                {formatCurrency(latest.nav, asset.currency)}
              </div>
              <div className={`text-[10px] inline-flex items-center gap-1 ${isStale ? "text-amber-400" : "text-zinc-400"}`}>
                {isStale && <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />}
                {isStale ? "Stale — " : "Updated "}{stale?.label}
              </div>
            </div>
          )}
        </div>

        {/* Add / Edit form */}
        <form
          onSubmit={handleSubmit}
          className="border border-zinc-800/60 rounded-lg p-3 space-y-3 bg-zinc-900/20"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              {isEditing ? (
                <>
                  <Pencil className="w-3 h-3" aria-hidden="true" />
                  Editing NAV for {editingDate}
                </>
              ) : (
                <>
                  <Plus className="w-3 h-3" aria-hidden="true" />
                  Record new NAV
                </>
              )}
            </div>
            {isEditing && (
              <button
                type="button"
                onClick={cancelEdit}
                className="text-[10px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                Cancel edit
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-date`} className="block text-xs text-zinc-400 mb-1">
                As of date
              </label>
              <input
                id={`${id}-date`}
                type="date"
                value={formDate}
                max={today}
                onChange={(e) => setFormDate(e.target.value)}
                disabled={isEditing /* date is the unique key — can't change it */}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70 disabled:opacity-60"
              />
              {isEditing && (
                <p className="text-[10px] text-zinc-400 mt-1">
                  Delete and re-add to change the date.
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`${id}-nav`} className="block text-xs text-zinc-400 mb-1">
                NAV
              </label>
              <input
                id={`${id}-nav`}
                type="number"
                inputMode="decimal"
                value={formNav}
                onChange={(e) => setFormNav(e.target.value)}
                placeholder="105.50"
                step="any"
                min="0"
                required
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70 tabular-nums"
              />
            </div>
          </div>

          <div>
            <label htmlFor={`${id}-note`} className="block text-xs text-zinc-400 mb-1">
              Note <span className="text-zinc-400">(optional, e.g. &quot;Q1 2026 fund letter&quot;)</span>
            </label>
            <input
              id={`${id}-note`}
              type="text"
              value={formNote}
              onChange={(e) => setFormNote(e.target.value)}
              placeholder="Source / provenance"
              maxLength={MAX_NAV_NOTE_LENGTH}
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !formDate || !formNav.trim()}
            aria-busy={submitting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {isEditing ? "Save changes" : "Record NAV"}
          </button>
        </form>

        {/* History list */}
        <div>
          <div className="text-xs font-medium text-zinc-300 mb-2">
            History <span className="text-zinc-400 font-normal">({navs.length})</span>
          </div>

          {loading ? (
            <div
              className="flex items-center justify-center py-6 text-xs text-zinc-400"
              role="status"
              aria-busy="true"
              aria-live="polite"
            >
              <Loader2 className="w-4 h-4 animate-spin mr-2" aria-hidden="true" />
              Loading NAV history...
            </div>
          ) : navs.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center py-6" aria-live="polite">
              No NAV entries yet. Record the first one using the form above.
            </p>
          ) : (
            <ul
              aria-label="NAV history"
              tabIndex={0}
              className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800/60 divide-y divide-zinc-800/50 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              {navs.map((row) => {
                const isThisRowBeingEdited = editingDate === row.effective_date;
                const isConfirmingDelete = confirmDeleteDate === row.effective_date;
                return (
                  <li
                    key={row.id}
                    className={`flex items-center justify-between px-3 py-2 hover:bg-zinc-800/20 transition-colors ${
                      isThisRowBeingEdited ? "bg-zinc-800/30" : ""
                    } ${isConfirmingDelete ? "bg-red-500/10" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs tabular-nums text-zinc-300">
                          {row.effective_date}
                        </span>
                        <span className="text-sm tabular-nums font-medium text-zinc-100">
                          {formatCurrency(row.nav, asset.currency)}
                        </span>
                      </div>
                      {row.note && (
                        <div className="text-[10px] text-zinc-400 truncate mt-0.5">
                          {row.note}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-2">
                      {isConfirmingDelete ? (
                        <>
                          <span className="text-[10px] text-red-300 mr-1" aria-live="assertive">
                            Delete?
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleDelete(row)}
                            className="px-2 py-1 inline-flex items-center justify-center min-h-6 text-[10px] font-medium text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                            aria-label={`Confirm delete NAV for ${row.effective_date}`}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteDate(null)}
                            className="px-2 py-1 inline-flex items-center justify-center min-h-6 text-[10px] font-medium text-zinc-200 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                            aria-label="Cancel delete"
                          >
                            No
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(row)}
                            className="p-1.5 inline-flex items-center justify-center min-w-6 min-h-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50 rounded transition-colors"
                            aria-label={`Edit NAV for ${row.effective_date}`}
                            title="Edit this NAV"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteDate(row.effective_date)}
                            className="p-1.5 inline-flex items-center justify-center min-w-6 min-h-6 text-zinc-400 hover:text-red-400 hover:bg-zinc-700/50 rounded transition-colors"
                            aria-label={`Delete NAV for ${row.effective_date}`}
                            title="Delete this NAV"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
