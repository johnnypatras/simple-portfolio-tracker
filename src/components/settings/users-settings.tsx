"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  UserCheck,
  UserX,
  UserMinus,
  Copy,
  Check,
  Trash2,
  Plus,
  Ticket,
  ChevronDown,
  ChevronRight,
  Shield,
} from "lucide-react";
import { ConfirmButton } from "@/components/ui/confirm-button";
import {
  getUsers,
  approveUser,
  rejectUser,
  suspendUser,
  unsuspendUser,
  getInviteCodes,
  createInviteCode,
  deleteInviteCode,
  type InviteCode,
} from "@/lib/actions/admin";
import type { Profile } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return { label: "Active", color: "bg-emerald-500/15 text-emerald-400" };
    case "pending":
      return { label: "Pending", color: "bg-amber-500/15 text-amber-400" };
    case "suspended":
      return { label: "Suspended", color: "bg-red-500/15 text-red-400" };
    default:
      return { label: status, color: "bg-zinc-500/15 text-zinc-400" };
  }
}

function codeStatus(code: InviteCode): { label: string; color: string } {
  if (code.used_by) {
    return { label: `Used by ${code.used_by_email ?? "unknown"}`, color: "text-zinc-500" };
  }
  if (code.expires_at && new Date(code.expires_at) < new Date()) {
    return { label: "Expired", color: "text-red-400" };
  }
  return { label: "Available", color: "text-emerald-400" };
}

const EXPIRY_OPTIONS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "", label: "Never" },
];

// ─── Component ────────────────────────────────────────────

export function UsersSettings() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [showAllUsers, setShowAllUsers] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([getUsers(), getInviteCodes()]);
      setUsers(u);
      setCodes(c);
    } catch (err) {
      toast.error("Failed to load data");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const pendingUsers = users.filter((u) => u.status === "pending");
  const nonPendingUsers = users.filter((u) => u.status !== "pending");

  async function handleApprove(userId: string) {
    try {
      await approveUser(userId);
      toast.success("User approved");
      loadData();
    } catch {
      toast.error("Failed to approve user");
    }
  }

  async function handleReject(userId: string) {
    try {
      await rejectUser(userId);
      toast.success("User rejected and deleted");
      loadData();
    } catch {
      toast.error("Failed to reject user");
    }
  }

  async function handleSuspend(userId: string) {
    try {
      await suspendUser(userId);
      toast.success("User suspended");
      loadData();
    } catch {
      toast.error("Failed to suspend user");
    }
  }

  async function handleUnsuspend(userId: string) {
    try {
      await unsuspendUser(userId);
      toast.success("User reactivated");
      loadData();
    } catch {
      toast.error("Failed to reactivate user");
    }
  }

  async function handleCreateCode() {
    setCreating(true);
    try {
      const days = expiresInDays === "" ? null : Number(expiresInDays);
      const code = await createInviteCode(days);
      toast.success("Invite code created");
      // Auto-copy
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
      loadData();
    } catch {
      toast.error("Failed to create invite code");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteCode(codeId: string) {
    try {
      await deleteInviteCode(codeId);
      toast.success("Invite code deleted");
      loadData();
    } catch {
      toast.error("Failed to delete invite code");
    }
  }

  async function copyCode(code: string) {
    const link = `${window.location.origin}/register?code=${code}`;
    await navigator.clipboard.writeText(link);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
    toast.success("Invite link copied");
  }

  if (loading) {
    return (
      <div className="text-zinc-500 text-sm py-8 text-center">
        Loading user data...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ─── Pending Approvals ──────────────────────── */}
      <section>
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <UserCheck className="w-4 h-4" />
          Pending Approvals
          {pendingUsers.length > 0 && (
            <span className="bg-amber-500/15 text-amber-400 text-xs px-2 py-0.5 rounded-full">
              {pendingUsers.length}
            </span>
          )}
        </h3>

        {pendingUsers.length === 0 ? (
          <p className="text-sm text-zinc-600 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3">
            No pending registrations
          </p>
        ) : (
          <div className="space-y-2">
            {pendingUsers.map((user) => (
              <div
                key={user.id}
                className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3"
              >
                <div>
                  <p className="text-sm text-zinc-200">{user.email}</p>
                  <p className="text-xs text-zinc-500">
                    Registered {formatDate(user.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApprove(user.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-medium rounded-md transition-colors"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    Approve
                  </button>
                  <ConfirmButton
                    onConfirm={() => handleReject(user.id)}
                    confirmLabel="Confirm?"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs font-medium rounded-md transition-colors"
                  >
                    <UserX className="w-3.5 h-3.5" />
                    Reject
                  </ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── Invite Codes ──────────────────────────── */}
      <section>
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <Ticket className="w-4 h-4" />
          Invite Codes
        </h3>

        {/* Generate form */}
        <div className="flex items-center gap-2 mb-3">
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                Expires: {opt.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleCreateCode}
            disabled={creating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium rounded-md transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {creating ? "Creating..." : "Generate Code"}
          </button>
        </div>

        {codes.length === 0 ? (
          <p className="text-sm text-zinc-600 bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3">
            No invite codes generated yet
          </p>
        ) : (
          <div className="space-y-2">
            {codes.map((code) => {
              const status = codeStatus(code);
              const isUsed = !!code.used_by;
              return (
                <div
                  key={code.id}
                  className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <code className="text-sm text-zinc-300 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">
                      {code.code}
                    </code>
                    <span className={`text-xs ${status.color}`}>
                      {status.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!isUsed && (
                      <>
                        <button
                          onClick={() => copyCode(code.code)}
                          className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                          title="Copy invite link"
                        >
                          {copiedCode === code.code ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <ConfirmButton
                          onConfirm={() => handleDeleteCode(code.id)}
                          confirmLabel="Delete?"
                          className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors"
                          title="Delete code"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </ConfirmButton>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── All Users (collapsible) ───────────────── */}
      <section>
        <button
          onClick={() => setShowAllUsers(!showAllUsers)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors mb-3"
        >
          {showAllUsers ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <Shield className="w-4 h-4" />
          All Users ({nonPendingUsers.length})
        </button>

        {showAllUsers && (
          <div className="space-y-2">
            {nonPendingUsers.map((user) => {
              const badge = statusBadge(user.status);
              return (
                <div
                  key={user.id}
                  className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800/50 rounded-lg px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200 truncate">
                        {user.display_name || user.email}
                      </p>
                      {user.display_name && (
                        <p className="text-xs text-zinc-500 truncate">
                          {user.email}
                        </p>
                      )}
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${badge.color}`}
                    >
                      {badge.label}
                    </span>
                    {user.role === "admin" && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 shrink-0">
                        Admin
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-zinc-600 hidden sm:block">
                      {formatDate(user.created_at)}
                    </span>
                    {user.role !== "admin" && (
                      <>
                        {user.status === "active" ? (
                          <ConfirmButton
                            onConfirm={() => handleSuspend(user.id)}
                            confirmLabel="Confirm?"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs font-medium rounded-md transition-colors"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                            Suspend
                          </ConfirmButton>
                        ) : user.status === "suspended" ? (
                          <button
                            onClick={() => handleUnsuspend(user.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-medium rounded-md transition-colors"
                          >
                            <UserCheck className="w-3.5 h-3.5" />
                            Reactivate
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
