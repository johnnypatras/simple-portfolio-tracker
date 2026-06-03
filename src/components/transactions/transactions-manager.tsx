"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AssetRef } from "@/lib/types";
import {
  loadAssetTransactions,
  addTransaction,
  editTransaction,
  type AssetTransactionDisplayRow,
} from "@/lib/actions/transactions";
import { TransactionsDrawer } from "@/components/transactions/transactions-drawer";
import {
  TransactionModal,
  kindToModalType,
  type TransactionSubmit,
  type TransactionEditState,
} from "@/components/transactions/transaction-modal";

/**
 * The asset a table opened the transactions UI for. `assetRef` drives the
 * read/write actions; `name` titles the drawer/modal; `assetClass` shapes the
 * modal; `walletOptions`/`brokerOptions` seed the add-mode destination select
 * (crypto/stock respectively — cash passes neither).
 */
export interface OpenTransactionsTarget {
  assetRef: AssetRef;
  name: string;
  assetClass: "crypto" | "stock" | "cash";
  walletOptions?: { id: string; name: string }[];
  brokerOptions?: { id: string; name: string }[];
}

interface TransactionsManagerProps {
  /** The open asset, or null when nothing is open. */
  target: OpenTransactionsTarget | null;
  /** Close everything (drawer + modal). */
  onClose: () => void;
  /** Display currency the table is showing — amounts render in this currency. */
  currency: "EUR" | "USD";
  /**
   * Route a transfer out. The tables wire this to their existing Transfer
   * dialog; when absent the modal still surfaces a non-dead-end message.
   */
  onContinueToTransfer?: () => void;
  /** Refresh the underlying table after a successful write (qty/balance moved). */
  onMutated?: () => void;
}

/** Modal state: closed (null), add (no row), or edit (a seeded row + its id). */
type ModalState =
  | null
  | { mode: "add" }
  | { mode: "edit"; rowId: string; edit: TransactionEditState };

/**
 * The shared "Transactions" surface (history drawer + add/edit modal) wired to
 * the cost-basis server actions. Rendered once per holdings table; the table
 * owns only the `target` state (set on the History-icon click) and the close +
 * refresh callbacks. All fetch/add/edit/transfer-route-out logic lives here so
 * the three tables stay thin and identical.
 */
