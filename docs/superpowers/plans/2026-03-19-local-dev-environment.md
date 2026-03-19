# Local Dev Environment Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate local development from production database so `npm run dev` can never modify production data.

**Architecture:** Data-only sync from production pg_dump into local Supabase Docker. Schema managed by migration files. Unified CI pipeline: tests → migrate → deploy. Runtime safety guard prevents dev server from connecting to production.

**Tech Stack:** Bash scripts, pg_dump/pg_restore, Supabase CLI, Vercel CLI, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-19-local-dev-environment-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `scripts/sync-db.sh` | Create | Production → local data sync |
| `scripts/push-schema.sh` | Create | Push migrations to production |
| `scripts/push-data.sh` | Create | Full data push to production (guarded) |
| `.env.remote.example` | Create | Template for production credentials |
| `src/lib/supabase/env-guard.ts` | Create | Runtime safety guard module |
| `src/lib/supabase/server.ts` | Modify | Import env guard |
| `src/lib/supabase/client.ts` | No change | Browser-side — guard not needed (URL baked at build time) |
| `src/lib/supabase/admin.ts` | Modify | Import env guard |
| `src/lib/supabase/middleware.ts` | Modify | Import env guard |
| `.gitignore` | Modify | Add `!.env.remote.example`, `backups/` |
| `package.json` | Modify | Add npm scripts |
| `.github/workflows/ci.yml` | Create | Unified test + deploy pipeline |
| `.github/workflows/test.yml` | Delete | Replaced by ci.yml |
| `.github/workflows/deploy-edge-function.yml` | Delete | Absorbed into ci.yml |
| `__tests__/unit/env-guard.test.ts` | Create | Tests for runtime safety guard |

---

### Task 1: Runtime Safety Guard

**Files:**
- Create: `src/lib/supabase/env-guard.ts`
- Create: `__tests__/unit/env-guard.test.ts`
- Modify: `src/lib/supabase/server.ts`
- Modify: `src/lib/supabase/admin.ts`
- Modify: `src/lib/supabase/middleware.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/unit/env-guard.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("assertLocalSupabase", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws in development when URL points to supabase.co", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).toThrow("SAFETY");
  });

  it("includes hostname in error message", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://xyz.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).toThrow("xyz.supabase.co");
  });

  it("does not throw in development when URL is localhost", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw in production even with supabase.co URL", async () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw when URL is undefined", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });

  it("does not throw for non-supabase.co URLs", async () => {
    process.env.NODE_ENV = "development";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://evil-supabase.co.attacker.com";
    const { assertLocalSupabase } = await import("@/lib/supabase/env-guard");
    expect(() => assertLocalSupabase()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit __tests__/unit/env-guard.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the env guard module**

```typescript
// src/lib/supabase/env-guard.ts

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit __tests__/unit/env-guard.test.ts`
Expected: 6 tests PASS

- [ ] **Step 5: Wire env guard into all Supabase client modules**

Add `import { assertLocalSupabase } from "./env-guard";` and `assertLocalSupabase();` at the top of these **server-side only** files:
- `src/lib/supabase/server.ts` — after imports, before `export`
- `src/lib/supabase/admin.ts` — after imports, before `export`
- `src/lib/supabase/middleware.ts` — after imports, before `export`

Do NOT add to `src/lib/supabase/client.ts` — it's imported by browser components and the guard would ship to the client bundle unnecessarily. The browser client gets its URL baked in at build time and cannot be misconfigured at runtime.

- [ ] **Step 6: Verify build passes**

Run: `npm run build`
Expected: Build succeeds (guard is no-op in production mode)

- [ ] **Step 7: Verify lint passes**

Run: `npm run lint`
Expected: 0 errors, 0 warnings

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase/env-guard.ts __tests__/unit/env-guard.test.ts \
  src/lib/supabase/server.ts src/lib/supabase/admin.ts src/lib/supabase/middleware.ts
git commit -m "feat: add runtime safety guard for dev ↔ production isolation"
```

---

### Task 2: Environment File Reorganization

**Files:**
- Create: `.env.remote.example`
- Modify: `.gitignore`
- Modify: `package.json`

**Prerequisites:** User must have production DB connection string ready (from Supabase Dashboard → Connect → Session Pooler, port 5432, NOT transaction pooler on 6543).

- [ ] **Step 1: Create `.env.remote.example`**

