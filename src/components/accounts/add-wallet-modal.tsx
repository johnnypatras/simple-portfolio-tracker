"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { createStandaloneWallet } from "@/lib/actions/wallets";
import type { PrivacyLabel } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain, serializeChains } from "@/lib/types";

interface AddWalletModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddWalletModal({ open, onClose }: AddWalletModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);

  function resetForm() {
    setName("");
    setPrivacyLabel("");
    setSelectedChains([]);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const chainStr = serializeChains(selectedChains);
      await createStandaloneWallet({
        name,
        wallet_type: "non_custodial",
        privacy_label: privacyLabel || null,
        chain: chainStr,
      });

      toast.success(`Wallet "${name}" created`);
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
    <Modal open={open} onClose={handleClose} title="Add Self-Custody Wallet">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Wallet Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. MetaMask, Ledger, Phantom"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          />
        </div>

        {/* Privacy */}
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Privacy
          </label>
          <select
            value={privacyLabel}
            onChange={(e) => setPrivacyLabel(e.target.value as PrivacyLabel | "")}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">Not set</option>
            <option value="anon">Anonymous</option>
            <option value="doxxed">KYC / Doxxed</option>
          </select>
        </div>

        {/* Chains */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-zinc-300">Chains</label>
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
            {loading ? "Creating..." : "Create Wallet"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
