"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createBroker, updateBroker, deleteBroker } from "@/lib/actions/brokers";
import type { Broker, WalletType, PrivacyLabel, InstitutionRole } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain, serializeChains } from "@/lib/types";

interface BrokerManagerProps {
  brokers: Broker[];
  institutionRoles: Map<string, InstitutionRole[]>;
}

export function BrokerManager({ brokers, institutionRoles }: BrokerManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Broker | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  // Role checkbox state
  const [alsoWallet, setAlsoWallet] = useState(false);
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [walletPrivacy, setWalletPrivacy] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);
  const [alsoBank, setAlsoBank] = useState(false);

  function openCreate() {
    setEditing(null);
    setName("");
    setAlsoWallet(false);
    setWalletType("custodial");
    setWalletPrivacy("");
    setSelectedChains([]);
    setAlsoBank(false);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(broker: Broker) {
    setEditing(broker);
    setName(broker.name);
    setAlsoWallet(false);
    setWalletType("custodial");
    setWalletPrivacy("");
    setSelectedChains([]);
    setAlsoBank(false);
    setError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const walletOpts = {
      also_wallet: alsoWallet,
      wallet_type: walletType,
      wallet_privacy: walletPrivacy || null,
      wallet_chain: serializeChains(selectedChains),
    };

    try {
      if (editing) {
        await updateBroker(editing.id, { name }, { ...walletOpts, also_bank: alsoBank });
      } else {
        await createBroker({ name }, { ...walletOpts, also_bank: alsoBank });
      }
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this broker? Any stock positions linked to it will also be removed.")) return;
    try {
      await deleteBroker(id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  function getSiblingRoles(b: Broker): string[] {
    if (!b.institution_id) return [];
    const roles = institutionRoles.get(b.institution_id) ?? [];
    return roles.filter((r) => r !== "broker");
  }

  const editingSiblings = editing ? getSiblingRoles(editing) : [];
  const canAddWallet = !editingSiblings.includes("wallet");
  const canAddBank = !editingSiblings.includes("bank");

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          Stock and ETF brokerage accounts
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Broker
        </button>
      </div>

      {brokers.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <TrendingUp className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No brokers yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add a brokerage account to start tracking stocks and ETFs
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {brokers.map((b) => {
            const siblings = getSiblingRoles(b);
            return (
              <div
                key={b.id}
                className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg group"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-200 truncate">
                    {b.name}
                  </p>
                  {siblings.length > 0 && (
                    <span className="text-xs text-zinc-600">Also: {siblings.join(" · ")}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEdit(b)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(b.id)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Broker" : "Add Broker"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Interactive Brokers, Trade Republic"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>

          {/* Role extension — unified for create + edit */}
          {(canAddWallet || canAddBank || editingSiblings.length > 0) && (
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
              <label className="text-sm font-medium text-zinc-300">Also register as</label>

              {/* Existing sibling roles (read-only) */}
              {editingSiblings.length > 0 && (
                <div className="flex items-center gap-3">
                  {editingSiblings.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm text-zinc-500">
                      <input type="checkbox" checked disabled className="rounded border-zinc-700 bg-zinc-950 text-blue-500 opacity-50" />
                      {role === "wallet" ? "Exchange / Wallet" : role === "bank" ? "Bank" : role}
                    </label>
                  ))}
                </div>
              )}

              {/* Addable roles */}
              <div className="flex items-center gap-4">
                {canAddWallet && (
                  <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alsoWallet}
                      onChange={(e) => setAlsoWallet(e.target.checked)}
                      className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                    />
                    Exchange / Wallet
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

              {/* Inline wallet fields when checked */}
              {alsoWallet && canAddWallet && (
                <div className="space-y-3 pt-1 border-t border-zinc-800/30">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Wallet Type</label>
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
                        value={walletPrivacy}
                        onChange={(e) => setWalletPrivacy(e.target.value as PrivacyLabel | "")}
                        className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      >
                        <option value="">Not set</option>
                        <option value="anon">Anonymous</option>
                        <option value="doxxed">KYC / Doxxed</option>
                      </select>
                    </div>
                  </div>

                  {/* Chains */}
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1">Chains</label>
                    <div className="flex flex-wrap gap-1.5">
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
                        className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                          EVM_CHAINS.every((c) => selectedChains.includes(c))
                            ? "bg-blue-600/15 border-blue-500/30 text-blue-300"
                            : "bg-zinc-950/50 border-zinc-800 text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        EVM
                      </button>
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
                                : "bg-zinc-950/50 border-zinc-800 text-zinc-500 hover:text-zinc-300"
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

            </div>
          )}

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
              {loading ? "Saving..." : editing ? "Save Changes" : "Add Broker"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
