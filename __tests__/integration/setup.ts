import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LocalConfig {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

let localConfig: LocalConfig;

function getLocalConfig(): LocalConfig {
  if (localConfig) return localConfig;
  const output = execFileSync("supabase", ["status", "--output", "json"], {
    encoding: "utf-8",
  });
  const parsed = JSON.parse(output);
  localConfig = {
    API_URL: parsed.API_URL,
    ANON_KEY: parsed.ANON_KEY,
    SERVICE_ROLE_KEY: parsed.SERVICE_ROLE_KEY,
  };
  return localConfig;
}

/**
 * Returns a Supabase client using the service_role key.
 * Bypasses RLS for data operations (PostgREST).
 * NOTE: Cannot be used for GoTrue admin endpoints on newer Supabase
 * local instances that use ES256 JWT keys.
 */
export function getAdminClient(): SupabaseClient {
  const config = getLocalConfig();
  return createClient(config.API_URL, config.SERVICE_ROLE_KEY);
}

/**
 * Deletes a user from auth.users via docker exec psql.
 * This cascades to all user data via ON DELETE CASCADE.
 */
function deleteAuthUser(userId: string): void {
  if (!UUID_RE.test(userId)) {
    throw new Error(`deleteAuthUser: invalid UUID: ${userId}`);
  }
  execFileSync("docker", [
    "exec",
    "supabase_db_simple-portfolio-tracker",
    "psql",
    "-U",
    "postgres",
    "-c",
    `DELETE FROM auth.users WHERE id = '${userId}';`,
  ]);
}

/**
 * Creates a test user via signUp (works with local Supabase ES256 auth),
 * returns an RLS-scoped client, the userId, and a cleanup function.
 */
export async function createTestUser(email?: string): Promise<{
  client: SupabaseClient;
  userId: string;
  cleanup: () => void;
}> {
  const config = getLocalConfig();
  const password = "testpassword123";

  const userClient = createClient(config.API_URL, config.ANON_KEY);

  // signUp creates the user and auto-confirms email on local Supabase. Under
  // parallel test load (8 files signing up concurrently) two failures are
  // transient and clear on retry:
  //   • "Database error"        — GoTrue signup contention under load.
  //   • "...already registered" — email collision. `Date.now()` has 1ms
  //     resolution, so two workers in the same tick produced identical emails.
  // When we own the address (no explicit `email` arg) we regenerate a
  // UUID-keyed address each attempt, so a collision cannot recur; an explicit
  // email is reused as-is (the caller owns its uniqueness). Retry up to 4×
  // with linear backoff.
  let userId = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const testEmail = email ?? `test-${Date.now()}-${randomUUID()}@test.local`;
    const { data, error } = await userClient.auth.signUp({
      email: testEmail,
      password,
    });
    if (!error && data.user) {
      userId = data.user.id;
      break;
    }
    const msg = error?.message ?? "signUp returned no user";
    const transient =
      msg.includes("Database error") || msg.includes("already registered");
    if (attempt < 3 && transient) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      continue;
    }
    throw new Error("Failed to sign up test user: " + msg);
  }
  if (!userId) {
    throw new Error("Failed to sign up test user: exhausted retries");
  }

  // Activate the user — is_active_user() RLS check blocks pending users from all operations.
  // The auth trigger creates the profile row, but we need to wait for it.
  const adminClient = getAdminClient();
  for (let i = 0; i < 10; i++) {
    const { data: profile } = await adminClient.from("profiles").select("id").eq("id", userId).maybeSingle();
    if (profile) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { error: activateErr } = await adminClient.from("profiles").update({ status: "active" }).eq("id", userId);
  if (activateErr) console.error("[setup] Failed to activate test user:", activateErr.message);

  return {
    client: userClient,
    userId,
    cleanup: () => {
      deleteAuthUser(userId);
    },
  };
}
