"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Lock, Mail, KeyRound, Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const router = useRouter();
  const supabase = createClient();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data, error: signInError } =
        await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError(signInError.message);
        setLoading(false);
        return;
      }

      // Check if MFA is required
      if (
        data?.session === null &&
        data?.user === null
      ) {
        // MFA challenge needed — this happens when MFA is enforced
        setError("Unexpected auth state. Please try again.");
        setLoading(false);
        return;
      }

      // Check for MFA factors
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.[0];

      if (totpFactor) {
        // User has MFA — create challenge
        const { data: challenge, error: challengeError } =
          await supabase.auth.mfa.challenge({ factorId: totpFactor.id });

        if (challengeError) {
          setError(challengeError.message);
          setLoading(false);
          return;
        }

        setMfaFactorId(totpFactor.id);
        setChallengeId(challenge.id);
        setLoading(false);
        return;
      }

      // No MFA — go to dashboard
      router.push("/dashboard");
    } catch {
      setError("An unexpected error occurred");
      setLoading(false);
    }
  }

  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId!,
        challengeId: challengeId!,
        code: mfaCode,
      });

      if (verifyError) {
        setError(verifyError.message);
        setLoading(false);
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Verification failed");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700 mb-4">
            <Lock className="w-6 h-6 text-zinc-300" />
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">
            Portfolio Tracker
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Sign in to your account
          </p>
        </div>

        {/* MFA Step */}
        {mfaFactorId ? (
          <form onSubmit={handleMfaVerify} className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Authenticator Code
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) =>
                    setMfaCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 tracking-widest text-center text-lg"
                  autoFocus
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
              disabled={loading || mfaCode.length !== 6}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-medium rounded-lg transition-colors"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMfaFactorId(null);
                setChallengeId(null);
                setMfaCode("");
              }}
              className="w-full text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Back to login
            </button>
          </form>
        ) : (
          /* Login Step */
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
                  required
                  autoFocus
                />
              </div>
            </div>

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
                  placeholder="••••••••"
                  className="w-full pl-10 pr-10 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
                  required
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
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        <p className="text-xs text-zinc-600 text-center mt-6">
          Invite-only access. Contact the admin for an account.
        </p>
      </div>
    </div>
  );
}
