import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "child_process";

let localConfig: { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

function getLocalConfig() {
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

export function getAdminClient(): SupabaseClient {
  const config = getLocalConfig();
  return createClient(config.API_URL, config.SERVICE_ROLE_KEY);
}

export async function createTestUser(email?: string): Promise<{
  client: SupabaseClient;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const admin = getAdminClient();
  const testEmail = email ?? `test-${Date.now()}@test.local`;

  const { data, error } = await admin.auth.admin.createUser({
    email: testEmail,
    password: "test-password-123!",
    email_confirm: true,
  });
  if (error) throw new Error("Failed to create test user: " + error.message);
  const userId = data.user.id;

  const config = getLocalConfig();
  const userClient = createClient(config.API_URL, config.ANON_KEY);
  const { error: signInError } = await userClient.auth.signInWithPassword({
    email: testEmail,
    password: "test-password-123!",
  });
  if (signInError)
    throw new Error("Failed to sign in: " + signInError.message);

  return {
    client: userClient,
    userId,
    cleanup: async () => {
      await admin.auth.admin.deleteUser(userId);
    },
  };
}
