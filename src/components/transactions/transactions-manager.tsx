"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  AssetRef,
  TransferInput,
  TransferSide,
  AssetTransactionDisplayRow,
} from "@/lib/types";
import {
  loadAssetTransactions,
  addTransaction,
  editTransaction,
  markAsYield,
} from "@/lib/actions/transactions";
import { executeTransfer } from "@/lib/actions/transfers";
import { getCashAccounts } from "@/lib/actions/cash-accounts";
import { TransactionsDrawer } from "@/components/transactions/transactions-drawer";
import type { InitialSide } from "@/components/ui/transfer-dialog";
import {
  TransactionModal,
  kindToModalType,
  type TransactionType,
  type TransactionSubmit,
  type TransactionEditState,
  type CashAccountOption,
} from "@/components/transactions/transaction-modal";

/**
 * The asset a table opened the transactions UI for. `assetRef` drives the
 * read/write actions; `name` titles the drawer/modal; `assetClass` shapes the
 * modal; `walletOptions`/`brokerOptions` seed the add-mode destination select
 * (crypto/stock respectively — cash passes neither).
 *
 * `moveSource` is the prefilled source for a MOVE transfer (C2a move-only): the
 * Transfer option in the modal now means "relocate this asset", so the table
 * builds the source side (first position + live price) when it opens the drawer
 * and the manager hands it back via `onContinueToTransfer`.
 */
export interface OpenTransactionsTarget {
  assetRef: AssetRef;
  name: string;
  assetClass: "crypto" | "stock" | "cash";
  walletOptions?: { id: string; name: string }[];
  brokerOptions?: { id: string; name: string }[];
  moveSource?: InitialSide;
  /** When set, open straight into the add-modal pre-typed (e.g. the position
   *  editor's Sell/Buy). The drawer is skipped (modal and drawer are mutually
   *  exclusive). */
  openAdd?: TransactionType;
}

interface TransactionsManagerProps {
  /** The open asset, or null when nothing is open. */
  target: OpenTransactionsTarget | null;
  /** Close everything (drawer + modal). */
  onClose: () => void;
  /** Display currency the table is showing — amounts render in this currency. */
  currency: "EUR" | "USD";
  /**
   * Route the modal's Transfer (move) option out. The tables wire this to a
   * move-mode Transfer dialog, prefilled from `moveSource`. When absent the
   * modal still surfaces a non-dead-end message. The manager forwards the open
   * target's `moveSource` so the table can prefill without re-deriving it.
   */
  onContinueToTransfer?: (moveSource?: InitialSide) => void;
  /** Refresh the underlying table after a successful write (qty/balance moved). */
  onMutated?: () => void;
}

/** Modal state: closed (null), add (no row), or edit (a seeded row + its id). */
type ModalState =
  | null
  | { mode: "add"; initialType?: TransactionType }
  | { mode: "edit"; rowId: string; edit: TransactionEditState };

/**
 * Build the `TransferInput` for a money-flow "tracked account" Buy/Sell (C2a).
 *
 * Buy  → source = the chosen cash account, destination = the crypto/stock
 *        position (S&P-neutral; the user paid with money already inside).
 * Sell → source = the position, destination = the chosen cash account.
 *
 * The cash leg's `amount` is the modal's Amount, already locked to the account's
 * currency and required (the modal blocks Save until it's a positive number), so
 * it arrives here via `cashflowOverride.amount`. The position side's wallet/broker
 * id comes from the modal's mandatory destination select. Returns null only if a
 * required field is missing (defensive — the modal's guards make that unreachable).
 */
