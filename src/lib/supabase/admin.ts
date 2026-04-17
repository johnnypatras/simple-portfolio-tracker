import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabase } from "./env-guard";
import type { Database } from "@/types/database";
assertLocalSupabase();

/**
 * Service-role Supabase client — bypasses RLS.
 * Use ONLY for operations where the caller has no auth session
 * (e.g. share-link validation, invite-code redemption).
 */
export function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
