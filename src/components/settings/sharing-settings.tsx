"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Link2,
  Copy,
  Check,
  Trash2,
  Globe,
  Eye,
  History,
  Share2,
} from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  createShareLink,
  revokeShare,
  getMyShares,
  type ShareLink,
  type ShareScope,
} from "@/lib/actions/shares";

// ─── Scope config ────────────────────────────────────────

const SCOPE_OPTIONS: { value: ShareScope; label: string; description: string; icon: typeof Globe }[] = [
  { value: "overview", label: "Overview Only", description: "Dashboard summary page", icon: Eye },
  { value: "full", label: "Full Portfolio", description: "All assets, accounts, and cash", icon: Globe },
  { value: "full_with_history", label: "Full + History", description: "Everything including activity log and trade diary", icon: History },
];

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "", label: "Never expires" },
];

function scopeBadge(scope: ShareScope) {
  switch (scope) {
    case "overview":
      return { label: "Overview", color: "bg-zinc-500/15 text-zinc-400" };
    case "full":
      return { label: "Full", color: "bg-blue-500/15 text-blue-400" };
    case "full_with_history":
      return { label: "Full + History", color: "bg-purple-500/15 text-purple-400" };
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getShareUrl(token: string) {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/share/${token}`;
}

function isExpired(share: ShareLink) {
  return share.expires_at && new Date(share.expires_at) < new Date();
}

// ─── Component ───────────────────────────────────────────

export function SharingSettings() {
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Form state
  const [scope, setScope] = useState<ShareScope>("full");
  const [expiresInDays, setExpiresInDays] = useState("1");
  const [label, setLabel] = useState("");

  // Copy feedback per share
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadShares = useCallback(async () => {
    try {
      const data = await getMyShares();
      setShares(data);
    } catch {
      toast.error("Failed to load shares");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadShares();
  }, [loadShares]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);

    try {
      const token = await createShareLink({
        scope,
        label: label.trim() || undefined,
        expiresInDays: expiresInDays === "1h" ? 1 / 24 : expiresInDays ? parseInt(expiresInDays, 10) : null,
      });

      // Copy link to clipboard
      const url = `${window.location.origin}/share/${token}`;
      await navigator.clipboard.writeText(url);
      toast.success("Share link created and copied to clipboard");

      // Reset form and reload
      setLabel("");
      setScope("full");
      setExpiresInDays("");
      await loadShares();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create link");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(shareId: string) {
    try {
      await revokeShare(shareId);
      toast.success("Share link revoked");
      await loadShares();
    } catch {
      toast.error("Failed to revoke link");
    }
  }

  async function handleCopy(share: ShareLink) {
    try {
      await navigator.clipboard.writeText(getShareUrl(share.token));
      setCopiedId(share.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error("Failed to copy link");
    }
  }

  const activeShares = shares.filter((s) => !s.revoked_at && !isExpired(s));
  const inactiveShares = shares.filter((s) => s.revoked_at || isExpired(s));

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Create read-only links to share your portfolio with others
      </p>

      {/* ── Create link form ────────────────────────────── */}
      <form onSubmit={handleCreate} className="space-y-4 max-w-md">
        {/* Scope */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            What to share
          </label>
          <div className="space-y-1.5">
            {SCOPE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const selected = scope === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setScope(opt.value)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                    selected
                      ? "border-blue-500/50 bg-blue-500/10"
                      : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${selected ? "text-blue-400" : "text-zinc-500"}`} />
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${selected ? "text-zinc-100" : "text-zinc-300"}`}>
                      {opt.label}
                    </p>
                    <p className="text-xs text-zinc-500">{opt.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Expiry */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Link expiry
          </label>
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Label */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Label <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='e.g. "For my accountant"'
            maxLength={100}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>

        <div className="pt-1">
          <button
            type="submit"
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            <Link2 className="w-3.5 h-3.5" />
            {creating ? "Creating..." : "Create Share Link"}
          </button>
        </div>
      </form>

      {/* ── Active shares ───────────────────────────────── */}
      <div className="border-t border-zinc-800 pt-6">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">
          Active Links
        </h3>

        {loading ? (
          <p className="text-sm text-zinc-500">Loading...</p>
        ) : activeShares.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
            <Share2 className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No active share links</p>
            <p className="text-xs text-zinc-600 mt-1">
              Create a link above to share your portfolio
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeShares.map((share) => {
              const badge = scopeBadge(share.scope as ShareScope);
              return (
                <div
                  key={share.id}
                  className="flex items-center gap-3 px-3 py-2.5 bg-zinc-900/50 border border-zinc-800/50 rounded-lg"
                >
                  <Link2 className="w-4 h-4 text-zinc-500 shrink-0" />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-200 truncate">
                        {share.label || "Untitled link"}
                      </span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${badge.color}`}>
                        {badge.label}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Created {formatDate(share.created_at)}
                      {share.expires_at && ` · Expires ${formatDate(share.expires_at)}`}
                    </p>
                  </div>

                  {/* Copy button */}
                  <button
                    onClick={() => handleCopy(share)}
                    className="shrink-0 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                    title="Copy link"
                  >
                    {copiedId === share.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* Revoke button */}
                  <ConfirmButton
                    onConfirm={() => handleRevoke(share.id)}
                    confirmLabel="Revoke?"
                    confirmLabelClassName="text-red-400"
                    className="shrink-0 p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Revoke link"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </ConfirmButton>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Inactive shares (revoked / expired) ─────────── */}
      {inactiveShares.length > 0 && (
        <div className="border-t border-zinc-800 pt-6">
          <h3 className="text-sm font-medium text-zinc-500 mb-3">
            Inactive Links
          </h3>
          <div className="space-y-1.5">
            {inactiveShares.map((share) => {
              const badge = scopeBadge(share.scope as ShareScope);
              const expired = isExpired(share);
              return (
                <div
                  key={share.id}
                  className="flex items-center gap-3 px-3 py-2 bg-zinc-900/30 border border-zinc-800/30 rounded-lg opacity-60"
                >
                  <Link2 className="w-4 h-4 text-zinc-600 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-400 truncate">
                        {share.label || "Untitled link"}
                      </span>
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${badge.color}`}>
                        {badge.label}
                      </span>
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-red-500/15 text-red-400">
                        {expired ? "Expired" : "Revoked"}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 mt-0.5">
                      Created {formatDate(share.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
