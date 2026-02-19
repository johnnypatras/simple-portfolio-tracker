"use client";

import { useState } from "react";
import { Plus, Pencil, Trash2, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createBroker, updateBroker, deleteBroker } from "@/lib/actions/brokers";
import type { Broker } from "@/lib/types";

export function BrokerManager({ brokers }: { brokers: Broker[] }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Broker | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  function openCreate() {
    setEditing(null);
    setName("");
    setError(null);
    setModalOpen(true);
  }

  function openEdit(broker: Broker) {
    setEditing(broker);
    setName(broker.name);
    setError(null);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (editing) {
        await updateBroker(editing.id, { name });
      } else {
        await createBroker({ name });
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
          {brokers.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border border-zinc-800/50 rounded-lg group"
            >
              <p className="text-sm font-medium text-zinc-200 truncate">
                {b.name}
              </p>
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
          ))}
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
