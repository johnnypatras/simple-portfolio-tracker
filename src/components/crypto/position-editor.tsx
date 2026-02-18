"use client";

import { useState } from "react";
import { Plus, Save, Trash2, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { upsertPosition, deletePosition } from "@/lib/actions/crypto";
import type { CryptoAssetWithPositions, Wallet } from "@/lib/types";

interface PositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: CryptoAssetWithPositions;
  wallets: Wallet[];
}

export function PositionEditor({
  open,
  onClose,
  asset,
  wallets,
}: PositionEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track edits: walletId → quantity string
  const [edits, setEdits] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    asset.positions.forEach((p) => {
      map[p.wallet_id] = p.quantity.toString();
    });
    return map;
  });

  // Which wallet to add a new position for
  const [addingWallet, setAddingWallet] = useState("");

  // Wallets that don't already have a position
  const usedWalletIds = new Set(asset.positions.map((p) => p.wallet_id));
  const availableWallets = wallets.filter((w) => !usedWalletIds.has(w.id));

  function handleQuantityChange(walletId: string, value: string) {
    setEdits((prev) => ({ ...prev, [walletId]: value }));
  }

  async function handleSave(walletId: string) {
    setError(null);
    setLoading(true);

    const qty = parseFloat(edits[walletId] ?? "0");
    try {
      await upsertPosition({
        crypto_asset_id: asset.id,
        wallet_id: walletId,
        quantity: qty,
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[walletId];
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(positionId: string, walletId: string) {
    setError(null);
    setLoading(true);
    try {
      await deletePosition(positionId);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[walletId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setLoading(false);
    }
  }

  function handleAddWallet() {
    if (!addingWallet) return;
    setEdits((prev) => ({ ...prev, [addingWallet]: "0" }));
    setAddingWallet("");
  }

  // All positions: existing + newly added
  const allWalletIds = Object.keys(edits);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${asset.name} (${asset.ticker}) Positions`}
    >
      <div className="space-y-4">
        {allWalletIds.length === 0 && (
          <p className="text-sm text-zinc-500 text-center py-4">
            No positions yet — add a wallet below
          </p>
        )}

        {allWalletIds.map((walletId) => {
          const wallet = wallets.find((w) => w.id === walletId);
          const existingPosition = asset.positions.find(
            (p) => p.wallet_id === walletId
          );

          return (
            <div
              key={walletId}
              className="flex items-center gap-2"
            >
              <span className="text-sm text-zinc-300 min-w-[100px] truncate">
                {wallet?.name ?? "Unknown"}
              </span>
              <input
                type="number"
                step="any"
                value={edits[walletId] ?? "0"}
                onChange={(e) => handleQuantityChange(walletId, e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                disabled={loading}
              />
              <button
                onClick={() => handleSave(walletId)}
                disabled={loading}
                className="p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title="Save"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
              </button>
              {existingPosition && (
                <button
                  onClick={() =>
                    handleDelete(existingPosition.id, walletId)
                  }
                  disabled={loading}
                  className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}

        {/* Add to wallet */}
        {availableWallets.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/50">
            <select
              value={addingWallet}
              onChange={(e) => setAddingWallet(e.target.value)}
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">Add to wallet...</option>
              {availableWallets
                .filter((w) => !allWalletIds.includes(w.id))
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
            <button
              onClick={handleAddWallet}
              disabled={!addingWallet}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {wallets.length === 0 && (
          <p className="text-xs text-amber-400/80 bg-amber-400/10 px-3 py-2 rounded-lg">
            Add wallets in Settings first to assign positions
          </p>
        )}

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
