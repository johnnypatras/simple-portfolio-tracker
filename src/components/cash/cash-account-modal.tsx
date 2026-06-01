"use client";

import { useState, useEffect, useId } from "react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import {
  createCashAccount,
  updateCashAccount,
} from "@/lib/actions/cash-accounts";
import { findOrCreateInstitution } from "@/lib/actions/institutions";
import type { CashAccount, CashAccountCreateInput, CashAccountUpdateInput, Institution } from "@/lib/types";

/** Sentinel <option> value for the "create a new bank" choice in the bank picker. */
const NEW_BANK = "__new_bank__";

interface CashAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  cashAccount?: CashAccount | null;
  institutionId?: string;
  institutionName?: string;
  /** Banks to choose from when adding/fixing a bank account that has no parent institution. */
  institutions?: Institution[];
  walletId?: string;
  walletName?: string;
  brokerId?: string;
  brokerName?: string;
}

export function CashAccountModal({
  isOpen,
  onClose,
  cashAccount,
  institutionId,
  institutionName,
  institutions = [],
  walletId,
  walletName,
  brokerId,
  brokerName,
}: CashAccountModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdjustment, setIsAdjustment] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");

  const id = useId();

  // Form state
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<string>("EUR");
  const [balance, setBalance] = useState("");
  const [apy, setApy] = useState("");
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const [newBankName, setNewBankName] = useState("");

  // Bank-origin accounts show the name field; deposits (wallet/broker) do not
  const isBankOrigin = !walletId && !brokerId && !cashAccount?.wallet_id && !cashAccount?.broker_id;
  const isEditing = !!cashAccount;

  // Show the bank picker only when a bank-origin account GENUINELY has no parent
  // bank: no institution from context AND (when editing) none on the row itself.
  // This covers a context-free "Add Cash" (new) and fixing an existing orphan
  // that renders as "Unknown Bank", while leaving normal accounts untouched —
  // even if the modal is opened without the (redundant) institutionId prop.
  const showInstitutionPicker =
    isBankOrigin && !institutionId && !cashAccount?.institution_id;

  // Derive modal title from context
  function getTitle(): string {
    if (isEditing) {
      if (cashAccount.wallet_id) return "Edit Exchange Deposit";
      if (cashAccount.broker_id) return "Edit Broker Deposit";
      return "Edit Bank Account";
    }
    if (walletId) return `Add Deposit — ${walletName ?? "Exchange"}`;
    if (brokerId) return `Add Deposit — ${brokerName ?? "Broker"}`;
    return institutionName ? `Add Account — ${institutionName}` : "Add Cash Account";
  }

  // Sync form when modal opens or cashAccount changes
  useEffect(() => {
    if (isOpen && cashAccount) {
      setName(cashAccount.name ?? "");
      setCurrency(cashAccount.currency);
      setBalance(cashAccount.balance.toString());
      setApy(cashAccount.apy.toString());
      setError(null);
      setIsAdjustment(false);
      setEffectiveDate("");
      setSelectedInstitutionId("");
      setNewBankName("");
    } else if (isOpen) {
      setName("");
      setCurrency("EUR");
      setBalance("");
      setApy("");
      setError(null);
      setIsAdjustment(false);
      setEffectiveDate("");
      setSelectedInstitutionId("");
      setNewBankName("");
    }
  }, [isOpen, cashAccount]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Parse numeric inputs explicitly. Empty / non-numeric values were
      // previously coerced to 0 by `parseFloat(x) || 0`, silently resetting
      // the user's balance/APY on save when the field was accidentally
      // cleared. Block the save instead and surface a clear error.
      const parsedBalance = parseFloat(balance);
      if (!Number.isFinite(parsedBalance)) {
        throw new Error("Balance must be a valid number");
      }
      const parsedApy = parseFloat(apy);
      if (!Number.isFinite(parsedApy)) {
        throw new Error("APY must be a valid number");
      }

      // Resolve the parent bank when the picker is shown (standalone "Add Cash"
      // or fixing an orphan). "+ New bank" reuses findOrCreateInstitution, which
      // also grants the bank role implicitly once the cash account links to it.
      let resolvedInstitutionId = institutionId;
      if (showInstitutionPicker) {
        if (selectedInstitutionId === NEW_BANK) {
          const trimmed = newBankName.trim();
          if (!trimmed) throw new Error("Enter a name for the new bank");
          resolvedInstitutionId = await findOrCreateInstitution(trimmed);
        } else if (selectedInstitutionId) {
          resolvedInstitutionId = selectedInstitutionId;
        } else {
          throw new Error("Select a bank for this account");
        }
      }

      if (isEditing) {
        const input: CashAccountUpdateInput = {
          currency,
          balance: parsedBalance,
          apy: parsedApy,
          name: isBankOrigin ? name : undefined,
          // Only set institution when the picker resolved one (fixing an orphan).
          // A normal edit omits it so partialUpdate leaves the existing bank intact.
          ...(showInstitutionPicker ? { institution_id: resolvedInstitutionId } : {}),
        };
        await updateCashAccount(cashAccount.id, input, {
          isAdjustment,
          ...(effectiveDate ? { effectiveDate } : {}),
        });
      } else {
        const input: CashAccountCreateInput = {
          institution_id: resolvedInstitutionId,
          currency,
          balance: parsedBalance,
          apy: parsedApy,
          name: isBankOrigin ? name : undefined,
          wallet_id: walletId ?? null,
          broker_id: brokerId ?? null,
        };
        await createCashAccount(input, {
          isAdjustment,
          ...(effectiveDate ? { effectiveDate } : {}),
        });
      }
      onClose();
      const adjLabel = isAdjustment ? " (adjustment)" : "";
      const verb = isEditing ? "updated" : "added";
      const noun = isBankOrigin ? "Bank account" : "Deposit";
      toast.success(`${noun} ${verb}${adjLabel}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} title={getTitle()}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Transfer / Adjustment badge (edit mode only) */}
        {cashAccount?.last_was_transfer && (
          <div className="flex items-center gap-1.5 -mt-2 mb-1">
            <span className="text-[10px] text-teal-400 font-medium" title="Last change was a sell/buy/move transfer">Xfer</span>
            <span className="text-[10px] text-zinc-400">Last changed via transfer</span>
          </div>
        )}
        {!cashAccount?.last_was_transfer && cashAccount?.last_was_adjustment && (
          <div className="flex items-center gap-1.5 -mt-2 mb-1">
            <span className="text-[10px] text-amber-400 font-medium" title="Not a real transaction — portfolio balance correction">Adj.</span>
            <span className="text-[10px] text-zinc-400">Last saved as portfolio adjustment</span>
          </div>
        )}

        {/* Bank picker — shown when a bank-origin account has no parent bank:
            a context-free "Add Cash", or fixing an existing "Unknown Bank" orphan */}
        {showInstitutionPicker && (
          <div>
            <label htmlFor={`${id}-bank`} className="block text-xs text-zinc-400 mb-1">
              Bank
            </label>
            <select
              id={`${id}-bank`}
              value={selectedInstitutionId}
              onChange={(e) => setSelectedInstitutionId(e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            >
              <option value="">Select bank…</option>
              {institutions.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name}
                </option>
              ))}
              <option value={NEW_BANK}>+ New bank…</option>
            </select>
            {selectedInstitutionId === NEW_BANK && (
              <input
                type="text"
                value={newBankName}
                onChange={(e) => setNewBankName(e.target.value)}
                placeholder="New bank name (e.g. Alpha Bank)"
                required
                className="w-full mt-2 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
            )}
          </div>
        )}

        {/* Name field — bank-origin only */}
        {isBankOrigin && (
          <div>
            <label htmlFor={`${id}-name`} className="block text-xs text-zinc-400 mb-1">
              Account Name
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Savings, Current"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              required
            />
          </div>
        )}

        {/* Currency + Balance */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-currency`} className="block text-xs text-zinc-400 mb-1">
              Currency
            </label>
            <select
              id={`${id}-currency`}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
            >
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-balance`} className="block text-xs text-zinc-400 mb-1">
              {isBankOrigin ? "Balance" : "Amount"}
            </label>
            <input
              id={`${id}-balance`}
              type="number"
              step="0.01"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              required
            />
          </div>
        </div>

        {/* APY */}
        <div>
          <label htmlFor={`${id}-apy`} className="block text-xs text-zinc-400 mb-1">
            APY % <span className="text-zinc-400">(optional)</span>
          </label>
          <input
            id={`${id}-apy`}
            type="number"
            step="0.01"
            value={apy}
            onChange={(e) => setApy(e.target.value)}
            placeholder="0.00"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
          />
        </div>

        {/* Effective date (optional) */}
        <div>
          <label htmlFor={`${id}-effective-date`} className="block text-xs text-zinc-400 mb-1">
            Effective date (optional)
          </label>
          <input
            id={`${id}-effective-date`}
            type="date"
            max={new Date().toISOString().split("T")[0]}
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 text-sm"
          />
          <p className="text-[10px] text-zinc-400 mt-1">Leave empty to use today&apos;s date</p>
        </div>

        {/* Error display */}
        {error && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Footer: adjustment checkbox + buttons */}
        <div className="flex items-center justify-between gap-2 pt-2">
          <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
            <input
              type="checkbox"
              checked={isAdjustment}
              onChange={(e) => setIsAdjustment(e.target.checked)}
              className="accent-amber-500"
            />
            Portfolio adjustment
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
            >
              {loading
                ? "Saving..."
                : isEditing
                  ? "Save Changes"
                  : isBankOrigin
                    ? "Add Account"
                    : "Add Deposit"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
