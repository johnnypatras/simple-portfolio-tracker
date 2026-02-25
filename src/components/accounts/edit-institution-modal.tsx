"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { updateInstitutionRoles, removeInstitutionRole, deleteInstitution } from "@/lib/actions/institutions";
import { updateWallet } from "@/lib/actions/wallets";
import type { InstitutionWithRoles, Wallet, PrivacyLabel } from "@/lib/types";
import { EVM_CHAINS, NON_EVM_CHAINS, isEvmChain, parseWalletChains, serializeChains } from "@/lib/types";

interface EditInstitutionModalProps {
  open: boolean;
  onClose: () => void;
  institution: InstitutionWithRoles;
  wallets: Wallet[];
}

export function EditInstitutionModal({
  open,
  onClose,
  institution,
  wallets,
}: EditInstitutionModalProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState(institution.name);

  // Existing wallet for this institution (if any)
  const hasWallet = institution.roles.includes("wallet");
  const existingWallet = wallets.find(
    (w) => w.institution_id === institution.id && !w.deleted_at
  );

  // "Add wallet" role fields — pre-fill from existing wallet when editing
  const [addWallet, setAddWallet] = useState(false);
  const [privacyLabel, setPrivacyLabel] = useState<PrivacyLabel | "">(
    existingWallet?.privacy_label ?? ""
  );
  const [selectedChains, setSelectedChains] = useState<string[]>(
    existingWallet ? parseWalletChains(existingWallet.chain) : []
  );

  // "Add broker" role
  const hasBroker = institution.roles.includes("broker");
  const [addBroker, setAddBroker] = useState(false);

  // Phase 2: Role removal state
  const [removingRole, setRemovingRole] = useState(false);
  const [confirmRemoveRole, setConfirmRemoveRole] = useState<"wallet" | "broker" | null>(null);

  // Phase 2: Institution deletion state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingInstitution, setDeletingInstitution] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const chainStr = serializeChains(selectedChains);

      await updateInstitutionRoles(institution.id, {
        newName: name !== institution.name ? name : undefined,
        also_wallet: addWallet && !hasWallet,
        wallet_privacy: privacyLabel || null,
        wallet_chain: chainStr,
        also_broker: addBroker && !hasBroker,
      });

      // Update existing wallet settings (type, privacy, chains)
      if (hasWallet && existingWallet) {
        await updateWallet(existingWallet.id, {
          name: existingWallet.name,
          wallet_type: existingWallet.wallet_type,
          privacy_label: privacyLabel || null,
          chain: chainStr,
        });
      }

      toast.success("Institution updated");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveRole(role: "wallet" | "broker") {
    setRemovingRole(true);
    try {
      await removeInstitutionRole(institution.id, role);
      toast.success(`${role === "wallet" ? "Exchange" : "Broker"} role removed`);
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove role");
    } finally {
      setRemovingRole(false);
      setConfirmRemoveRole(null);
    }
  }

  async function handleDeleteInstitution() {
    setDeletingInstitution(true);
    try {
      await deleteInstitution(institution.id);
      toast.success(`"${institution.name}" deleted`);
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete institution");
    } finally {
      setDeletingInstitution(false);
    }
  }

  // Reset form when modal closes
  function handleClose() {
    setName(institution.name);
    setAddWallet(false);
    setAddBroker(false);
    setPrivacyLabel(existingWallet?.privacy_label ?? "");
    setSelectedChains(existingWallet ? parseWalletChains(existingWallet.chain) : []);
    setError(null);
    setConfirmRemoveRole(null);
    setShowDeleteConfirm(false);
    setDeleteConfirmText("");
    onClose();
  }

  const roleLabel = (role: string) =>
    role === "wallet" ? "Exchange" : role === "bank" ? "Bank" : "Broker";

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

          {/* Role removal confirmation banner */}
          {confirmRemoveRole && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
              <p className="text-sm text-amber-200">
                Remove <strong>{roleLabel(confirmRemoveRole)}</strong> role?
              </p>
              <p className="text-xs text-amber-200/70">
                {confirmRemoveRole === "wallet"
                  ? "This will delete the exchange wallet and all its crypto positions and deposits."
                  : "This will delete the broker and all its stock positions and deposits."}
                {" "}If no other roles remain, the institution will also be removed.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={removingRole}
                  onClick={() => handleRemoveRole(confirmRemoveRole)}
                  className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-md transition-colors"
                >
                  {removingRole ? "Removing..." : "Yes, remove"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveRole(null)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Existing roles with × buttons */}
          {!confirmRemoveRole && (
            <div className="flex flex-wrap gap-2">
              {institution.roles.map((role) => (
                <span
                  key={role}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-zinc-800 text-zinc-400 border border-zinc-700/50"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {roleLabel(role)}
                  {/* × button — only for wallet and broker (bank is removed by deleting bank accounts) */}
                  {(role === "wallet" || role === "broker") && (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveRole(role)}
                      className="ml-1 text-zinc-600 hover:text-red-400 transition-colors"
                      title={`Remove ${roleLabel(role)} role`}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {institution.roles.length === 0 && (
                <span className="text-xs text-zinc-600">No roles yet</span>
              )}
            </div>
          )}

          {/* Add new roles */}
          {(!hasWallet || !hasBroker) && !confirmRemoveRole && (
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
                    Exchange
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

        {/* Wallet config — shown when adding wallet role OR editing existing wallet */}
        {((addWallet && !hasWallet) || (hasWallet && existingWallet)) && (
          <div className="rounded-lg border border-zinc-800/50 bg-zinc-800/10 p-3 space-y-3">
            <label className="text-sm font-medium text-zinc-300">
              Exchange Settings
            </label>

            {/* Privacy */}
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

        {/* Danger zone — delete institution */}
        <div className="border-t border-zinc-800/50 pt-4 mt-2">
          {!showDeleteConfirm ? (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Delete this institution...
            </button>
          ) : (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 space-y-3">
              <p className="text-sm text-red-300 font-medium">
                Delete &ldquo;{institution.name}&rdquo;?
              </p>
              <p className="text-xs text-red-300/70">
                This will permanently remove the institution and all linked
                accounts, wallets, brokers, positions, and deposits. This
                action cannot be undone.
              </p>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Type <span className="font-mono text-red-400">{institution.name}</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={institution.name}
                  className="w-full px-3 py-2 bg-zinc-950 border border-red-500/30 rounded-lg text-sm text-zinc-100 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-red-500/40"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={deleteConfirmText !== institution.name || deletingInstitution}
                  onClick={handleDeleteInstitution}
                  className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-md transition-colors"
                >
                  {deletingInstitution ? "Deleting..." : "Delete permanently"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirmText("");
                  }}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
