"use client";

import { useState, useMemo } from "react";
import { Plus, Save, Trash2, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";
import { upsertPosition, deletePosition, updateCryptoAsset } from "@/lib/actions/crypto";
import type { CryptoAssetWithPositions, Wallet } from "@/lib/types";
import { ACQUISITION_TYPES, parseWalletChains } from "@/lib/types";

interface PositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: CryptoAssetWithPositions;
  wallets: Wallet[];
  existingSubcategories: string[];
  existingChains: string[];
}

interface PositionEdit {
  quantity: string;
  acquisition: string;
  apy: string;
}

export function PositionEditor({
  open,
  onClose,
  asset,
  wallets,
  existingSubcategories,
  existingChains,
}: PositionEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Asset metadata editing (chain + subcategory) ────────
  const chainOptions = useMemo(() => {
    const set = new Set(existingChains);
    if (asset.chain?.trim()) set.add(asset.chain.trim());
    return [...set].sort();
  }, [existingChains, asset.chain]);

  const [chain, setChain] = useState(asset.chain ?? "");
  const [subcategory, setSubcategory] = useState(asset.subcategory ?? "");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const chainChanged = (chain.trim() || null) !== (asset.chain ?? null);
  const subcategoryChanged = (subcategory.trim() || null) !== (asset.subcategory ?? null);
  const metaChanged = chainChanged || subcategoryChanged;

  async function handleMetaSave() {
    setMetaSaving(true);
    setError(null);
    try {
      await updateCryptoAsset(asset.id, {
        ...(chainChanged ? { chain: chain.trim() || null } : {}),
        ...(subcategoryChanged ? { subcategory: subcategory.trim() || null } : {}),
      });
      toast.success("Asset updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setMetaSaving(false);
    }
  }

  // Track edits: walletId → { quantity, acquisition }
  const [edits, setEdits] = useState<Record<string, PositionEdit>>(() => {
    const map: Record<string, PositionEdit> = {};
    asset.positions.forEach((p) => {
      map[p.wallet_id] = {
        quantity: p.quantity.toString(),
        acquisition: p.acquisition_method ?? "bought",
        apy: (p.apy ?? 0).toString(),
      };
    });
    return map;
  });

  // Which wallet to add a new position for
  const [addingWallet, setAddingWallet] = useState("");

  // Wallets that don't already have a position, filtered by chain compatibility
  const usedWalletIds = new Set(asset.positions.map((p) => p.wallet_id));
  const availableWallets = wallets.filter((w) => {
    if (usedWalletIds.has(w.id)) return false;
    // If asset has a chain and wallet has chains, check for overlap
    if (asset.chain && w.chain) {
      return parseWalletChains(w.chain).includes(asset.chain);
    }
    return true;
  });

  function handleQuantityChange(walletId: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [walletId]: { ...prev[walletId], quantity: value },
    }));
  }

  function handleAcquisitionChange(walletId: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [walletId]: { ...prev[walletId], acquisition: value },
    }));
  }

  function handleApyChange(walletId: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [walletId]: { ...prev[walletId], apy: value },
    }));
  }

  async function handleSave(walletId: string) {
    setError(null);
    setLoading(true);

    const edit = edits[walletId];
    const qty = parseFloat(edit?.quantity ?? "0");
    const method = edit?.acquisition ?? "bought";
    const apy = parseFloat(edit?.apy ?? "0");
    try {
      await upsertPosition({
        crypto_asset_id: asset.id,
        wallet_id: walletId,
        quantity: qty,
        acquisition_method: method,
        apy: apy || undefined,
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[walletId];
          return next;
        });
      }
      toast.success("Position saved");
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
      toast.success("Position removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setLoading(false);
    }
  }

  function handleAddWallet() {
    if (!addingWallet) return;
    setEdits((prev) => ({
      ...prev,
      [addingWallet]: { quantity: "0", acquisition: "bought", apy: "0" },
    }));
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
        {/* Chain + Type */}
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            {/* Chain */}
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1">Chain</label>
              {chainOptions.length > 0 ? (
                <select
                  value={chain}
                  onChange={(e) => setChain(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="">Select chain...</option>
                  {chainOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={chain}
                  onChange={(e) => setChain(e.target.value)}
                  placeholder="e.g. Ethereum, Solana..."
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                />
              )}
            </div>

            {/* Type combobox */}
            <div className="relative flex-1">
              <label className="block text-xs text-zinc-500 mb-1">
                Type
              </label>
              <input
                type="text"
                value={subcategory}
                onChange={(e) => {
                  setSubcategory(e.target.value);
                  setSubcategoryOpen(true);
                }}
                onFocus={() => setSubcategoryOpen(true)}
                onBlur={() => setTimeout(() => setSubcategoryOpen(false), 150)}
                placeholder="e.g. L1, DeFi, Stablecoin..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
              {subcategoryOpen && existingSubcategories.length > 0 && (() => {
                const filtered = existingSubcategories.filter(
                  (s) =>
                    s.toLowerCase().includes(subcategory.toLowerCase()) &&
                    s.toLowerCase() !== subcategory.toLowerCase()
                );
                if (filtered.length === 0) return null;
                return (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto">
                    {filtered.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSubcategory(s);
                          setSubcategoryOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Save button for metadata */}
            {metaChanged && (
              <button
                onClick={handleMetaSave}
                disabled={metaSaving}
                className="p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0 mb-px"
                title="Save changes"
              >
                {metaSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-zinc-800/50" />

        <p className="text-xs text-zinc-500">Positions by wallet / exchange</p>

        {allWalletIds.length === 0 && (
          <p className="text-sm text-zinc-500 text-center py-4">
            No positions yet — add one below
          </p>
        )}

        {allWalletIds.map((walletId) => {
          const wallet = wallets.find((w) => w.id === walletId);
          const existingPosition = asset.positions.find(
            (p) => p.wallet_id === walletId
          );
          const edit = edits[walletId];

          return (
            <div key={walletId} className="space-y-1.5">
              {/* Wallet name header */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-300 truncate">
                  {wallet?.name ?? "Unknown"}
                </span>
              </div>
              {/* Quantity + Acquisition + APY + Actions */}
              <div className="flex items-center gap-1.5 sm:gap-2">
                <input
                  type="number"
                  step="any"
                  value={edit?.quantity ?? "0"}
                  onChange={(e) =>
                    handleQuantityChange(walletId, e.target.value)
                  }
                  className="min-w-0 flex-1 px-2 sm:px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  disabled={loading}
                  placeholder="Quantity"
                />
                <select
                  value={edit?.acquisition ?? "bought"}
                  onChange={(e) =>
                    handleAcquisitionChange(walletId, e.target.value)
                  }
                  className="w-24 sm:w-28 px-2 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40 shrink-0"
                  disabled={loading}
                >
                  {ACQUISITION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <div className="relative shrink-0 w-16 sm:w-20">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={edit?.apy ?? "0"}
                    onChange={(e) => handleApyChange(walletId, e.target.value)}
                    className="w-full px-2 py-2 pr-6 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    disabled={loading}
                    placeholder="APY"
                    title="APY %"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-zinc-600 pointer-events-none">%</span>
                </div>
                <button
                  onClick={() => handleSave(walletId)}
                  disabled={loading}
                  className="p-1.5 sm:p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
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
                    className="p-1.5 sm:p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
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
              <option value="">Add to wallet / exchange...</option>
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
            Add wallets or exchanges in Settings first to assign positions
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
