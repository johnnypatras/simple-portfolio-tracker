"use client";

import { useState, useMemo } from "react";
import { Plus, Pencil, Trash2, Landmark, ChevronDown, ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
} from "@/lib/actions/bank-accounts";
import { updateInstitutionRoles } from "@/lib/actions/institutions";
import type { BankAccount, BankAccountInput, CurrencyType, WalletType, PrivacyLabel, InstitutionRole } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain, serializeChains, COUNTRIES, countryName } from "@/lib/types";
import { DEFAULT_COUNTRY } from "@/lib/constants";

// ── Group accounts by bank_name ──────────────────────────────

interface BankSettingsGroup {
  bankName: string;
  accounts: BankAccount[];
}

function groupByBankName(banks: BankAccount[]): BankSettingsGroup[] {
  const map = new Map<string, BankAccount[]>();
  for (const b of banks) {
    const existing = map.get(b.bank_name) ?? [];
    existing.push(b);
    map.set(b.bank_name, existing);
  }
  const groups: BankSettingsGroup[] = [];
  for (const [bankName, accounts] of map) {
    groups.push({ bankName, accounts });
  }
  return groups;
}

// ── Formatter ────────────────────────────────────────────────

function formatCurrency(amount: number, cur: CurrencyType) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cur,
    minimumFractionDigits: 2,
  }).format(amount);
}

// ═══════════════════════════════════════════════════════════════
// BankManager component
// ═══════════════════════════════════════════════════════════════

interface BankManagerProps {
  banks: BankAccount[];
  institutionRoles: Map<string, InstitutionRole[]>;
}

