"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clearAllData, deleteAccount } from "@/lib/actions/profile";
import { AlertTriangle, Trash2, DatabaseZap } from "lucide-react";
import type { Profile } from "@/types/database";

export function AccountSettings({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClearData() {
    const confirmed = window.prompt(
      'This will permanently delete ALL your portfolio data (crypto, stocks, cash, trades, diary, history). Your account will remain intact.\n\nType "CLEAR" to confirm:'
    );
    if (confirmed !== "CLEAR") return;

    setError(null);
    setClearing(true);
    try {
      await clearAllData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear data");
    } finally {
      setClearing(false);
    }
  }

  async function handleDeleteAccount() {
    const confirmed = window.prompt(
      'This will permanently delete your account and ALL associated data. This action CANNOT be undone.\n\nType "DELETE" to confirm:'
    );
    if (confirmed !== "DELETE") return;

    setError(null);
    setDeleting(true);
    try {
      await deleteAccount();
      router.push("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Account information and session management
      </p>

      {/* Account info */}
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-4 max-w-md space-y-3">
        <div>
          <p className="text-xs text-zinc-500">Email</p>
          <p className="text-sm text-zinc-200">{profile.email}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">Member since</p>
          <p className="text-sm text-zinc-200">
            {new Date(profile.created_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg max-w-md">
          {error}
        </p>
      )}

      {/* Danger zone */}
      <div className="border border-red-500/20 rounded-lg p-4 max-w-md">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
        </div>
        <div className="space-y-4">
          {/* Clear all data */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-300">Clear all data</p>
              <p className="text-xs text-zinc-500">
                Remove all portfolio data, keep your account
              </p>
            </div>
            <button
              onClick={handleClearData}
              disabled={clearing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/50 rounded-lg transition-colors disabled:opacity-50"
            >
              <DatabaseZap className="w-3.5 h-3.5" />
              {clearing ? "Clearing..." : "Clear Data"}
            </button>
          </div>

          <div className="border-t border-zinc-800/50" />

          {/* Delete account */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-300">Delete account</p>
              <p className="text-xs text-zinc-500">
                Permanently remove your account and all data
              </p>
            </div>
            <button
              onClick={handleDeleteAccount}
              disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 rounded-lg transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {deleting ? "Deleting..." : "Delete Account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
