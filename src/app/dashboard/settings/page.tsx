import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default async function SettingsPage() {
  const [wallets, brokers, banks] = await Promise.all([
    getWallets(),
    getBrokers(),
    getBankAccounts(),
  ]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Manage your wallets, brokers, and bank accounts
        </p>
      </div>
      <SettingsTabs wallets={wallets} brokers={brokers} banks={banks} />
    </div>
  );
}
