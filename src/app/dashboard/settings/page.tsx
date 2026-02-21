import { getProfile } from "@/lib/actions/profile";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getInstitutionsWithRoles } from "@/lib/actions/institutions";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { MobileMenuButton } from "@/components/sidebar";

export default async function SettingsPage() {
  const [profile, wallets, brokers, banks, institutions] = await Promise.all([
    getProfile(),
    getWallets(),
    getBrokers(),
    getBankAccounts(),
    getInstitutionsWithRoles(),
  ]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Settings</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your preferences, wallets, brokers, and bank accounts
        </p>
      </div>
      <SettingsTabs
        profile={profile}
        wallets={wallets}
        brokers={brokers}
        banks={banks}
        institutions={institutions}
      />
    </div>
  );
}
