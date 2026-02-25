"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearAllData,
  deleteAccount,
  changeEmail,
  changePassword,
} from "@/lib/actions/profile";
import {
  AlertTriangle,
  Trash2,
  DatabaseZap,
  Mail,
  Lock,
  Eye,
  EyeOff,
} from "lucide-react";
import type { Profile } from "@/lib/types";

export function AccountSettings({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Change email
  const [newEmail, setNewEmail] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Change password
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);

  async function handleChangeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setEmailSuccess(null);
    setEmailLoading(true);
    try {
      await changeEmail(newEmail.trim());
      setEmailSuccess(
        `Verification email sent to ${newEmail.trim()}. Check your inbox.`
      );
      setNewEmail("");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Failed to update email");
    } finally {
      setEmailLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(null);

    if (newPw !== confirmPw) {
      setPwError("Passwords do not match");
      return;
    }
    if (newPw.length < 8) {
      setPwError("New password must be at least 8 characters");
      return;
    }

    setPwLoading(true);
    try {
      await changePassword(currentPw, newPw);
      setPwSuccess("Password updated successfully");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwLoading(false);
    }
  }

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

      {/* Change Email */}
      <form onSubmit={handleChangeEmail} className="max-w-md space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Change Email</h3>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="New email address"
            className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          />
        </div>
        {emailError && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {emailError}
          </p>
        )}
        {emailSuccess && (
          <p className="text-sm text-emerald-400 bg-emerald-400/10 px-3 py-2 rounded-lg">
            {emailSuccess}
          </p>
        )}
        <button
          type="submit"
          disabled={emailLoading || !newEmail.trim()}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
        >
          {emailLoading ? "Sending..." : "Send Verification Email"}
        </button>
      </form>

      {/* Change Password */}
      <form onSubmit={handleChangePassword} className="max-w-md space-y-3 border-t border-zinc-800 pt-6">
        <h3 className="text-sm font-medium text-zinc-300">Change Password</h3>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type={showPw ? "text" : "password"}
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder="Current password"
            className="w-full pl-10 pr-10 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
          />
          <button
            type="button"
            onClick={() => setShowPw(!showPw)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type={showPw ? "text" : "password"}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="New password (min. 8 characters)"
            className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
            minLength={8}
          />
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type={showPw ? "text" : "password"}
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="Confirm new password"
            className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            required
            minLength={8}
          />
        </div>
        {pwError && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {pwError}
          </p>
        )}
        {pwSuccess && (
          <p className="text-sm text-emerald-400 bg-emerald-400/10 px-3 py-2 rounded-lg">
            {pwSuccess}
          </p>
        )}
        <button
          type="submit"
          disabled={pwLoading || !currentPw || !newPw || !confirmPw}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
        >
          {pwLoading ? "Updating..." : "Update Password"}
        </button>
      </form>

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