```bash
# .env.remote.example
# Production Supabase — used ONLY by sync/push scripts, never by Next.js
#
# IMPORTANT: Use session pooler (port 5432), NOT transaction pooler (port 6543).
# Get this from: Supabase Dashboard → Connect → Session Pooler
# pg_dump requires a session-level connection (COPY protocol, etc.)
#
# Values with special characters ($, spaces, !) MUST be single-quoted.
REMOTE_DATABASE_URL='postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres'
REMOTE_SUPABASE_URL='https://your-project.supabase.co'
REMOTE_SUPABASE_SERVICE_ROLE_KEY='your-service-role-key'
COINGECKO_API_KEY=''
SENTRY_DSN=''
```

- [ ] **Step 2: Update `.gitignore`**

Replace lines 34-36 (the env section) and remove line 73 (`.env.sentry-build-plugin`):

```gitignore
# env files
.env*
!.env.example
!.env.remote.example
```

Add at end (after existing entries):
```gitignore
# database backups from push-data script
backups/
```

- [ ] **Step 3: Move current `.env.local` to `.env.remote`**

This is a **manual step** the user performs:
```bash
mv .env.local .env.remote
```
Then manually add `REMOTE_DATABASE_URL=postgresql://postgres.jaxjhmkehoyrkcxpbzay:...` to `.env.remote` (connection string from Supabase Dashboard).

- [ ] **Step 4: Update `package.json` scripts**

Replace/add these scripts:
```json
{
  "dev": "bash scripts/sync-db.sh && next dev --turbopack",
  "dev:skip-sync": "echo '⚠ Skipping sync — using existing local data.' && next dev --turbopack",
  "dev:edge": "supabase functions serve daily-snapshot --env-file .env.local",
  "sync": "bash scripts/sync-db.sh",
  "db:push-schema": "bash scripts/push-schema.sh",
  "db:push-data": "bash scripts/push-data.sh",
  "db:restore-backup": "bash scripts/push-data.sh --restore"
}
```

Keep all existing scripts (`build`, `start`, `lint`, `test`, `test:component`, `test:integration`, `test:all`, `test:watch`) unchanged.

- [ ] **Step 5: Commit**

```bash
git add .env.remote.example .gitignore package.json
git commit -m "feat: reorganize env files for local/production separation"
```

---

### Task 3: Sync Script (Production → Local)

**Files:**
- Create: `scripts/sync-db.sh`

- [ ] **Step 1: Create `scripts/` directory**

```bash
mkdir -p scripts
```

- [ ] **Step 2: Write sync-db.sh**

```bash
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
LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

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
```

- [ ] **Step 3: Make executable**

```bash
chmod +x scripts/sync-db.sh
```

- [ ] **Step 4: Test the sync script manually**

Run: `npm run sync`
Expected: Script syncs data, generates `.env.local` with local keys, prints summary.

Verify `.env.local` points to localhost:
```bash
grep NEXT_PUBLIC_SUPABASE_URL .env.local
# Expected: NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
```

- [ ] **Step 5: Test dev server starts with synced data**

Run: `npm run dev:skip-sync` (use skip-sync since we just synced)
Open browser → log in with production email/password → confirm data is present.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-db.sh
git commit -m "feat: add production-to-local sync script"
```

---

### Task 4: Push Scripts (Local → Production)

**Files:**
- Create: `scripts/push-schema.sh`
- Create: `scripts/push-data.sh`

- [ ] **Step 1: Write push-schema.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

# Read .env.remote (safe parser — handles special chars in passwords)
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote."
fi
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  key=$(echo "$key" | xargs)
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="${value#\'}" ; value="${value%\'}"
  value="${value#\"}" ; value="${value%\"}"
  export "$key=$value"
done < "$ENV_REMOTE"

if [ -z "${REMOTE_DATABASE_URL:-}" ]; then
  error "REMOTE_DATABASE_URL not set in .env.remote"
fi

# Dry run
echo -e "${YELLOW}Dry run — migrations that would be applied to PRODUCTION:${NC}"
echo ""
DRY_RUN_OUTPUT=$(supabase db push --db-url "$REMOTE_DATABASE_URL" --dry-run 2>&1) || {
  if echo "$DRY_RUN_OUTPUT" | grep -qi "no.*migration"; then
    info "No pending migrations."
    exit 0
  fi
  echo "$DRY_RUN_OUTPUT" >&2
  error "Failed to check migrations. Check network and credentials."
}
echo "$DRY_RUN_OUTPUT"

echo ""
read -rp "Apply these migration(s) to PRODUCTION? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

supabase db push --db-url "$REMOTE_DATABASE_URL"
info "Migrations applied to production."
```

- [ ] **Step 2: Write push-data.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077  # Restrict file permissions (backups contain production data)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

