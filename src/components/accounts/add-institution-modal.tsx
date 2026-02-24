"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { createWallet } from "@/lib/actions/wallets";
import { createBroker } from "@/lib/actions/brokers";
import { createBankAccount } from "@/lib/actions/bank-accounts";
import type { WalletType, PrivacyLabel, CurrencyType } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain, serializeChains } from "@/lib/types";

interface AddInstitutionModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddInstitutionModal({ open, onClose }: AddInstitutionModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Core fields
  const [name, setName] = useState("");

  // Role selection
  const [wantWallet, setWantWallet] = useState(true);
  const [wantBroker, setWantBroker] = useState(false);
  const [wantBank, setWantBank] = useState(false);

  // Wallet config
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);

  // Bank config
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankCurrency, setBankCurrency] = useState<CurrencyType>("EUR");

  const hasAnyRole = wantWallet || wantBroker || wantBank;

  function resetForm() {
    setName("");
    setWantWallet(true);
    setWantBroker(false);
    setWantBank(false);
    setWalletType("custodial");
    setPrivacyLabel("");
    setSelectedChains([]);
    setBankAccountName("");
    setBankCurrency("EUR");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasAnyRole) return;
    setError(null);
    setLoading(true);

    try {
      const chainStr = serializeChains(selectedChains);

      // Use a "leader" role to create the institution (via findOrCreateInstitution)
      // and pass other roles as also_* options.
      if (wantWallet) {
        await createWallet(
          {
            name,
            wallet_type: walletType,
            privacy_label: privacyLabel || null,
            chain: chainStr,
          },
          {
            also_broker: wantBroker,
            also_bank: wantBank,
          }
        );
      } else if (wantBroker) {
        await createBroker(
          { name },
          { also_bank: wantBank }
        );
      } else if (wantBank) {
        await createBankAccount({
          name: bankAccountName || "Main Account",
          bank_name: name,
          currency: bankCurrency,
        });
      }

      toast.success(`Institution "${name}" created`);
      resetForm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add Institution">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Institution Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Revolut, Binance, Interactive Brokers"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          />
        </div>

        {/* Role selection */}
        <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
          <label className="text-sm font-medium text-zinc-300">
            Register as
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={wantWallet}
                onChange={(e) => setWantWallet(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
              />
              Exchange / Wallet
              <span className="text-xs text-zinc-600">— for crypto assets</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={wantBroker}
                onChange={(e) => setWantBroker(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
              />
              Broker
              <span className="text-xs text-zinc-600">— for stocks &amp; ETFs</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={wantBank}
                onChange={(e) => setWantBank(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
              />
              Bank
              <span className="text-xs text-zinc-600">— for cash accounts</span>
            </label>
          </div>
          {!hasAnyRole && (
            <p className="text-xs text-amber-500">Select at least one role</p>
          )}
        </div>

        {/* Wallet config */}
        {wantWallet && (
          <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
            <label className="text-sm font-medium text-zinc-300">
              Wallet Settings
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Type</label>
                <select
                  value={walletType}
                  onChange={(e) => setWalletType(e.target.value as WalletType)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="custodial">Exchange / Custodial</option>
                  <option value="non_custodial">Self-custody</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Privacy</label>
                <select
                  value={privacyLabel}
                  onChange={(e) => setPrivacyLabel(e.target.value as PrivacyLabel | "")}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">Not set</option>
                  <option value="anon">Anonymous</option>
                  <option value="doxxed">KYC / Doxxed</option>
                </select>
              </div>
            </div>

            {/* Chains */}
            <div className="space-y-2">
              <label className="text-xs text-zinc-500">Chains</label>
              <button
                type="button"
                onClick={() => {
                  const hasAllEvm = EVM_CHAINS.every((c) => selectedChains.includes(c));
                  if (hasAllEvm) {
                    setSelectedChains((prev) => prev.filter((c) => !isEvmChain(c)));
                  } else {
                    setSelectedChains((prev) => {
                      const set = new Set(prev);
                      for (const c of EVM_CHAINS) set.add(c);
                      return [...set];
                    });
                  }
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg border transition-colors ${
                  EVM_CHAINS.every((c) => selectedChains.includes(c))
                    ? "bg-blue-600/15 border-blue-500/30 text-blue-300"
                    : selectedChains.some((c) => isEvmChain(c))
                      ? "bg-blue-600/10 border-blue-500/20 text-blue-400"
                      : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-300 hover:border-zinc-700"
                }`}
              >
                <span>EVM Compatible</span>
                <span className="text-[10px] tracking-wide opacity-50 uppercase">
                  ETH, Polygon, Arb, Base...
                </span>
              </button>
              <div className="flex flex-wrap gap-1.5">
                {NON_EVM_CHAINS.map((c) => {
                  const active = selectedChains.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() =>
                        setSelectedChains((prev) =>
                          active ? prev.filter((x) => x !== c) : [...prev, c]
                        )
                      }
                      className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                        active
                          ? "bg-blue-600/15 border-blue-500/30 text-blue-300"
                          : "bg-zinc-950/50 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                      }`}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Bank config */}
        {wantBank && !wantWallet && !wantBroker && (
          <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
            <label className="text-sm font-medium text-zinc-300">
              Bank Account
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Account Name
                </label>
                <input
                  type="text"
                  value={bankAccountName}
                  onChange={(e) => setBankAccountName(e.target.value)}
                  placeholder="e.g. Savings"
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Currency
                </label>
                <select
                  value={bankCurrency}
                  onChange={(e) => setBankCurrency(e.target.value as CurrencyType)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !hasAnyRole}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            {loading ? "Creating..." : "Create Institution"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
