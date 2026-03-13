-- Rotate CRON_SECRET out of git history.
-- Old token was hardcoded in migrations 040/046 (public repo).
-- New approach: auto-generate secret in DB, read at runtime from both sides.

-- 1. Config table for secrets shared between pg_cron and Edge Functions.
--    RLS enabled with NO policies = only service_role can read (PostgREST blocked).
--    No user_id column — this is system config, not user data.
CREATE TABLE IF NOT EXISTS cron_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE cron_config ENABLE ROW LEVEL SECURITY;

-- 2. Generate a random secret (two UUID v4s concatenated, hyphens stripped = 64 hex chars).
--    Uses gen_random_uuid() which is built into PostgreSQL 13+ (no pgcrypto needed).
INSERT INTO cron_config (key, value)
VALUES ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (key) DO UPDATE SET value = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

-- 3. Wrapper function reads secret from config at runtime.
CREATE OR REPLACE FUNCTION call_daily_snapshot()
RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  bearer text;
BEGIN
  SELECT value INTO bearer FROM cron_config WHERE key = 'cron_secret';

  PERFORM net.http_post(
    url := 'https://jaxjhmkehoyrkcxpbzay.supabase.co/functions/v1/daily-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer
    ),
    body := '{}'::jsonb
  );
END;
$$;

-- Restrict execution to postgres only (pg_cron runs as postgres).
-- Without this, anon/authenticated users could call via PostgREST RPC.
REVOKE EXECUTE ON FUNCTION call_daily_snapshot() FROM PUBLIC, anon, authenticated;

-- 4. Replace old cron job (which had hardcoded token) with function call.
SELECT cron.unschedule('daily-portfolio-snapshot');
SELECT cron.schedule(
  'daily-portfolio-snapshot',
  '59 23 * * *',
  'SELECT call_daily_snapshot()'
);
