"use client";

import { useState } from "react";
import { updateProfile } from "@/lib/actions/profile";
import type { Profile, Currency } from "@/types/database";

const currencies: { value: Currency; label: string }[] = [
  { value: "EUR", label: "EUR (€) — Euro" },
  { value: "USD", label: "USD ($) — US Dollar" },
];

export function GeneralSettings({ profile }: { profile: Profile }) {
  const [displayName, setDisplayName] = useState(profile.display_name ?? "");
  const [currency, setCurrency] = useState<Currency>(profile.primary_currency);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChanges =
    displayName !== (profile.display_name ?? "") ||
    currency !== profile.primary_currency;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setLoading(true);

    try {
      await updateProfile({
        display_name: displayName.trim() || null,
        primary_currency: currency,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-400">
        Customize your portfolio display preferences
      </p>

      <form onSubmit={handleSave} className="space-y-5 max-w-md">
        {/* Display Name */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <p className="text-xs text-zinc-600 mt-1">
            Shown in the dashboard header
          </p>
        </div>

        {/* Primary Currency */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Primary Currency
          </label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            {currencies.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-600 mt-1">
            Portfolio totals and conversions will use this currency
          </p>
        </div>

        {/* Email (read-only) */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">Email</label>
          <input
            type="email"
            value={profile.email}
            disabled
            className="w-full px-3 py-2.5 bg-zinc-950/50 border border-zinc-800/50 rounded-lg text-zinc-500 cursor-not-allowed"
          />
          <p className="text-xs text-zinc-600 mt-1">
            Email cannot be changed
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        {saved && (
          <p className="text-sm text-emerald-400 bg-emerald-400/10 px-3 py-2 rounded-lg">
            Settings saved
          </p>
        )}

        <div className="pt-2">
          <button
            type="submit"
            disabled={loading || !hasChanges}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white rounded-lg transition-colors"
          >
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