MODE="push" # default
if [[ "${1:-}" == "--restore" ]]; then
  MODE="restore"
  BACKUP_FILE="${2:-}"
  if [ -z "$BACKUP_FILE" ]; then
    error "Usage: npm run db:restore-backup -- <backup-file>"
  fi
  if [ ! -f "$BACKUP_FILE" ]; then
    error "Backup file not found: $BACKUP_FILE"
  fi
fi

# Require --confirm flag for push mode
if [[ "$MODE" == "push" && "${1:-}" != "--confirm" ]]; then
  error "Usage: npm run db:push-data -- --confirm"
fi

# Read .env.remote (safe parser — handles special chars in passwords)
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote."
fi
while IFS='=' read -r key value || [[ -n "$key" ]]; do
  key=$(echo "$key" | xargs)
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="${value#\'}" ; value="${value%\'}"
  value="${value#\"}" ; value="${value%\"}"
  export "$key=$value"
done < "$ENV_REMOTE"

if [ -z "${REMOTE_DATABASE_URL:-}" ]; then
  error "REMOTE_DATABASE_URL not set in .env.remote"
fi

# Warning banner
echo ""
echo -e "${RED}┌─────────────────────────────────────────────────────────┐${NC}"
echo -e "${RED}│  ⚠  DESTRUCTIVE: This will OVERWRITE the production    │${NC}"
echo -e "${RED}│     database with ${MODE} data.                        │${NC}"
echo -e "${RED}│     This includes auth data (users, passwords, MFA).   │${NC}"
echo -e "${RED}│     This cannot be undone (except from backup).        │${NC}"
echo -e "${RED}└─────────────────────────────────────────────────────────┘${NC}"
echo ""

# Backup production first
mkdir -p backups
BACKUP_DEST="backups/pre-push-$(date +%Y-%m-%d-%H%M%S).dump"
warn "Backing up production database to $BACKUP_DEST..."
pg_dump "$REMOTE_DATABASE_URL" \
  --schema=public \
  --schema=auth \
  --format=custom \
  --file="$BACKUP_DEST"
info "Backup saved: $BACKUP_DEST"

# Exact phrase confirmation
echo ""
read -rp "Type 'OVERWRITE PRODUCTION' to proceed: " phrase
if [[ "$phrase" != "OVERWRITE PRODUCTION" ]]; then
  echo "Aborted."
  exit 0
fi

LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Trap: clean up temp files + warn about backup if TRUNCATE happened
TRUNCATED_REMOTE=false
PUBLIC_DUMP=""
AUTH_DUMP=""
trap '
  rm -f "$PUBLIC_DUMP" "$AUTH_DUMP"
  if $TRUNCATED_REMOTE; then
    echo -e "${RED}CRITICAL: Production may be in an incomplete state.${NC}" >&2
    echo -e "${RED}Restore from backup: npm run db:restore-backup -- ${BACKUP_DEST}${NC}" >&2
  fi
' EXIT

if [[ "$MODE" == "push" ]]; then
  # Step 1: Dump local data to temp files BEFORE any truncation (safe — no production changes yet)
  warn "Dumping local public data..."
  PUBLIC_DUMP=$(mktemp /tmp/push-public-XXXXXX.dump)
  pg_dump "$LOCAL_DB" --schema=public --data-only --format=custom --file="$PUBLIC_DUMP"

  warn "Dumping local auth data..."
  AUTH_DUMP=$(mktemp /tmp/push-auth-XXXXXX.dump)
  pg_dump "$LOCAL_DB" --data-only --table=auth.users --table=auth.identities \
    --table=auth.mfa_factors --table=auth.mfa_challenges --format=custom --file="$AUTH_DUMP"

  # Step 2: Truncate production (point of no return — trap handler activates)
  # Note: CASCADE also empties auth.sessions, auth.refresh_tokens, auth.one_time_tokens
  # All active production sessions will be terminated — users must re-login
  warn "Truncating production tables (all active sessions will be terminated)..."
  psql "$REMOTE_DATABASE_URL" -q -c "
    DO \$\$
    DECLARE tbl text;
    BEGIN
      FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
      END LOOP;
    END \$\$;
  "
  psql "$REMOTE_DATABASE_URL" -q -c "
    TRUNCATE auth.mfa_challenges, auth.mfa_factors, auth.identities, auth.users CASCADE;
  "
  TRUNCATED_REMOTE=true

  # Step 3: Restore data from temp dumps
  warn "Restoring public data to production..."
  pg_restore "$PUBLIC_DUMP" \
    --dbname="$REMOTE_DATABASE_URL" --data-only --no-owner --disable-triggers --single-transaction

  warn "Restoring auth data to production..."
  pg_restore "$AUTH_DUMP" \
    --dbname="$REMOTE_DATABASE_URL" --data-only --no-owner --disable-triggers --single-transaction

  TRUNCATED_REMOTE=false  # success — disable trap warning (trap still cleans temp files)
  info "Production overwritten with local data. Backup at $BACKUP_DEST"