function buildTrackedTransferInput(
  submit: TransactionSubmit,
  assetRef: AssetRef,
): TransferInput | null {
  if (submit.moneyFlow?.route !== "tracked") return null;
  if (assetRef.class === "cash") return null; // cash never shows the question
  const accountId = submit.moneyFlow.accountId;
  const amount = submit.cashflowOverride?.amount;
  if (!accountId || amount == null || !Number.isFinite(amount) || amount <= 0) return null;

  // Position side (destination for Buy, source for Sell).
  let position: TransferSide;
  if (assetRef.class === "crypto") {
    if (!submit.walletId) return null;
    position = {
      type: "crypto_position",
      assetId: assetRef.assetId,
      walletId: submit.walletId,
      quantity: submit.quantity,
    };
  } else {
    if (!submit.brokerId) return null;
    position = {
      type: "stock_position",
      assetId: assetRef.assetId,
      brokerId: submit.brokerId,
      quantity: submit.quantity,
    };
  }

  const cash: TransferSide = { type: "cash_account", accountId, amount };
  const effectiveDate = submit.date || undefined;

  return submit.type === "buy"
    ? { mode: "buy", source: cash, destination: position, effectiveDate }
    : { mode: "sell", source: position, destination: cash, effectiveDate };
}

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
  // Derived-state: when a new target arrives carrying `openAdd`, open the modal
  // pre-typed immediately (no effect) — same render-time reset pattern as rows.
  // Tracked as a prev-target reference so only a *new* target triggers the reset.
  const [modalTarget, setModalTarget] = useState<typeof target>(null);
  if (target !== modalTarget) {
    setModalTarget(target);
    if (target?.openAdd) {
      setModal({ mode: "add", initialType: target.openAdd });
    }
  }

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

  // ── Cash accounts for the Buy/Sell money-flow question (C2a) ──────────────
  // Fetched lazily when a crypto/stock target opens (cash assets never show the
  // question). Failure → empty list, so the modal auto-falls-back to external-
  // only (graceful degradation). Async setState only (no sync set in the effect
  // body), keyed on target identity via a generation ref like the rows fetch.
  const [cashAccounts, setCashAccounts] = useState<CashAccountOption[]>([]);
  const cashGenRef = useRef(0);
  useEffect(() => {
    if (!target || target.assetClass === "cash") {
      // No fetch for cash/closed. Leave the stale list as-is — it's never read
      // for cash (the render passes `undefined` for cash) and is overwritten on
      // the next crypto/stock open, so clearing it would only add a render.
      return;
    }
    const gen = ++cashGenRef.current;
    getCashAccounts()
      .then((accounts) => {
        if (cashGenRef.current !== gen) return;
        setCashAccounts(
          accounts.map((a) => ({
            id: a.id,
            // Prefer the explicit account name; fall back to the joined location
            // (wallet/broker/institution) so the option is never blank.
            name:
              a.name ??
              a.wallet_name ??
              a.broker_name ??
              a.institution_name ??
              `${a.currency} account`,
            balance: a.balance,
            currency: a.currency,
          })),
        );
      })
      .catch(() => {
        // Degrade gracefully: external-only. Bump nothing — leave the list empty.
        if (cashGenRef.current === gen) setCashAccounts([]);
      });
  }, [target]);

  const assetRef = target?.assetRef ?? null;

  // ── Add flow ────────────────────────────────────────────────────────────
  const handleSubmitAdd = useCallback(
    async (submit: TransactionSubmit) => {
      if (!assetRef) return;
      // Transfer (move) routes out at the UI — it never reaches addTransaction.
      // Narrow the type with a real guard (no `as` cast) and hand the table the
      // move source so it can prefill the move-mode Transfer dialog.
      if (submit.type === "transfer") {
        onContinueToTransfer?.(target?.moveSource);
        return;
      }

      // ── Money-flow "tracked account" route (C2a) ──────────────────────────
      // The user answered Buy "paid with a tracked account" / Sell "proceeds
      // went to a tracked account". Instead of a plain addTransaction (which
      // would book an S&P contribution/withdrawal), build the two-legged
      // transfer (both legs is_adjustment=true → S&P-neutral) and run it through
      // the SAME machinery the Transfer dialog uses. assetRef is crypto/stock
      // here (cash never shows the question), so the position side has a wallet/
      // broker id from the modal's mandatory destination select.
      if (submit.moneyFlow?.route === "tracked") {
        const input = buildTrackedTransferInput(submit, assetRef);
        if (!input) {
          // Should be unreachable — the modal blocks Save until the amount and
          // account are present. Surface rather than fail silently.
          toast.error("Couldn't build the transfer — check the amount and account.");
          return;
        }
        try {
          const result = await executeTransfer(input);
          if (result.success) {
            toast.success(submit.type === "buy" ? "Buy recorded" : "Sell recorded");
            setModal(null);
            // Editor-delegated (openAdd) flow has no drawer to fall back to —
            // dismiss entirely, matching the modal's own close handler. Without
            // this the history drawer would pop open after a successful trade.
            // Use the ref (not onClose directly) so this callback stays identity-
            // stable — the tables pass an inline onClose, so a direct dep would
            // re-create handleSubmitAdd every render (react-hooks memoization).
            if (target?.openAdd) onCloseRef.current();
            onMutated?.();
            refetch();
          } else {
            // executeTransfer returns {success:false} instead of throwing —
            // surface the server message; keep the modal open (no silent loss).
            toast.error(result.error);
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to record transfer");
        }
        return;
      }

      // ── External route (new money in / proceeds left) — unchanged ─────────
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
        // See the tracked branch: an openAdd (editor-delegated) flow dismisses
        // entirely so the history drawer doesn't pop open after success. Via the
        // ref to keep handleSubmitAdd identity-stable (see the tracked branch).
        if (target?.openAdd) onCloseRef.current();
        onMutated?.();
        refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add transaction");
      }
    },
    [assetRef, target, onContinueToTransfer, onMutated, refetch],
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

  // ── Mark-as-yield flow ─────────────────────────────────────────────────
  const handleMarkAsYield = useCallback(
    async (ids: string[]) => {
      try {
        const result = await markAsYield(ids);
        toast.success(
          `${result.updated} marked as yield${result.skipped ? `, ${result.skipped} skipped` : ""}`,
        );
        refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to mark as yield");
      }
    },
    [refetch],
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
        onMarkAsYield={handleMarkAsYield}
      />

      <TransactionModal
        isOpen={modal !== null}
        onClose={() => {
          setModal(null);
          if (target?.openAdd) onClose();
        }}
        assetClass={target.assetClass}
        assetName={target.name}
        initialType={modal?.mode === "add" ? modal.initialType : undefined}
        edit={editState}
        walletOptions={target.assetClass === "crypto" ? target.walletOptions : undefined}
        brokerOptions={target.assetClass === "stock" ? target.brokerOptions : undefined}
        // Money-flow question (C2a) — crypto/stock only. Empty for cash (and on
        // a failed fetch), so the modal never shows the question for cash.
        cashAccountOptions={target.assetClass === "cash" ? undefined : cashAccounts}
        // Forward the move source so the table prefills the move-mode dialog.
        // The modal invokes this with no args; the manager injects moveSource.
        onContinueToTransfer={
          onContinueToTransfer
            ? () => onContinueToTransfer(target.moveSource)
            : undefined
        }
        onSubmit={(submit) =>
          modal?.mode === "edit"
            ? handleSubmitEdit(modal.rowId, submit)
            : handleSubmitAdd(submit)
        }
      />
    </>
  );
}
