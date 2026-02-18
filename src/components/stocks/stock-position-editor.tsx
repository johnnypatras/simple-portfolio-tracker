"use client";

import { useState } from "react";
import { Plus, Save, Trash2, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { upsertStockPosition, deleteStockPosition } from "@/lib/actions/stocks";
import type { StockAssetWithPositions, Broker } from "@/lib/types";

interface StockPositionEditorProps {
  open: boolean;
  onClose: () => void;
  asset: StockAssetWithPositions;
  brokers: Broker[];
}

export function StockPositionEditor({
  open,
  onClose,
  asset,
  brokers,
}: StockPositionEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track edits: brokerId → quantity string
  const [edits, setEdits] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    asset.positions.forEach((p) => {
      map[p.broker_id] = p.quantity.toString();
    });
    return map;
  });

  // Which broker to add a new position for
  const [addingBroker, setAddingBroker] = useState("");

  // Brokers that don't already have a position
  const usedBrokerIds = new Set(asset.positions.map((p) => p.broker_id));
  const availableBrokers = brokers.filter((b) => !usedBrokerIds.has(b.id));

  function handleQuantityChange(brokerId: string, value: string) {
    setEdits((prev) => ({ ...prev, [brokerId]: value }));
  }

  async function handleSave(brokerId: string) {
    setError(null);
    setLoading(true);

    const qty = parseFloat(edits[brokerId] ?? "0");
    try {
      await upsertStockPosition({
        stock_asset_id: asset.id,
        broker_id: brokerId,
        quantity: qty,
      });
      // If zero, remove from local state
      if (qty <= 0) {
        setEdits((prev) => {
          const next = { ...prev };
          delete next[brokerId];
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(positionId: string, brokerId: string) {
    setError(null);
    setLoading(true);
    try {
      await deleteStockPosition(positionId);
      setEdits((prev) => {
        const next = { ...prev };
        delete next[brokerId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setLoading(false);
    }
  }

  function handleAddBroker() {
    if (!addingBroker) return;
    setEdits((prev) => ({ ...prev, [addingBroker]: "0" }));
    setAddingBroker("");
  }

  // All positions: existing + newly added
  const allBrokerIds = Object.keys(edits);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${asset.name} (${asset.ticker}) Positions`}
    >
      <div className="space-y-4">
        {allBrokerIds.length === 0 && (
          <p className="text-sm text-zinc-500 text-center py-4">
            No positions yet — add a broker below
          </p>
        )}

        {allBrokerIds.map((brokerId) => {
          const broker = brokers.find((b) => b.id === brokerId);
          const existingPosition = asset.positions.find(
            (p) => p.broker_id === brokerId
          );

          return (
            <div key={brokerId} className="flex items-center gap-2">
              <span className="text-sm text-zinc-300 min-w-[100px] truncate">
                {broker?.name ?? "Unknown"}
              </span>
              <input
                type="number"
                step="any"
                value={edits[brokerId] ?? "0"}
                onChange={(e) => handleQuantityChange(brokerId, e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                disabled={loading}
              />
              <button
                onClick={() => handleSave(brokerId)}
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
                    handleDelete(existingPosition.id, brokerId)
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

        {/* Add to broker */}
        {availableBrokers.length > 0 && (
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/50">
            <select
              value={addingBroker}
              onChange={(e) => setAddingBroker(e.target.value)}
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              <option value="">Add to broker...</option>
              {availableBrokers
                .filter((b) => !allBrokerIds.includes(b.id))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
            <button
              onClick={handleAddBroker}
              disabled={!addingBroker}
              className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {brokers.length === 0 && (
          <p className="text-xs text-amber-400/80 bg-amber-400/10 px-3 py-2 rounded-lg">
            Add brokers in Settings first to assign positions
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
