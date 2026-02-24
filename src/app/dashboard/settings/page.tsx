import { getProfile } from "@/lib/actions/profile";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { MobileMenuButton } from "@/components/sidebar";

export default async function SettingsPage() {
  const profile = await getProfile();

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Settings</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your preferences and account
        </p>
      </div>
      <SettingsTabs profile={profile} />
    </div>
  );
}
