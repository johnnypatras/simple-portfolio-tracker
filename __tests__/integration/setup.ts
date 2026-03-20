import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "child_process";

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
  const testEmail = email ?? `test-${Date.now()}@test.local`;
  const password = "testpassword123";

  const userClient = createClient(config.API_URL, config.ANON_KEY);

  // signUp creates the user and auto-confirms email on local Supabase.
  // Retry once on "Database error" — concurrent signups in parallel test files
  // can transiently fail under load.
  let data, error;
  for (let attempt = 0; attempt < 2; attempt++) {
    ({ data, error } = await userClient.auth.signUp({
      email: testEmail,
      password,
    }));
    if (!error) break;
    if (attempt === 0 && error.message.includes("Database error")) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    throw new Error("Failed to sign up test user: " + error.message);
  }
  if (error) throw new Error("Failed to sign up test user: " + error.message);
  if (!data?.user) throw new Error("signUp returned no user");
  const userId = data.user.id;

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
