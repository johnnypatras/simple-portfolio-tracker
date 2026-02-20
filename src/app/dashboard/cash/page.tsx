import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getBrokerDeposits } from "@/lib/actions/broker-deposits";
import { getWallets } from "@/lib/actions/wallets";
import { getBrokers } from "@/lib/actions/brokers";
import { getProfile } from "@/lib/actions/profile";
import { getFXRates } from "@/lib/prices/fx";
import { CashTable } from "@/components/cash/cash-table";
import { MobileMenuButton } from "@/components/sidebar";

export default async function CashPage() {
  const [bankAccounts, exchangeDeposits, brokerDeposits, wallets, brokers, profile] =
    await Promise.all([
      getBankAccounts(),
      getExchangeDeposits(),
      getBrokerDeposits(),
      getWallets(),
      getBrokers(),
      getProfile(),
    ]);

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      ...bankAccounts.map((b) => b.currency),
      ...exchangeDeposits.map((d) => d.currency),
      ...brokerDeposits.map((d) => d.currency),
    ]),
  ];

  const fxRates = await getFXRates(profile.primary_currency, allCurrencies);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <h1 className="text-2xl font-semibold text-zinc-100">Banks & Deposits</h1>
        </div>
        <p className="text-sm text-zinc-500 mt-1">
          Bank accounts and exchange / broker deposits
        </p>
      </div>
      <CashTable
        bankAccounts={bankAccounts}
        exchangeDeposits={exchangeDeposits}
        brokerDeposits={brokerDeposits}
        wallets={wallets}
        brokers={brokers}
        primaryCurrency={profile.primary_currency}
        fxRates={fxRates}
      />
    </div>
  );
}
