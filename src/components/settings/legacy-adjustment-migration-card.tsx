import { SlidersHorizontal, CheckCircle2 } from "lucide-react";
import { previewLegacyAdjustmentMigration } from "@/lib/actions/migrate-legacy-adjustments";
import { LegacyAdjustmentMigrationButton } from "@/components/settings/legacy-adjustment-migration-button";

/**
 * Maps `entity_type` (DB enum) to a short human label for the breakdown
 * count display. Mirrors the abbreviations used in the activity timeline
 * legend so the language is consistent across surfaces.
 */
const ENTITY_TYPE_LABELS: Record<string, string> = {
  crypto_position: "Crypto positions",
  stock_position: "Stock positions",
  cash_account: "Cash accounts",
  bank_account: "Bank accounts",
  exchange_deposit: "Exchange deposits",
  broker_deposit: "Broker deposits",
};

/**
 * Server component that surfaces the one-time legacy adjustment migration.
 *
 * Fetches the current candidate count via `previewLegacyAdjustmentMigration()`
 * on every render — Next.js caches per-request, and the page re-renders on
 * `router.refresh()` after a successful migration, so the displayed count
 * stays in sync with the DB state.
 *
 * Rendering branches:
 *   • count === 0  → success state ("✓ No legacy entries to migrate")
 *   • count > 0    → explanation paragraph + breakdown + migrate button
 *
 * The migrate button itself lives in a client component
 * (`LegacyAdjustmentMigrationButton`) so it can manage the confirm dialog
 * and per-row error result panel.
 */
export async function LegacyAdjustmentMigrationCard() {
  const preview = await previewLegacyAdjustmentMigration();

  return (
    <section
      aria-labelledby="legacy-adjustment-migration-heading"
      className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-center gap-2">
        <SlidersHorizontal aria-hidden="true" className="w-4 h-4 text-zinc-400 shrink-0" />
        <h3
          id="legacy-adjustment-migration-heading"
          className="text-sm font-medium text-zinc-200"
        >
          Migrate legacy adjustment flags
        </h3>
      </div>

      <p className="text-xs text-zinc-400 leading-relaxed">
        Activity entries from your initial imports are flagged as &ldquo;adjustments&rdquo; for
        historical reasons. With the new chart accuracy improvements, these should be reclassified
        as real cash flows so the S&amp;P benchmark correctly tracks your investments. This is a
        one-time migration. Each migrated entry remains reversible — toggle &ldquo;Mark as
        adjustment&rdquo; on any row in the History timeline to put it back.
      </p>

      {preview.count === 0 ? (
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-950/30 border border-emerald-900/30 rounded-md">
          <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-300">
            No legacy entries to migrate. Your data is already correct.
          </p>
        </div>
      ) : (
        <>
          <div>
            <p className="text-xs font-medium text-zinc-300 mb-2">
              {preview.count} {preview.count === 1 ? "entry" : "entries"} to migrate
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {Object.entries(preview.by_entity_type)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([entityType, count]) => (
                  <div
                    key={entityType}
                    className="flex items-center justify-between px-2.5 py-1 bg-zinc-800/50 rounded-md"
                  >
                    <span className="text-xs text-zinc-400">
                      {ENTITY_TYPE_LABELS[entityType] ?? entityType}
                    </span>
                    <span className="text-xs font-medium text-zinc-200">{count}</span>
                  </div>
                ))}
            </div>
          </div>
          <LegacyAdjustmentMigrationButton candidateCount={preview.count} />
        </>
      )}
    </section>
  );
}
