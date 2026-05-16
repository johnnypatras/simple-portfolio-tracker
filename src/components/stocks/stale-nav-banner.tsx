"use client";

import { useSyncExternalStore, useCallback } from "react";
import { AlertTriangle, X } from "lucide-react";
import { navStaleness } from "@/lib/manual-nav";
import { STALE_NAV_DAYS_THRESHOLD } from "@/lib/constants";

const DISMISS_STORAGE_KEY = "stale-nav-banner-dismissed-until";

interface StaleAsset {
  ticker: string;
  name: string;
  latestNavDate: string | null;
}

interface StaleNavBannerProps {
  /** All kind='manual' assets with their latest NAV date (null if never recorded). */
  assets: StaleAsset[];
}

/**
 * Sync the "dismissed today?" flag from localStorage using React's canonical
 * pattern for external mutable state. Listening on the "storage" event keeps
 * the banner in sync if dismissed in another tab/window.
 */
function subscribeDismissed(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getClientDismissed(): boolean {
  try {
    const stored = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    const today = new Date().toISOString().split("T")[0];
    return stored === today;
  } catch {
    return false;
  }
}

function getServerDismissed(): boolean {
  // SSR: default to dismissed so the banner never flashes before hydration
  // reveals it. The client snapshot supersedes immediately after mount.
  return true;
}

/**
 * Banner shown at the top of the stocks page when any kind='manual' asset
 * has a NAV older than STALE_NAV_DAYS_THRESHOLD days OR has no NAV at all.
 *
 * Dismissible per day: clicking the × writes today's date to localStorage
 * and the banner stays hidden until tomorrow. Balances "loud reminder"
 * with "don't be annoying when the user already knows."
 *
 * The banner is null when:
 *   - No manual assets exist
 *   - All manual assets have a fresh NAV (≤ threshold days)
 *   - The user dismissed the banner today
 */
export function StaleNavBanner({ assets }: StaleNavBannerProps) {
  const dismissed = useSyncExternalStore(
    subscribeDismissed,
    getClientDismissed,
    getServerDismissed,
  );

  const handleDismiss = useCallback(() => {
    try {
      const today = new Date().toISOString().split("T")[0];
      window.localStorage.setItem(DISMISS_STORAGE_KEY, today);
      // Manually dispatch a storage event so useSyncExternalStore picks it up
      // — the "storage" event fires only for OTHER tabs, not the writing tab.
      window.dispatchEvent(new StorageEvent("storage", { key: DISMISS_STORAGE_KEY }));
    } catch {
      // localStorage unavailable — fall through; banner re-shows on next mount
    }
  }, []);

  const staleOrMissing = assets.filter((a) => {
    if (!a.latestNavDate) return true; // no NAV at all
    const { daysAgo } = navStaleness(a.latestNavDate);
    return daysAgo > STALE_NAV_DAYS_THRESHOLD;
  });

  if (dismissed) return null;
  if (staleOrMissing.length === 0) return null;

  const count = staleOrMissing.length;
  const sample = staleOrMissing.slice(0, 3).map((a) => {
    if (!a.latestNavDate) return `${a.ticker} (no NAV)`;
    const { label } = navStaleness(a.latestNavDate);
    return `${a.ticker} (${label})`;
  });
  const summary = sample.join(", ") + (count > 3 ? ` and ${count - 3} more` : "");

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20"
    >
      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-amber-200">
          {count === 1
            ? "1 manual NAV needs updating"
            : `${count} manual NAVs need updating`}
        </div>
        <div className="text-[11px] text-amber-200/70 truncate" title={summary}>{summary}</div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="p-1 text-amber-300/60 hover:text-amber-200 hover:bg-amber-500/10 rounded transition-colors shrink-0"
        aria-label="Dismiss banner until tomorrow"
        title="Dismiss until tomorrow"
      >
        <X aria-hidden="true" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
