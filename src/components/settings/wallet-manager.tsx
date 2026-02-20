"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, Wallet as WalletIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createWallet, updateWallet, deleteWallet } from "@/lib/actions/wallets";
import type { Wallet, WalletInput, WalletType, PrivacyLabel } from "@/lib/types";
import { parseWalletChains, serializeChains } from "@/lib/types";

const walletTypeLabels: Record<WalletType, string> = {
  custodial: "Exchange / Custodial",
  non_custodial: "Self-custody",
};

const privacyLabels: Record<PrivacyLabel, string> = {
  anon: "Anonymous",
  doxxed: "KYC / Doxxed",
};

const WELL_KNOWN_CHAINS = [
  "Bitcoin", "Ethereum", "Solana", "Cardano", "Polkadot", "Avalanche",
  "BNB Chain", "Polygon", "Arbitrum", "Optimism", "Base", "NEAR",
  "Cosmos", "Fantom", "Sui", "Aptos", "Tron", "Stellar",
];

export function WalletManager({ wallets }: { wallets: Wallet[] }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);

  function openCreate() {
    setEditing(null);
    setName("");
    setWalletType("custodial");
    setPrivacyLabel("");
    setSelectedChains([]);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(wallet: Wallet) {
    setEditing(wallet);
    setName(wallet.name);
    setWalletType(wallet.wallet_type);
    setPrivacyLabel(wallet.privacy_label ?? "");
    setSelectedChains(parseWalletChains(wallet.chain));
    setError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: WalletInput = {
      name,
      wallet_type: walletType,
      privacy_label: privacyLabel || null,
      chain: serializeChains(selectedChains),
    };

    try {
      if (editing) {
        await updateWallet(editing.id, input);
      } else {
        await createWallet(input);
      }
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this wallet? Any positions linked to it will also be removed.")) return;
    try {
      await deleteWallet(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          Crypto exchanges and self-custody wallets
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Wallet
        </button>
      </div>

      {wallets.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <WalletIcon className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No wallets yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add your first exchange or wallet to start tracking crypto
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {wallets.map((w) => (
            <div
              key={w.id}
              className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg group"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">
                  {w.name}
                </p>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-xs text-zinc-500">
                    {walletTypeLabels[w.wallet_type]}
                  </span>
                  {parseWalletChains(w.chain).map((c) => (
                    <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                      {c}
                    </span>
                  ))}
                  {w.privacy_label && (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        w.privacy_label === "anon"
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-amber-500/10 text-amber-400"
                      }`}
                    >
                      {privacyLabels[w.privacy_label]}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => openEdit(w)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(w.id)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Wallet" : "Add Wallet"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Binance, Ledger Nano"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Type</label>
            <select
              value={walletType}
              onChange={(e) => setWalletType(e.target.value as WalletType)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="custodial">Exchange / Custodial</option>
              <option value="non_custodial">Self-custody</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Chains <span className="text-zinc-600">(optional{walletType === "non_custodial" ? " — recommended for self-custody" : ""})</span>
            </label>
            <p className="text-xs text-zinc-600 mb-2">
              {selectedChains.length === 0 ? "No chains selected — wallet works with any chain" : `${selectedChains.length} selected`}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {WELL_KNOWN_CHAINS.map((c) => {
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
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      active
                        ? "bg-blue-600/20 border-blue-500/40 text-blue-300"
                        : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700"
                    }`}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Privacy <span className="text-zinc-600">(optional)</span>
            </label>
            <select
              value={privacyLabel}
              onChange={(e) => setPrivacyLabel(e.target.value as PrivacyLabel | "")}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">Not set</option>
              <option value="anon">Anonymous</option>
              <option value="doxxed">KYC / Doxxed</option>
            </select>
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
            >
              {loading ? "Saving..." : editing ? "Save Changes" : "Add Wallet"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
