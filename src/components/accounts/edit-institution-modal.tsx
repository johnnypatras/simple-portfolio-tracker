"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { updateInstitutionRoles } from "@/lib/actions/institutions";
import type { InstitutionWithRoles, WalletType, PrivacyLabel } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain } from "@/lib/types";

interface EditInstitutionModalProps {
  open: boolean;
  onClose: () => void;
  institution: InstitutionWithRoles;
}

export function EditInstitutionModal({
  open,
  onClose,
  institution,
}: EditInstitutionModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState(institution.name);

  // "Add wallet" role fields
  const hasWallet = institution.roles.includes("wallet");
  const [addWallet, setAddWallet] = useState(false);
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);

  // "Add broker" role
  const hasBroker = institution.roles.includes("broker");
  const [addBroker, setAddBroker] = useState(false);

  const hasBank = institution.roles.includes("bank");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const chainStr =
        selectedChains.length > 0
          ? (() => {
              const hasAllEvm = EVM_CHAINS.every((c) => selectedChains.includes(c));
              const nonEvmSelected = selectedChains.filter((c) => !isEvmChain(c));
              return hasAllEvm
                ? ["evm", ...nonEvmSelected].join(",")
                : selectedChains.join(",");
            })()
          : null;

      await updateInstitutionRoles(institution.id, {
        newName: name !== institution.name ? name : undefined,
        also_wallet: addWallet && !hasWallet,
        wallet_type: walletType,
        wallet_privacy: privacyLabel || null,
        wallet_chain: chainStr,
        also_broker: addBroker && !hasBroker,
      });

      toast.success("Institution updated");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // Reset form when modal opens with new institution
  function handleClose() {
    setName(institution.name);
    setAddWallet(false);
    setAddBroker(false);
    setError(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Edit Institution">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          />
          {name !== institution.name && (
            <p className="text-xs text-zinc-500 mt-1">
              Renaming will update all linked wallets, brokers, and bank accounts.
            </p>
          )}
        </div>

        {/* Current roles */}
        <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
          <label className="text-sm font-medium text-zinc-300">Roles</label>

          {/* Existing roles (read-only) */}
          <div className="flex flex-wrap gap-2">
            {institution.roles.map((role) => (
              <span
                key={role}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-400 border border-zinc-700/50"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {role === "wallet"
                  ? "Exchange / Wallet"
                  : role === "bank"
                    ? "Bank"
                    : "Broker"}
              </span>
            ))}
            {institution.roles.length === 0 && (
              <span className="text-xs text-zinc-600">No roles yet</span>
            )}
          </div>

          {/* Add new roles */}
          {(!hasWallet || !hasBroker) && (
            <div className="pt-2 border-t border-zinc-800/50">
              <p className="text-xs text-zinc-500 mb-2">Add roles</p>
              <div className="space-y-2">
                {!hasWallet && (
                  <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addWallet}
                      onChange={(e) => setAddWallet(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                    />
                    Exchange / Wallet
                  </label>
                )}
                {!hasBroker && (
                  <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={addBroker}
                      onChange={(e) => setAddBroker(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                    />
                    Broker
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Wallet config — only shown when adding wallet role */}
        {addWallet && !hasWallet && (
          <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
            <label className="text-sm font-medium text-zinc-300">
              Wallet Settings
            </label>

            {/* Type + Privacy */}
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
                <label className="block text-xs text-zinc-500 mb-1">
                  Privacy
                </label>
                <select
                  value={privacyLabel}
                  onChange={(e) =>
                    setPrivacyLabel(e.target.value as PrivacyLabel | "")
                  }
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
                  const hasAllEvm = EVM_CHAINS.every((c) =>
                    selectedChains.includes(c)
                  );
                  if (hasAllEvm) {
                    setSelectedChains((prev) =>
                      prev.filter((c) => !isEvmChain(c))
                    );
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
                          active
                            ? prev.filter((x) => x !== c)
                            : [...prev, c]
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
            disabled={loading}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
