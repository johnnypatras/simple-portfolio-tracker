/**
 * Throws if the dev server is accidentally pointing to production Supabase.
 * Call this at module scope in all Supabase client modules.
 * In production builds (Vercel), this is a no-op.
 */
export function assertLocalSupabase(): void {
  if (process.env.NODE_ENV !== "development") return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return;

  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith(".supabase.co") || hostname === "supabase.co") {
      throw new Error(
        "SAFETY: Development server is pointing to production Supabase " +
          `(${hostname}). Run \`npm run sync\` to regenerate .env.local ` +
          "with local credentials."
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("SAFETY:")) throw e;
    // Malformed URL — not a supabase.co URL, let it pass
  }
}