export function BankManager({ banks, institutionRoles }: BankManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start all groups expanded so edit buttons are visible
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(groupByBankName(banks).map((g) => g.bankName))
  );

  // Form state
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [currency, setCurrency] = useState<CurrencyType>("EUR");
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");

  // Role checkbox state (shared: create dialog + institution dialog)
  const [alsoWallet, setAlsoWallet] = useState(false);
  const [walletType, setWalletType] = useState<WalletType>("custodial");
  const [walletPrivacy, setWalletPrivacy] = useState<PrivacyLabel | "">("");
  const [selectedChains, setSelectedChains] = useState<string[]>([]);
  const [alsoBroker, setAlsoBroker] = useState(false);

  // Institution-level edit dialog state
  const [instModalOpen, setInstModalOpen] = useState(false);
  const [editingInstitutionId, setEditingInstitutionId] = useState<string | null>(null);
  const [instName, setInstName] = useState("");
  const [instCountry, setInstCountry] = useState(DEFAULT_COUNTRY);

  const groups = useMemo(() => groupByBankName(banks), [banks]);
  const existingBankNames = useMemo(
    () => [...new Set(banks.map((b) => b.bank_name))],
    [banks]
  );

  function toggleGroup(bankName: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(bankName)) next.delete(bankName);
      else next.add(bankName);
      return next;
    });
  }

  // For group-level sibling display, use first account's institution_id
  function getGroupSiblingRoles(group: BankSettingsGroup): string[] {
    const first = group.accounts[0];
    if (!first?.institution_id) return [];
    const roles = institutionRoles.get(first.institution_id) ?? [];
    return roles.filter((r) => r !== "bank");
  }

  function openCreate() {
    setEditing(null);
    setName("");
    setBankName("");
    setCurrency("EUR");
    setBalance("");
    setApy("");
    setInstCountry(DEFAULT_COUNTRY);
    setAlsoWallet(false);
    setWalletType("custodial");
    setWalletPrivacy("");
    setSelectedChains([]);
    setAlsoBroker(false);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(bank: BankAccount) {
    setEditing(bank);
    setName(bank.name);
    setBankName(bank.bank_name);
    setCurrency(bank.currency);
    setBalance(bank.balance.toString());
    setApy(bank.apy.toString());
    setInstCountry(bank.region || DEFAULT_COUNTRY);
    setError(null);
    setModalOpen(true);
  }

  function openInstitutionEdit(group: BankSettingsGroup) {
    const first = group.accounts[0];
    if (!first?.institution_id) return;
    setEditingInstitutionId(first.institution_id);
    setInstName(group.bankName);
    setInstCountry(first.region || DEFAULT_COUNTRY);
    setAlsoWallet(false);
    setWalletType("custodial");
    setWalletPrivacy("");
    setSelectedChains([]);
    setAlsoBroker(false);
    setError(null);
    setInstModalOpen(true);
  }

  function openAddAccountForGroup(groupBankName: string) {
    // Close institution dialog, open create dialog pre-filled with bank name
    setInstModalOpen(false);
    setEditing(null);
    setName("");
    setBankName(groupBankName);
    setCurrency("EUR");
    setBalance("");
    setApy("");
    setAlsoWallet(false);
    setWalletType("custodial");
    setWalletPrivacy("");
    setSelectedChains([]);
    setAlsoBroker(false);
    setError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const input: BankAccountInput = {
      name,
      bank_name: editing ? editing.bank_name : bankName,
      country: instCountry,
      currency,
      balance: parseFloat(balance) || 0,
      apy: parseFloat(apy) || 0,
    };

    try {
      if (editing) {
        // Account-level edit only — no role opts (managed at institution level)
        await updateBankAccount(editing.id, input);
      } else {
        await createBankAccount(input, {
          also_wallet: alsoWallet,
          wallet_type: walletType,
          wallet_privacy: walletPrivacy || null,
          wallet_chain: serializeChains(selectedChains),
          also_broker: alsoBroker,
        });
      }
      setModalOpen(false);
      toast.success(editing ? "Bank account updated" : "Bank account added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this bank account?")) return;
    try {
      await deleteBankAccount(id);
      toast.success("Bank account deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  // Institution-level sibling roles for the institution dialog
  const instSiblingRoles = editingInstitutionId
    ? (institutionRoles.get(editingInstitutionId) ?? []).filter((r) => r !== "bank")
    : [];
  const instCanAddWallet = !instSiblingRoles.includes("wallet");
  const instCanAddBroker = !instSiblingRoles.includes("broker");

  async function handleInstitutionSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingInstitutionId) return;
    setError(null);
    setLoading(true);

    try {
      await updateInstitutionRoles(editingInstitutionId, {
        newName: instName,
        country: instCountry,
        also_wallet: alsoWallet,
        wallet_type: walletType,
        wallet_privacy: walletPrivacy || null,
        wallet_chain: serializeChains(selectedChains),
        also_broker: alsoBroker,
      });
      setInstModalOpen(false);
      toast.success("Institution updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">
          Bank and savings accounts for cash tracking
        </p>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Account
        </button>
      </div>

      {banks.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-8 text-center">
          <Landmark className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No bank accounts yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Add a bank or savings account to track your cash holdings
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => {
            const isExpanded = expandedGroups.has(group.bankName);
            const currencies = [...new Set(group.accounts.map((a) => a.currency))];
            const currencyLabel = currencies.length === 1 ? currencies[0] : currencies.join(", ");
            const groupSiblings = getGroupSiblingRoles(group);

            return (
              <div
                key={group.bankName}
                className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-3">
                  <button
                    onClick={() => toggleGroup(group.bankName)}
                    className="flex items-center gap-2 min-w-0 flex-1"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-zinc-200 truncate">
                      {group.bankName}
                    </span>
                    <span className="text-xs text-zinc-600">
                      {group.accounts.length} account{group.accounts.length !== 1 ? "s" : ""} · {currencyLabel} · {countryName(group.accounts[0]?.region ?? "")}
                    </span>
                    {groupSiblings.length > 0 && (
                      <span className="text-xs text-zinc-600">Also: {groupSiblings.join(" · ")}</span>
                    )}
                  </button>
                  <button
                    onClick={() => openInstitutionEdit(group)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors shrink-0"
                    title="Edit bank settings"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-zinc-800/30 px-4 pb-3 space-y-1 pt-2">
                    {group.accounts.map((b) => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between py-2 px-2 rounded-lg group/item hover:bg-zinc-800/20"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-zinc-300">
                              {b.name}
                            </span>
                            <span className="text-xs text-zinc-600">{b.currency}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs text-zinc-400">
                              {formatCurrency(b.balance, b.currency)}
                            </span>
                            {b.apy > 0 && (
                              <span className="text-xs text-emerald-400">
                                {b.apy}% APY
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
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
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Account-level modal (create / edit) ── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit Bank Account" : "Add Bank Account"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Account label + bank name (bank name only shown for create) */}
          {editing ? (
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Account Label
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Savings EUR"
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                required
              />
              <p className="text-xs text-zinc-600 mt-1">
                Bank: {editing.bank_name}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">
                  Account Label
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Savings EUR"
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1.5">
                  Bank Name
                </label>
                <input
                  type="text"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="e.g. Revolut, ING"
                  list="settings-bank-name-suggestions"
                  autoComplete="off"
                  className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  required
                />
                {existingBankNames.length > 0 && (
                  <datalist id="settings-bank-name-suggestions">
                    {existingBankNames.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                )}
                <p className="text-xs text-zinc-600 mt-1">
                  Use the same name to group accounts under one bank
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as CurrencyType)}
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Country
              </label>
              <select
                value={instCountry}
                onChange={(e) => setInstCountry(e.target.value)}
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Balance
              </label>
              <input
                type="number"
                step="0.01"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                APY %
              </label>
              <input
                type="number"
                step="0.01"
                value={apy}
                onChange={(e) => setApy(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            </div>
          </div>

          {/* Role extension — only for CREATE (not edit, which uses institution dialog) */}
          {!editing && (
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
              <label className="text-sm font-medium text-zinc-300">Also register as</label>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alsoWallet}
                    onChange={(e) => setAlsoWallet(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                  />
                  Exchange / Wallet
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alsoBroker}
                    onChange={(e) => setAlsoBroker(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-950 text-blue-500 focus:ring-blue-500/40"
                  />
                  Broker
                </label>
              </div>

              {/* Inline wallet fields when checked */}
              {alsoWallet && (
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
              {loading
                ? "Saving..."
                : editing
                  ? "Save Changes"
                  : "Add Account"}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Institution-level modal (name, roles, add account) ── */}
      <Modal
        open={instModalOpen}
        onClose={() => setInstModalOpen(false)}
        title={`Edit Bank — ${instName}`}
      >
        <form onSubmit={handleInstitutionSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Bank Name
            </label>
            <input
              type="text"
              value={instName}
              onChange={(e) => setInstName(e.target.value)}
              placeholder="e.g. Revolut"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
            <p className="text-xs text-zinc-600 mt-1">
              Renaming updates all linked accounts, wallets, and brokers
            </p>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-1.5">
              Country
            </label>
            <select
              value={instCountry}
              onChange={(e) => setInstCountry(e.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Role management */}
          {(instCanAddWallet || instCanAddBroker || instSiblingRoles.length > 0) && (
            <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
              <label className="text-sm font-medium text-zinc-300">Also register as</label>

              {/* Existing sibling roles (read-only) */}
              {instSiblingRoles.length > 0 && (
                <div className="flex items-center gap-3">
                  {instSiblingRoles.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm text-zinc-500">
                      <input type="checkbox" checked disabled className="rounded border-zinc-700 bg-zinc-950 text-blue-500 opacity-50" />
                      {role === "wallet" ? "Exchange / Wallet" : role === "broker" ? "Broker" : role}
                    </label>
                  ))}
                </div>
              )}

              {/* Addable roles */}
              {(instCanAddWallet || instCanAddBroker) && (
                <div className="flex items-center gap-4">
                  {instCanAddWallet && (
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
                  {instCanAddBroker && (
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
                </div>
              )}

              {/* Inline wallet fields when checked */}
              {alsoWallet && instCanAddWallet && (
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

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => openAddAccountForGroup(instName)}
              className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Account
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setInstModalOpen(false)}
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
          </div>
        </form>
      </Modal>
    </div>
  );
}
