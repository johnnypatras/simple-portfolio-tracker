"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info, Loader2, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import {
  migrateLegacyAdjustmentFlags,
  type LegacyAdjustmentMigrationResult,
} from "@/lib/actions/migrate-legacy-adjustments";

type Stage = "idle" | "confirming" | "migrating" | "done";

interface LegacyAdjustmentMigrationButtonProps {
  /**
   * Number of candidate entries reported by the most-recent server-side
   * preview call. Drives the confirm dialog copy. The migration call itself
   * re-scopes the candidate set server-side, so this number is purely
   * presentational and may be stale by the time the user clicks.
   */
  candidateCount: number;
}

/**
 * Client-side trigger for `migrateLegacyAdjustmentFlags()`. Renders the
 * "Migrate" button + an inline two-step confirmation flow + a post-run
 * result panel. After a successful migration, calls `router.refresh()` so
 * the parent server component re-renders with the new preview (now zero).
 */
export function LegacyAdjustmentMigrationButton({ candidateCount }: LegacyAdjustmentMigrationButtonProps) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<LegacyAdjustmentMigrationResult | null>(null);
  const isSubmittingRef = useRef<boolean>(false);

  async function handleConfirm() {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setStage("migrating");
    try {
      const migrationResult = await migrateLegacyAdjustmentFlags();
      setResult(migrationResult);
      setStage("done");
      if (migrationResult.errors > 0) {
        toast.error(
          `Migrated ${migrationResult.migrated} entries with ${migrationResult.errors} error${migrationResult.errors === 1 ? "" : "s"}`,
        );
      } else if (migrationResult.migrated === 0 && migrationResult.errors === 0) {
        toast.success("Nothing to migrate — already up to date");
      } else {
        toast.success(`Migrated ${migrationResult.migrated} ${migrationResult.migrated === 1 ? "entry" : "entries"}`);
      }
      // Refresh the parent server component so the preview count reflects
      // the post-migration state (typically zero) without a page reload.
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Migration failed";
      toast.error(message);
      setStage("idle");
    } finally {
      isSubmittingRef.current = false;
    }
  }

  function handleDone() {
    setStage("idle");
    setResult(null);
  }

  if (stage === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStage("confirming")}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
      >
        <SlidersHorizontal aria-hidden="true" className="w-4 h-4" />
        Migrate {candidateCount} {candidateCount === 1 ? "entry" : "entries"}
      </button>
    );
  }

  if (stage === "confirming") {
    return (
      <div className="bg-zinc-950/50 border border-blue-900/40 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Info aria-hidden="true" className="w-4 h-4 text-blue-400" />
          <p className="text-sm font-medium text-zinc-200">Confirm migration</p>
        </div>
        <p className="text-xs text-zinc-400">
          This will reclassify <span className="text-zinc-200 font-medium">{candidateCount}</span>{" "}
          {candidateCount === 1 ? "entry" : "entries"} from adjustment to real cash flow, so the S&amp;P
          benchmark counts them as deposits. The change is reversible — each entry can be toggled back via
          its &ldquo;Mark as adjustment&rdquo; button in the History timeline.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setStage("idle")}
            className="flex-1 px-3 py-2 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={stage !== "confirming"}
            className="flex-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Yes, migrate
          </button>
        </div>
      </div>
    );
  }

  if (stage === "migrating") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 flex items-center gap-3"
      >
        <Loader2 aria-hidden="true" className="w-5 h-5 text-zinc-400 animate-spin" />
        <p className="text-sm text-zinc-400">Migrating entries…</p>
      </div>
    );
  }

  // stage === "done"
  if (!result) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-zinc-950/50 border border-zinc-800 rounded-lg p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        {result.errors > 0 ? (
          <AlertTriangle aria-hidden="true" className="w-5 h-5 text-amber-400" />
        ) : (
          <CheckCircle2 aria-hidden="true" className="w-5 h-5 text-emerald-400" />
        )}
        <p className={`text-sm font-medium ${result.errors > 0 ? "text-amber-300" : "text-emerald-300"}`}>
          {result.errors > 0
            ? `Migrated ${result.migrated} of ${result.total_candidates}`
            : `Migrated ${result.migrated} ${result.migrated === 1 ? "entry" : "entries"}`}
        </p>
      </div>
      {result.errors > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-300 mb-2">
            {result.errors} error{result.errors === 1 ? "" : "s"}
          </p>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {result.details
              .filter((d) => d.status === "error")
              .map((d) => (
                <li
                  key={d.id}
                  className="text-xs text-zinc-400 bg-zinc-900/50 px-2.5 py-1.5 rounded-md border border-zinc-800/50"
                >
                  <span className="text-zinc-300 font-medium">{d.entity_name}</span>
                  <span className="text-zinc-500"> ({d.entity_type})</span>
                  {d.error_message && (
                    <span className="block text-red-400/80 mt-0.5">{d.error_message}</span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={handleDone}
        className="text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        Done
      </button>
    </div>
  );
}
