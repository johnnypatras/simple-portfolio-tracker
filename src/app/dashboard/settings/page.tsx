import { getProfile } from "@/lib/actions/profile";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { LegacyAdjustmentMigrationCard } from "@/components/settings/legacy-adjustment-migration-card";
import { MobileMenuButton } from "@/components/sidebar";

/**
 * Raise the function timeout for this route. Per Next.js docs, a page-level
 * `maxDuration` sets the default timeout for ALL Server Actions invoked from
 * the page — here, the legacy-adjustment migration, whose per-row external
 * price/FX work can run long. The action also enforces its own wall-clock
 * budget (MIGRATION_TIME_BUDGET_MS) below this for platform-independent safety.
 */
export const maxDuration = 60;

export default async function SettingsPage() {
  const profile = await getProfile();

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Settings</h1>
        </div>
        <p className="text-sm text-zinc-400 mt-1">
          Manage your preferences and account
        </p>
      </div>
      <SettingsTabs profile={profile} />

      {/* ── Advanced: one-time legacy adjustment migration ────── */}
      <div className="mt-10 pt-6 border-t border-zinc-800">
        <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
          Advanced
        </h2>
        <LegacyAdjustmentMigrationCard />
      </div>
    </div>
  );
}
