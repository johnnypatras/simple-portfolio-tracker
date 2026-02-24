"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, Wallet as WalletIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { createWallet, updateWallet, deleteWallet } from "@/lib/actions/wallets";
import type { Wallet, WalletInput, WalletType, PrivacyLabel, InstitutionRole } from "@/lib/types";
import { parseWalletChains, serializeChains, getWalletChainTokens, EVM_CHAINS, NON_EVM_CHAINS, isEvmChain } from "@/lib/types";

const privacyLabels: Record<PrivacyLabel, string> = {
  anon: "Anonymous",
  doxxed: "KYC / Doxxed",
};

interface WalletManagerProps {
  wallets: Wallet[];
  institutionRoles: Map<string, InstitutionRole[]>;
}

export function WalletManager({ wallets, institutionRoles }: WalletManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);
  const [alsoBroker, setAlsoBroker] = useState(false);
  const [alsoBank, setAlsoBank] = useState(false);

  function openCreate() {
    setEditing(null);
    setName("");
    setWalletType("custodial");
    setPrivacyLabel("");
    setSelectedChains([]);
    setAlsoBroker(false);
    setAlsoBank(false);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(wallet: Wallet) {
    setEditing(wallet);
    setName(wallet.name);
    setWalletType(wallet.wallet_type);
    setPrivacyLabel(wallet.privacy_label ?? "");
    setSelectedChains(parseWalletChains(wallet.chain));
    setAlsoBroker(false);
    setAlsoBank(false);
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
        await updateWallet(editing.id, input, { also_broker: alsoBroker, also_bank: alsoBank });
      } else {
        await createWallet(input, {
          also_broker: alsoBroker,
          also_bank: alsoBank,
        });
      }
      setModalOpen(false);
      toast.success(editing ? "Wallet updated" : "Wallet added");
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
      toast.success("Wallet deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function getSiblingRoles(w: Wallet): string[] {
    if (!w.institution_id) return [];
    const roles = institutionRoles.get(w.institution_id) ?? [];
    return roles.filter((r) => r !== "wallet");
  }

  const exchanges = wallets.filter((w) => w.wallet_type === "custodial");
  const selfCustody = wallets.filter((w) => w.wallet_type === "non_custodial");

  function renderWalletRow(w: Wallet) {
    const siblings = getSiblingRoles(w);
    return (
      <div
        key={w.id}
        className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg group"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200 truncate">
            {w.name}
          </p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {getWalletChainTokens(w.chain).map((token) => (
              <span key={token} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                {token.toLowerCase() === "evm" ? "EVM Compatible" : token}
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
            {siblings.length > 0 && (
              <span className="text-xs text-zinc-600">Also: {siblings.join(" · ")}</span>
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
    );
  }

  // When editing, show existing sibling roles as disabled badges
  const editingSiblings = editing ? getSiblingRoles(editing) : [];
  const canAddBroker = walletType === "custodial" && !editingSiblings.includes("broker");
  const canAddBank = walletType === "custodial" && !editingSiblings.includes("bank");

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
          Add
        </button>
      </div>

      {wallets.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <WalletIcon className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No exchanges or wallets yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add your first exchange or wallet to start tracking crypto
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Exchanges */}
          {exchanges.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
                Exchanges
              </p>
              <div className="space-y-2">
                {exchanges.map(renderWalletRow)}
              </div>
            </div>
          )}

          {/* Self-custody wallets */}
          {selfCustody.length > 0 && (
            <div>
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
                Self-custody Wallets
              </p>
              <div className="space-y-2">
                {selfCustody.map(renderWalletRow)}
              </div>
            </div>
          )}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Wallet" : "Add Wallet"}
      >
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Binance, Ledger Nano"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>

          {/* Type + Privacy — side by side */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">Type</label>
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
              <label className="block text-sm font-medium text-zinc-300 mb-1.5">Privacy</label>
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
          </div>

          {/* Chains — contained section */}
          <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-zinc-300">Chains</label>
              <span className="text-xs text-zinc-600">
                {selectedChains.length === 0
                  ? "Any chain"
                  : (() => {
                      const evmAll = EVM_CHAINS.every((c) => selectedChains.includes(c));
                      const nonEvmSelected = selectedChains.filter((c) => !isEvmChain(c));
                      const parts: string[] = [];
                      if (evmAll) parts.push("EVM");
                      else {
                        const evmCount = selectedChains.filter((c) => isEvmChain(c)).length;
                        if (evmCount > 0) parts.push(`${evmCount} EVM`);
                      }
                      parts.push(...nonEvmSelected);
                      return parts.join(", ");
                    })()}
              </span>
            </div>

            {/* EVM group toggle */}
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

            {/* Non-EVM chains */}
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

          {/* Role extension — unified for create + edit */}
          {(canAddBroker || canAddBank || editingSiblings.length > 0) && (
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-2">
              <label className="text-sm font-medium text-zinc-300">Also register as</label>

              {/* Existing sibling roles (read-only) */}
              {editingSiblings.length > 0 && (
                <div className="flex items-center gap-3">
                  {editingSiblings.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm text-zinc-500">
                      <input type="checkbox" checked disabled className="rounded border-zinc-700 bg-zinc-950 text-blue-500 opacity-50" />
                      {role === "wallet" ? "Exchange / Wallet" : role === "bank" ? "Bank" : role === "broker" ? "Broker" : role}
                    </label>
                  ))}
                </div>
              )}

              {/* Addable roles */}
              {(canAddBroker || canAddBank) && (
                <div className="flex items-center gap-4">
                  {canAddBroker && (
                    <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={alsoBroker}
                        onChange={(e) => setAlsoBroker(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                      />
                      Broker
                    </label>
                  )}
                  {canAddBank && (
                    <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={alsoBank}
                        onChange={(e) => setAlsoBank(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                      />
                      Bank
                    </label>
                  )}
                </div>
              )}

            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
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