else
  # Restore from backup file using TRUNCATE + data-only (not --clean, which drops GoTrue schema)
  warn "Restoring from backup: $BACKUP_FILE..."

  # Truncate production tables first
  warn "Truncating production tables..."
  psql "$REMOTE_DATABASE_URL" -q -c "
    DO \$\$
    DECLARE tbl text;
    BEGIN
      FOR tbl IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
      END LOOP;
    END \$\$;
  "
  psql "$REMOTE_DATABASE_URL" -q -c "
    TRUNCATE auth.mfa_challenges, auth.mfa_factors, auth.identities, auth.users CASCADE;
  "
  TRUNCATED_REMOTE=true

  # Restore data from backup (data-only to avoid dropping GoTrue schema objects)
  pg_restore "$BACKUP_FILE" \
    --dbname="$REMOTE_DATABASE_URL" \
    --data-only \
    --no-owner \
    --disable-triggers \
    --single-transaction

  TRUNCATED_REMOTE=false  # success — disable trap warning
  info "Production restored from $BACKUP_FILE"
fi
```

- [ ] **Step 3: Make executable**

```bash
chmod +x scripts/push-schema.sh scripts/push-data.sh
```

- [ ] **Step 4: Test push-schema dry run** (safe — dry-run only)

Run: `npm run db:push-schema`
Expected: Shows "No pending migrations" (or lists any pending ones). Press `N` to abort.

- [ ] **Step 5: Verify restore argument passthrough**

Run: `npm run db:restore-backup -- nonexistent.dump`
Expected: Error message "Backup file not found: nonexistent.dump" — confirms npm passes the argument through correctly.

- [ ] **Step 6: Commit**

```bash
git add scripts/push-schema.sh scripts/push-data.sh
git commit -m "feat: add push-schema and push-data scripts for production"
```

---

### Task 5: Unified CI/CD Pipeline

**Files:**
- Create: `.github/workflows/ci.yml`
- Delete: `.github/workflows/test.yml`
- Delete: `.github/workflows/deploy-edge-function.yml`

**Prerequisites:** User must add GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. Also must disable Vercel auto-deploy in dashboard.

- [ ] **Step 1: Write ci.yml**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:  # manual trigger for re-deploys

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
          NEXT_PUBLIC_SUPABASE_ANON_KEY: dummy-anon-key-for-build
          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
        run: npm run build

      - name: Unit tests
        run: npm test

      - name: Component tests
        run: npm run test:component

      - name: Install Supabase CLI
        id: supabase-cli
        uses: supabase/setup-cli@v1
        with:
          version: 2.78.1

      - name: Cache Supabase Docker images
        uses: actions/cache@v4
        with:
          path: /tmp/supabase-docker-cache
          key: supabase-docker-${{ runner.os }}

      - name: Load cached Docker images
        run: |
          if [ -d /tmp/supabase-docker-cache ]; then
            for f in /tmp/supabase-docker-cache/*.tar; do
              docker load -i "$f" 2>/dev/null || true
            done
          fi

      - name: Start Supabase
        run: supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor

      - name: Save Docker images to cache
        run: |
          mkdir -p /tmp/supabase-docker-cache
          for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep supabase); do
            name=$(echo "$img" | tr '/:' '_')
            docker save "$img" -o "/tmp/supabase-docker-cache/${name}.tar" 2>/dev/null || true
          done

      - name: Integration tests
        run: npx vitest run --project integration

      - name: Stop Supabase
        if: always() && steps.supabase-cli.outcome == 'success'
        run: supabase stop

  preview:
    needs: test
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Vercel CLI
        run: npm install -g vercel@^50

      - name: Pull Vercel environment
        run: vercel pull --yes --environment=preview --token "$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Deploy preview
        run: |
          URL=$(vercel deploy --token "$VERCEL_TOKEN" --yes)
          echo "Preview URL: $URL"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # full history for reliable change detection

      - name: Install Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: 2.78.1

      - name: Link Supabase project
        run: supabase link --project-ref "$SUPABASE_PROJECT_REF"
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}

      - name: Push migrations (if changed)
        run: |
          BEFORE="${{ github.event.before }}"
          # On first push or workflow_dispatch, BEFORE is null SHA — run all deploy steps
          if [ "$BEFORE" = "0000000000000000000000000000000000000000" ] || [ -z "$BEFORE" ]; then
            echo "First push or manual dispatch — pushing all migrations..."
            supabase db push
          elif git diff "$BEFORE".."${{ github.sha }}" --name-only | grep -q '^supabase/migrations/'; then
            echo "Migrations changed — pushing to production..."
            supabase db push
          else
            echo "No migration changes — skipping."
          fi
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Install Vercel CLI
        run: npm install -g vercel@^50

      - name: Pull Vercel environment
        run: vercel pull --yes --environment=production --token "$VERCEL_TOKEN"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Deploy to production
        run: vercel deploy --prod --token "$VERCEL_TOKEN" --yes
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Deploy Edge Functions (if changed)
        run: |
          BEFORE="${{ github.event.before }}"
          if [ "$BEFORE" = "0000000000000000000000000000000000000000" ] || [ -z "$BEFORE" ]; then
            echo "First push or manual dispatch — deploying edge functions..."
            supabase functions deploy daily-snapshot --project-ref "$SUPABASE_PROJECT_REF"
          elif git diff "$BEFORE".."${{ github.sha }}" --name-only | grep -q '^supabase/functions/'; then
            echo "Edge Functions changed — deploying..."
            supabase functions deploy daily-snapshot --project-ref "$SUPABASE_PROJECT_REF"
          else
            echo "No Edge Function changes — skipping."
          fi
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_PROJECT_REF: ${{ secrets.SUPABASE_PROJECT_REF }}
```

