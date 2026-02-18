"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, Mail, KeyRound, Ticket, Eye, EyeOff } from "lucide-react";

function InviteForm() {
  const searchParams = useSearchParams();
  const [code, setCode] = useState(searchParams.get("code") ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const router = useRouter();

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      // Call server-side API route (bypasses RLS for invite validation)
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Registration failed");
        setLoading(false);
        return;
      }

      setSuccess(true);
      setLoading(false);
    } catch {
      setError("An unexpected error occurred");
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="w-full max-w-sm text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 mb-4">
          <KeyRound className="w-6 h-6 text-emerald-400" />
        </div>
        <h1 className="text-xl font-semibold text-zinc-100 mb-2">
          Account Created
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          Your account is ready. You can now sign in.
        </p>
        <button
          onClick={() => router.push("/login")}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
        >
          Go to Login
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      {/* Logo / Title */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700 mb-4">
          <Lock className="w-6 h-6 text-zinc-300" />
        </div>
        <h1 className="text-xl font-semibold text-zinc-100">Create Account</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Enter your invite code to register
        </p>
      </div>

      <form onSubmit={handleRegister} className="space-y-4">
        {/* Invite Code */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Invite Code
          </label>
          <div className="relative">
            <Ticket className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter your invite code"
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
              required
            />
          </div>
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">Email</label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
              required
            />
          </div>
        </div>

        {/* Password */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              className="w-full pl-10 pr-10 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
              required
              minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        {/* Confirm Password */}
        <div>
          <label className="block text-sm text-zinc-400 mb-1.5">
            Confirm Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
              required
              minLength={8}
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-400/10 px-3 py-2 rounded-lg">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-medium rounded-lg transition-colors"
        >
          {loading ? "Creating account..." : "Create Account"}
        </button>
      </form>

      <p className="text-xs text-zinc-600 text-center mt-6">
        Already have an account?{" "}
        <a
          href="/login"
          className="text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Sign in
        </a>
      </p>
    </div>
  );
}

export default function InvitePage() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="text-zinc-500 text-sm">Loading...</div>
        }
      >
        <InviteForm />
      </Suspense>
    </div>
  );
}
