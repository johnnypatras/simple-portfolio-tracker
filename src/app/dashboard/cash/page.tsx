import { getBankAccounts } from "@/lib/actions/bank-accounts";
import { getExchangeDeposits } from "@/lib/actions/exchange-deposits";
import { getWallets } from "@/lib/actions/wallets";
import { getProfile } from "@/lib/actions/profile";
import { getFXRates } from "@/lib/prices/fx";
import { CashTable } from "@/components/cash/cash-table";

export default async function CashPage() {
  const [bankAccounts, exchangeDeposits, wallets, profile] = await Promise.all([
    getBankAccounts(),
    getExchangeDeposits(),
    getWallets(),
    getProfile(),
  ]);

  // Collect all currencies that need FX conversion
  const allCurrencies = [
    ...new Set([
      ...bankAccounts.map((b) => b.currency),
      ...exchangeDeposits.map((d) => d.currency),
    ]),
  ];

  const fxRates = await getFXRates(profile.primary_currency, allCurrencies);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-100">Cash</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Bank accounts and exchange deposits
        </p>
      </div>
      <CashTable
        bankAccounts={bankAccounts}
        exchangeDeposits={exchangeDeposits}
        wallets={wallets}
        primaryCurrency={profile.primary_currency}
        fxRates={fxRates}
      />
    </div>
  );
}