- [ ] **Step 2: Delete old workflows**

```bash
rm .github/workflows/test.yml
rm .github/workflows/deploy-edge-function.yml
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git rm .github/workflows/test.yml .github/workflows/deploy-edge-function.yml
git commit -m "feat: unified CI pipeline with deploy (tests → migrate → deploy)"
```

---

### Task 6: Manual Setup Steps (User Action Required)

These steps require user interaction and cannot be automated:

- [ ] **Step 1: Get production database connection string**

Go to Supabase Dashboard → Project Settings → Database → Connection string → URI.
Select "Session Pooler" (port 5432, NOT the transaction pooler on 6543).
Add it to `.env.remote` as `REMOTE_DATABASE_URL`.

- [ ] **Step 2: Run first sync and verify**

```bash
npm run sync
npm run dev:skip-sync
```

Open browser → log in → verify all portfolio data is present.

- [ ] **Step 3: Set up Vercel CLI**

```bash
vercel link
cat .vercel/project.json  # note orgId and projectId
```

- [ ] **Step 4: Add GitHub secrets**

Go to GitHub repo → Settings → Secrets and variables → Actions. Add:
- `VERCEL_TOKEN` — from vercel.com/account/tokens (create new token)
- `VERCEL_ORG_ID` — `orgId` from `.vercel/project.json`
- `VERCEL_PROJECT_ID` — `projectId` from `.vercel/project.json`

- [ ] **Step 5: Verify Sentry env vars in Vercel**

Vercel Dashboard → Project → Settings → Environment Variables. Verify these exist:
- `SENTRY_AUTH_TOKEN` (needed for source map uploads during Vercel remote build)
- `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` (needed for runtime error tracking)

These were already configured if Vercel auto-deploy was working. Verify they're still present.

- [ ] **Step 6: Disable Vercel auto-deploy**

Vercel Dashboard → Project → Settings → Git → disconnect GitHub integration (or set Ignored Build Step to always skip).

- [ ] **Step 7: Verify CI pipeline**

Push a test branch with a trivial change, create PR:
- Verify: test job runs and passes
- Verify: preview job creates a preview URL

Merge to main:
- Verify: test job passes → deploy job runs → production deploys

---

### Task 7: Final Verification & Cleanup

- [ ] **Step 1: Full test suite passes**

```bash
npm run test:all
```
Expected: All 449+ tests pass.

- [ ] **Step 2: Build passes**

```bash
npm run build
```
Expected: Clean build, no errors.

- [ ] **Step 3: Lint passes**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Verify `.env.local` points to localhost**

```bash
grep SUPABASE_URL .env.local
```
Expected: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`

- [ ] **Step 5: Verify safety guard works**

Re-run the env guard unit tests to confirm the guard catches production URLs:
```bash
npx vitest run --project unit __tests__/unit/env-guard.test.ts
```
Expected: All 6 tests pass (including "throws in development when URL points to supabase.co").

- [ ] **Step 6: Final commit if any remaining changes**

```bash
git status
# If clean, done. If changes, commit with appropriate message.
```
