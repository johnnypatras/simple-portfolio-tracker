"use client";

import { useState, useMemo, useCallback, useEffect, useId } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2, Loader2, Check, ArrowRightLeft, TrendingDown, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { TransferDialog } from "@/components/ui/transfer-dialog";
import { toast } from "sonner";
import { upsertPosition, deletePosition, updateCryptoAsset } from "@/lib/actions/crypto";
import type { CryptoAssetWithPositions, Wallet, TransferMode, AcquisitionType } from "@/lib/types";
import { ACQUISITION_TYPES, parseWalletChains } from "@/lib/types";

interface PositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: CryptoAssetWithPositions;
  wallets: Wallet[];
  existingSubcategories: string[];
  existingChains: string[];
  prices?: Record<string, { usd: number; eur: number }>;
}

interface PositionEdit {
  quantity: string;
  acquisition: string;
  apy: string;
  network: string;
  isAdjustment: boolean;
}

export function PositionEditor({
  open,
  onClose,
  asset,
  wallets,
  existingSubcategories,
  existingChains,
  prices,
}: PositionEditorProps) {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Transfer dialog state
  const [transferMode, setTransferMode] = useState<TransferMode | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [moveSourceWalletId, setMoveSourceWalletId] = useState<string | null>(null);

  // Per-row save tracking (replaces single shared `loading`)
  const [savingId, setSavingId] = useState<string | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  // Optimistic override for last_was_adjustment (bridges gap until props refresh)
  const [adjOverrides, setAdjOverrides] = useState<Record<string, boolean>>({});

  // ─── Effective date (optional backdating) ──────────────
  const [effectiveDate, setEffectiveDate] = useState("");

  // Clear the "just saved" checkmark after 1.5s
  useEffect(() => {
    if (!justSavedId) return;
    const t = setTimeout(() => setJustSavedId(null), 1500);
    return () => clearTimeout(t);
  }, [justSavedId]);

  // ─── Asset metadata editing (chain + subcategory) ────────
  const chainOptions = useMemo(() => {
    const set = new Set(existingChains);
    if (asset.chain?.trim()) set.add(asset.chain.trim());
    return [...set].sort();
  }, [existingChains, asset.chain]);

  const [chain, setChain] = useState(asset.chain ?? "");
  const [chainOpen, setChainOpen] = useState(false);
  const [subcategory, setSubcategory] = useState(asset.subcategory ?? "");
  const [subcategoryOpen, setSubcategoryOpen] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const chainChanged = (chain.trim() || null) !== (asset.chain ?? null);
  const subcategoryChanged = (subcategory.trim() || null) !== (asset.subcategory ?? null);
  const metaChanged = chainChanged || subcategoryChanged;

  // Reset all local state when asset prop changes (user opens different asset)
  useEffect(() => {
    setChain(asset.chain ?? "");
    setSubcategory(asset.subcategory ?? "");
    // Reset position edits and adjustment state
    const map: Record<string, PositionEdit> = {};
    asset.positions.forEach((p) => {
      map[p.wallet_id] = {
        quantity: p.quantity.toString(),
        acquisition: p.acquisition_method ?? "bought",
        apy: (p.apy ?? 0).toString(),
        network: p.network ?? "",
        isAdjustment: false,
      };
    });
    setEdits(map);
    setAdjOverrides({});
    setEffectiveDate("");
  }, [asset.id, asset.chain, asset.subcategory, asset.positions]);

  async function handleMetaSave() {
    setMetaSaving(true);
    setError(null);
    try {
      await updateCryptoAsset(asset.id, {
        ...(chainChanged ? { chain: chain.trim() || null } : {}),
        ...(subcategoryChanged ? { subcategory: subcategory.trim() || null } : {}),
      });
      toast.success("Asset updated");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setMetaSaving(false);
    }
  }

  // Track edits: walletId → { quantity, acquisition, apy }
  const [edits, setEdits] = useState<Record<string, PositionEdit>>(() => {
    const map: Record<string, PositionEdit> = {};
    asset.positions.forEach((p) => {
      map[p.wallet_id] = {
        quantity: p.quantity.toString(),
        acquisition: p.acquisition_method ?? "bought",
        apy: (p.apy ?? 0).toString(),
        network: p.network ?? "",
        isAdjustment: false,
      };
    });
    return map;
  });

  // Build a lookup of original values for dirty detection
  const originals = useMemo(() => {
    const map: Record<string, PositionEdit> = {};
    asset.positions.forEach((p) => {
      map[p.wallet_id] = {
        quantity: p.quantity.toString(),
        acquisition: p.acquisition_method ?? "bought",
        apy: (p.apy ?? 0).toString(),
        network: p.network ?? "",
        isAdjustment: false,
      };
    });
    return map;
  }, [asset.positions]);

  // Dirty detection per row
  const isDirty = useCallback(
    (walletId: string) => {
      const edit = edits[walletId];
      const orig = originals[walletId];
      if (!orig) return true; // newly added row is always "dirty"
      return (
        edit.quantity !== orig.quantity ||
        edit.acquisition !== orig.acquisition ||
        edit.apy !== orig.apy ||
        edit.network !== orig.network
      );
    },
    [edits, originals]
  );

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

  function handleNetworkChange(walletId: string, value: string) {
    setEdits((prev) => ({
      ...prev,
      [walletId]: { ...prev[walletId], network: value },
    }));
  }

  // Collect existing networks for datalist suggestions
  const existingNetworks = useMemo(() => {
    const set = new Set<string>();
    for (const p of asset.positions) {
      if (p.network?.trim()) set.add(p.network.trim());
    }
    return [...set].sort();
  }, [asset.positions]);

  function handleAdjustmentChange(walletId: string, checked: boolean) {
    setEdits((prev) => ({
      ...prev,
      [walletId]: { ...prev[walletId], isAdjustment: checked },
    }));
  }

  async function handleSave(walletId: string) {
    setError(null);
    setSavingId(walletId);

    const edit = edits[walletId];
    const qty = parseFloat(edit?.quantity ?? "0");
    const method = (edit?.acquisition ?? "bought") as AcquisitionType;
    const apy = parseFloat(edit?.apy ?? "0");
    const priceData = prices?.[asset.coingecko_id];
    try {
      await upsertPosition({
        crypto_asset_id: asset.id,
        wallet_id: walletId,
        quantity: qty,
        acquisition_method: method,
        apy: apy || undefined,
        network: edit?.network?.trim() || null,
      }, {
        isAdjustment: edit.isAdjustment,
        currentPriceUsd: priceData?.usd,
        currentPriceEur: priceData?.eur,
        ...(effectiveDate ? { effectiveDate } : {}),
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[walletId];
          return next;
        });
      }
      // Optimistic badge update + reset the adj checkbox after save
      setAdjOverrides((prev) => ({ ...prev, [walletId]: edit.isAdjustment }));
      setEdits((prev) => ({
        ...prev,
        ...(prev[walletId] ? { [walletId]: { ...prev[walletId], isAdjustment: false } } : {}),
      }));
      setJustSavedId(walletId);
      toast.success(edit.isAdjustment ? "Saved as adjustment" : "Position saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(positionId: string, walletId: string) {
    setError(null);
    setSavingId(walletId);
    const priceData = prices?.[asset.coingecko_id];
    try {
      await deletePosition(positionId, {
        isAdjustment: edits[walletId]?.isAdjustment,
        currentPriceUsd: priceData?.usd,
        currentPriceEur: priceData?.eur,
      });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[walletId];
        return next;
      });
      toast.success("Position removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSavingId(null);
    }
  }

  function handleAddWallet() {
    if (!addingWallet) return;
    setEdits((prev) => ({
      ...prev,
      [addingWallet]: { quantity: "0", acquisition: "bought", apy: "0", network: "", isAdjustment: false },
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
            {/* Chain combobox */}
            <div className="relative flex-1">
              <label htmlFor={`${id}-chain`} className="block text-xs text-zinc-400 mb-1">Chain</label>
              <input
                id={`${id}-chain`}
                type="text"
                value={chain}
                onChange={(e) => {
                  setChain(e.target.value);
                  setChainOpen(true);
                }}
                onFocus={() => setChainOpen(true)}
                onBlur={() => setTimeout(() => setChainOpen(false), 150)}
                placeholder="e.g. Ethereum, BNB Chain..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
              />
              {chainOpen && chainOptions.length > 0 && (() => {
                const filtered = chainOptions.filter(
                  (c) =>
                    c.toLowerCase().includes(chain.toLowerCase()) &&
                    c.toLowerCase() !== chain.toLowerCase()
                );
                if (filtered.length === 0) return null;
                return (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl max-h-36 overflow-y-auto">
                    {filtered.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setChain(c);
                          setChainOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 transition-colors"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Type combobox */}
            <div className="relative flex-1">
              <label htmlFor={`${id}-type`} className="block text-xs text-zinc-400 mb-1">
                Type
              </label>
              <input
                id={`${id}-type`}
                type="text"
                value={subcategory}
                onChange={(e) => {
                  setSubcategory(e.target.value);
                  setSubcategoryOpen(true);
                }}
                onFocus={() => setSubcategoryOpen(true)}
                onBlur={() => setTimeout(() => setSubcategoryOpen(false), 150)}
                placeholder="e.g. L1, DeFi, Stablecoin..."
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/70"
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

        {/* Sell / Buy actions */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { setTransferMode("sell"); setTransferOpen(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50 transition-colors"
            title="Sell this asset"
          >
            <TrendingDown className="w-3 h-3" /> Sell
          </button>
          <button
            type="button"
            onClick={() => { setTransferMode("buy"); setTransferOpen(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50 transition-colors"
            title="Buy more of this asset"
          >
            <TrendingUp className="w-3 h-3" /> Buy
          </button>
        </div>

        <div className="border-t border-zinc-800/50" />

        <p className="text-xs text-zinc-400">Positions by wallet / exchange</p>

        {allWalletIds.length === 0 && (
          <p className="text-sm text-zinc-400 text-center py-4">
            No positions yet — add one below
          </p>
        )}

        {allWalletIds.map((walletId) => {
          const wallet = wallets.find((w) => w.id === walletId);
          const existingPosition = asset.positions.find(
            (p) => p.wallet_id === walletId
          );
          const edit = edits[walletId];
          const isSaving = savingId === walletId;
          const isBusy = savingId !== null;
          const dirty = isDirty(walletId);
          const justSaved = justSavedId === walletId;

          return (
            <div
              key={walletId}
              className={`space-y-1.5 rounded-lg transition-colors ${
                justSaved
                  ? "bg-emerald-500/5 border-l-2 border-emerald-500/60 pl-2"
                  : dirty
                    ? "bg-blue-500/5 border-l-2 border-blue-500/40 pl-2"
                    : "pl-2.5"
              }`}
            >
              {/* Wallet name header */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-300 truncate">
                  {wallet?.name ?? "Unknown"}
                </span>
                {/* Stable container prevents insertBefore errors from browser extensions (Safari + Dark Reader) */}
                <div className="flex items-center gap-1.5">
                  {dirty && !justSaved && (
                    <span className="text-[10px] text-blue-400/70 font-medium">
                      unsaved
                    </span>
                  )}
                  {justSaved && (
                    <span className="text-[10px] text-emerald-400/70 font-medium flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> saved
                    </span>
                  )}
                  {existingPosition?.last_was_transfer && !justSaved && (
                    <span className="text-[10px] text-teal-400 font-medium" title="Last change was a sell/buy/move transfer">
                      Xfer
                    </span>
                  )}
                  {!existingPosition?.last_was_transfer && (adjOverrides[walletId] ?? existingPosition?.last_was_adjustment) && !justSaved && (
                    <span className="text-[10px] text-amber-400 font-medium" title="Not a real transaction — portfolio balance correction">
                      Adj.
                    </span>
                  )}
                </div>
                <label className="ml-auto flex items-center gap-1 text-[10px] text-zinc-400 cursor-pointer select-none" title="Not a real transaction — portfolio balance correction">
                  <input
                    type="checkbox"
                    checked={edit?.isAdjustment ?? false}
                    onChange={(e) => handleAdjustmentChange(walletId, e.target.checked)}
                    className="w-3 h-3 accent-amber-500"
                  />
                  Adj.
                </label>
              </div>
              {/* Row 1: Quantity (full flex) + Save/Move/Delete actions */}
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="any"
                  value={edit?.quantity ?? "0"}
                  onChange={(e) =>
                    handleQuantityChange(walletId, e.target.value)
                  }
                  className="min-w-0 flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  disabled={isSaving}
                  placeholder="Quantity"
                />
                <button
                  onClick={() => handleSave(walletId)}
                  disabled={isBusy}
                  className="p-2 rounded-lg text-blue-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                  title="Save"
                  aria-label="Save"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                </button>
                {existingPosition && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMoveSourceWalletId(walletId);
                        setTransferMode("move");
                        setTransferOpen(true);
                      }}
                      disabled={isBusy}
                      className="p-1.5 rounded text-zinc-400 hover:text-blue-400 hover:bg-zinc-800/50 transition-colors disabled:opacity-50 shrink-0"
                      title="Move to another wallet"
                      aria-label="Move to another wallet"
                    >
                      <ArrowRightLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() =>
                        handleDelete(existingPosition.id, walletId)
                      }
                      disabled={isBusy}
                      className="p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors disabled:opacity-50 shrink-0"
                      title="Remove"
                      aria-label="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>
              {/* Row 2: Metadata — Acquisition + APY + Network */}
              <div className="flex items-center gap-2 mt-1.5">
                <select
                  value={edit?.acquisition ?? "bought"}
                  onChange={(e) =>
                    handleAcquisitionChange(walletId, e.target.value)
                  }
                  className="w-24 px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/70 shrink-0"
                  disabled={isSaving}
                  title="Acquisition method"
                >
                  {ACQUISITION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <div className="relative shrink-0 w-16">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={edit?.apy ?? "0"}
                    onChange={(e) => handleApyChange(walletId, e.target.value)}
                    className="w-full px-2 py-1.5 pr-5 bg-zinc-950 border border-zinc-800 rounded text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                    disabled={isSaving}
                    placeholder="APY"
                    title="APY %"
                  />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400 pointer-events-none">%</span>
                </div>
                <input
                  id={`${id}-network-${walletId}`}
                  type="text"
                  list={`${id}-networks`}
                  value={edit?.network ?? ""}
                  onChange={(e) => handleNetworkChange(walletId, e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/70"
                  disabled={isSaving}
                  placeholder="Network (e.g. Linea, Base, Arbitrum)"
                  title="L2/Network for this position"
                />
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
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/70"
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
              aria-label="Add to selected wallet"
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

        {error && (
          <p role="alert" className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {/* Network datalist suggestions */}
        <datalist id={`${id}-networks`}>
          {existingNetworks.map((n) => (
            <option key={n} value={n} />
          ))}
          {!existingNetworks.includes("Ethereum") && <option value="Ethereum" />}
          {!existingNetworks.includes("Arbitrum") && <option value="Arbitrum" />}
          {!existingNetworks.includes("Base") && <option value="Base" />}
          {!existingNetworks.includes("Linea") && <option value="Linea" />}
          {!existingNetworks.includes("Optimism") && <option value="Optimism" />}
          {!existingNetworks.includes("Polygon") && <option value="Polygon" />}
        </datalist>
      </div>

      {transferOpen && transferMode && (() => {
        const priceData = prices?.[asset.coingecko_id];

        // For sell/move, determine which wallet is the source
        const sourceWalletId = transferMode === "move" ? moveSourceWalletId : asset.positions[0]?.wallet_id;
        const sourcePosition = asset.positions.find((p) => p.wallet_id === sourceWalletId);
        const sourceWallet = wallets.find((w) => w.id === sourceWalletId);

        return (
          <TransferDialog
            open={transferOpen}
            onClose={() => { setTransferOpen(false); setMoveSourceWalletId(null); }}
            onSuccess={() => { router.refresh(); onClose(); }}
            mode={transferMode}
            initialSource={transferMode !== "buy" ? {
              type: "crypto_position",
              assetId: asset.id,
              assetName: asset.name,
              assetTicker: asset.ticker,
              locationId: sourceWalletId ?? "",
              locationName: sourceWallet?.name ?? "Unknown",
              currentQty: sourcePosition?.quantity ?? 0,
              currency: "USD",
              currentPriceUsd: priceData?.usd,
              currentPriceEur: priceData?.eur,
            } : undefined}
            initialDestination={transferMode === "buy" ? {
              type: "crypto_position",
              assetId: asset.id,
              assetName: asset.name,
              assetTicker: asset.ticker,
              locationId: asset.positions[0]?.wallet_id ?? "",
              locationName: wallets.find((w) => w.id === asset.positions[0]?.wallet_id)?.name ?? "Unknown",
              currentQty: 0,
              currency: "USD",
              currentPriceUsd: priceData?.usd,
              currentPriceEur: priceData?.eur,
            } : undefined}
          />
        );
      })()}
    </Modal>
  );
}