export function TransactionsManager({
  target,
  onClose,
  currency,
  onContinueToTransfer,
  onMutated,
}: TransactionsManagerProps) {
  const [modal, setModal] = useState<ModalState>(null);

  // Keep onClose out of effect deps via a ref — updated synchronously before
  // any effect so the effect always calls the latest version without re-firing
  // on each new identity. useLayoutEffect runs synchronously after DOM mutations
  // but before the browser paints, keeping the ref up-to-date for async effects.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Counter bump → triggers a re-fetch without changing target/currency.
  const [reloadCounter, setReloadCounter] = useState(0);
  /** Post-mutation refresh: bump the counter; the effect below re-fetches the same target. */
  const refetch = useCallback(() => setReloadCounter((c) => c + 1), []);

  /**
   * `loadedRows`: null while the first fetch for the current target is in
   * flight (→ spinner shown); an array once loaded (possibly empty).
   * `rowsTarget`/`rowsCurrency`/`rowsReload`: the (target, currency, counter)
   * triple for which `loadedRows` is valid — used in a render-time derived-state
   * reset (the React "adjust state from prev render" pattern) so that switching
   * to a new asset resets rows to null without a useEffect setState.
   *
   * All useState updates from the fetch are in async .then/.catch callbacks —
   * never synchronously in the effect body — satisfying react-hooks/set-state-in-effect.
   */
  const [loadedRows, setLoadedRows] = useState<AssetTransactionDisplayRow[] | null>(null);
  const [rowsTarget, setRowsTarget] = useState<OpenTransactionsTarget | null>(null);
  const [rowsCurrency, setRowsCurrency] = useState(currency);
  const [rowsReload, setRowsReload] = useState(0);

  // Derived-state reset (inline during render — React's recommended pattern for
  // state that depends on a prop change, see react.dev/learn/you-might-not-need-an-effect
  // #adjusting-some-state-when-a-prop-changes). Resets rows to null when the
  // fetch key changes so the loading spinner shows immediately on asset/currency switch.
  if (target !== rowsTarget || currency !== rowsCurrency || reloadCounter !== rowsReload) {
    setRowsTarget(target);
    setRowsCurrency(currency);
    setRowsReload(reloadCounter);
    setLoadedRows(null);
  }

  // Ref tracks which generation is currently expected; incremented before the
  // fetch starts (a ref write, not a setState call, so no lint violation).
  const expectedGenRef = useRef(0);

  // Load whenever the open asset, currency, or reload counter changes.
  // The effect ONLY writes to a ref synchronously; all setState happens async.
  useEffect(() => {
    if (!target) return; // null target means closed — nothing to fetch
    const gen = ++expectedGenRef.current;
    loadAssetTransactions(target.assetRef, currency)
      .then((next) => {
        if (expectedGenRef.current === gen) setLoadedRows(next);
      })
      .catch((err: unknown) => {
        if (expectedGenRef.current !== gen) return;
        toast.error(err instanceof Error ? err.message : "Failed to load transactions");
        onCloseRef.current();
      });
  }, [target, currency, reloadCounter]);

  const rows = loadedRows ?? [];
  const loading = target !== null && loadedRows === null;

  const assetRef = target?.assetRef ?? null;

  // ── Add flow ────────────────────────────────────────────────────────────
  const handleSubmitAdd = useCallback(
    async (submit: TransactionSubmit) => {
      if (!assetRef) return;
      // Transfer routes out at the UI — it never reaches addTransaction. Narrow
      // the type with a real guard (no `as` cast) before the call.
      if (submit.type === "transfer") {
        onContinueToTransfer?.();
        return;
      }
      try {
        await addTransaction(assetRef, {
          type: submit.type,
          quantity: submit.quantity,
          cost: submit.cashflowOverride
            ? {
                amount: submit.cashflowOverride.amount,
                currency: submit.cashflowOverride.currency,
              }
            : undefined,
          effectiveDate: submit.date || undefined,
          walletId: submit.walletId,
          brokerId: submit.brokerId,
        });
        toast.success("Transaction added");
        setModal(null);
        onMutated?.();
        refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add transaction");
      }
    },
    [assetRef, onContinueToTransfer, onMutated, refetch],
  );

  // ── Edit flow ───────────────────────────────────────────────────────────
  const handleEdit = useCallback(
    (rowId: string) => {
      const row = (loadedRows ?? []).find((r) => r.id === rowId);
      if (!row || !target) return;
      const isCash = target.assetClass === "cash";
      setModal({
        mode: "edit",
        rowId,
        edit: {
          type: kindToModalType(row.kind, row.quantity, isCash),
          quantity: Math.abs(row.quantity),
          amount: row.amount ?? undefined,
          amountCurrency: row.currency,
          date: row.date.slice(0, 10),
          isTransferLeg: row.isTransferLeg,
          isSplitChild: row.isSplitChild,
        },
      });
    },
    [loadedRows, target],
  );

  const handleSubmitEdit = useCallback(
    async (rowId: string, submit: TransactionSubmit) => {
      try {
        const result = await editTransaction(rowId, {
          cost: submit.cashflowOverride
            ? {
                amount: submit.cashflowOverride.amount,
                currency: submit.cashflowOverride.currency,
              }
            : undefined,
          effectiveDate: submit.date || undefined,
        });
        if (result.success) {
          toast.success("Transaction updated");
          setModal(null);
          onMutated?.();
          refetch();
        } else {
          toast.error(result.message ?? "Failed to update transaction");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update transaction");
      }
    },
    [onMutated, refetch],
  );

  if (!target) return null;

  const editState = modal?.mode === "edit" ? modal.edit : null;

  return (
    <>
      <TransactionsDrawer
        isOpen={modal === null}
        onClose={onClose}
        assetName={target.name}
        assetClass={target.assetClass}
        rows={rows}
        loading={loading}
        onEdit={handleEdit}
        onAdd={() => setModal({ mode: "add" })}
        onAddFirst={() => setModal({ mode: "add" })}
      />

      <TransactionModal
        isOpen={modal !== null}
        onClose={() => setModal(null)}
        assetClass={target.assetClass}
        assetName={target.name}
        edit={editState}
        walletOptions={target.assetClass === "crypto" ? target.walletOptions : undefined}
        brokerOptions={target.assetClass === "stock" ? target.brokerOptions : undefined}
        onContinueToTransfer={onContinueToTransfer}
        onSubmit={(submit) =>
          modal?.mode === "edit"
            ? handleSubmitEdit(modal.rowId, submit)
            : handleSubmitAdd(submit)
        }
      />
    </>
  );
}
