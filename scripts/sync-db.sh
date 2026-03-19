#!/usr/bin/env bash
set -euo pipefail
umask 077  # Restrict file permissions (dumps contain production data)

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

# ─── Cleanup on exit (signal safety) ─────────────────────
DUMP_FILE=""
AUTH_DUMP_FILE=""
ERR_LOG=""
cleanup() {
  rm -f "$DUMP_FILE" "$AUTH_DUMP_FILE" "$ERR_LOG"
}
trap cleanup EXIT

# ─── Step 1: Verify Docker ───────────────────────────────
if ! docker info > /dev/null 2>&1; then
  error "Docker is not running. Start Docker Desktop and retry."
fi

# ─── Step 2: Verify local Supabase ───────────────────────
if ! supabase status > /dev/null 2>&1; then
  warn "Local Supabase not running. Starting..."
  supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor
fi

# ─── Step 3: Read .env.remote ────────────────────────────
# NOTE: Values with special characters ($, spaces, !) MUST be single-quoted in .env.remote
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote. Copy .env.remote.example and fill in production credentials."
fi

# Parse env file safely (handles single-quoted values, comments, empty lines)
# The `|| [[ -n "$key" ]]` ensures the last line is processed even without a trailing newline
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  # Strip leading/trailing whitespace from key FIRST (before -z check)
  key=$(echo "$key" | xargs)
  # Skip comments, empty lines, and whitespace-only lines
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  # Strip surrounding quotes (single or double) from value
  value="${value#\'}" ; value="${value%\'}"
  value="${value#\"}" ; value="${value%\"}"
  export "$key=$value"
done < "$ENV_REMOTE"

if [ -z "${REMOTE_DATABASE_URL:-}" ]; then
  error "REMOTE_DATABASE_URL not set in .env.remote"
fi

# ─── Step 4: pg_dump public data from production ─────────
info "Dumping public schema data from production..."
DUMP_FILE=$(mktemp /tmp/sync-public-XXXXXX.dump)
ERR_LOG=$(mktemp /tmp/sync-err-XXXXXX.log)

if ! pg_dump "$REMOTE_DATABASE_URL" \
  --data-only \
  --schema=public \
  --format=custom \
  --file="$DUMP_FILE" 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Cannot connect to production database. Check network and .env.remote credentials."
fi

# ─── Step 5: pg_dump auth data from production ───────────
info "Dumping auth data from production..."
AUTH_DUMP_FILE=$(mktemp /tmp/sync-auth-XXXXXX.dump)

if ! pg_dump "$REMOTE_DATABASE_URL" \
  --data-only \
  --table=auth.users \
  --table=auth.identities \
  --table=auth.mfa_factors \
  --table=auth.mfa_challenges \
  --format=custom \
  --file="$AUTH_DUMP_FILE" 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Failed to dump auth data from production."
fi

# ─── Step 6: Get local DB connection ─────────────────────
# Use supabase_admin (superuser) for TRUNCATE + pg_restore --disable-triggers
# The default postgres role is NOT a superuser in local Supabase Docker
LOCAL_DB="postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres"

# ─── Step 7: Truncate local public tables ────────────────
info "Truncating local public tables..."
if ! psql "$LOCAL_DB" -q -c "
  DO \$\$
  DECLARE
    tbl text;
  BEGIN
    FOR tbl IN
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
    END LOOP;
  END \$\$;
" 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Failed to truncate local public tables."
fi

# ─── Step 8: Truncate local auth data ────────────────────
# Note: CASCADE also empties auth.sessions, auth.refresh_tokens, auth.one_time_tokens
# (ephemeral data — users must log in fresh after sync, which is expected behavior)
info "Truncating local auth data..."
if ! psql "$LOCAL_DB" -q -c "
  TRUNCATE auth.mfa_challenges, auth.mfa_factors, auth.identities, auth.users CASCADE;
" 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Failed to truncate local auth data."
fi

# ─── Step 9: Restore public data ─────────────────────────
info "Restoring public data..."
if ! pg_restore "$DUMP_FILE" \
  --dbname="$LOCAL_DB" \
  --data-only \
  --no-owner \
  --disable-triggers \
  --schema=public \
  --single-transaction 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Failed to restore public data. Local DB may be empty — run 'supabase db reset' then retry."
fi

# ─── Step 10: Restore auth data ──────────────────────────
info "Restoring auth data..."
if ! pg_restore "$AUTH_DUMP_FILE" \
  --dbname="$LOCAL_DB" \
  --data-only \
  --no-owner \
  --disable-triggers \
  --single-transaction 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  error "Failed to restore auth data. GoTrue version mismatch? Run 'supabase stop && supabase start' to update."
fi

# ─── Step 11: Apply pending migrations (no-op if none pending) ──
supabase migration up || error "Failed to apply pending migrations. Fix the migration and retry."

# ─── Step 12: Write .env.local ───────────────────────────
info "Generating .env.local with local Supabase keys..."
STATUS_JSON=$(supabase status --output json 2>/dev/null)

# Parse JSON with python3 (ships with macOS, handles any formatting)
API_URL=$(python3 -c "import sys,json; print(json.load(sys.stdin)['API_URL'])" <<< "$STATUS_JSON")
ANON_KEY=$(python3 -c "import sys,json; print(json.load(sys.stdin)['ANON_KEY'])" <<< "$STATUS_JSON")
SVC_ROLE_KEY=$(python3 -c "import sys,json; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])" <<< "$STATUS_JSON")

# Validate parsed values are non-empty
if [ -z "$API_URL" ] || [ -z "$ANON_KEY" ] || [ -z "$SVC_ROLE_KEY" ]; then
  error "Failed to parse supabase status output. Is local Supabase running?"
fi

cat > .env.local << 'ENVEOF_HEADER'
# Auto-generated by sync-db.sh — DO NOT EDIT (will be overwritten on next sync)
ENVEOF_HEADER
cat >> .env.local << ENVEOF
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SVC_ROLE_KEY}
COINGECKO_API_KEY=${COINGECKO_API_KEY:-}
NEXT_PUBLIC_SENTRY_DSN=${SENTRY_DSN:-}
SENTRY_DSN=${SENTRY_DSN:-}
ENVEOF

# ─── Step 13: Summary ────────────────────────────────────
TABLE_COUNT=$(psql "$LOCAL_DB" -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';" 2>/dev/null | tr -d ' ')
USER_COUNT=$(psql "$LOCAL_DB" -t -c "SELECT count(*) FROM auth.users;" 2>/dev/null | tr -d ' ')

info "Synced ${TABLE_COUNT} tables, ${USER_COUNT} auth users from production."
