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
| `src/lib/supabase/client.ts` | Modify | Import env guard |
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
- Modify: `src/lib/supabase/client.ts`
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
  if (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("supabase.co")
  ) {
    throw new Error(
      "SAFETY: Development server is pointing to production Supabase. " +
        "Run `npm run sync` to regenerate .env.local with local credentials."
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit __tests__/unit/env-guard.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Wire env guard into all Supabase client modules**

Add `import { assertLocalSupabase } from "./env-guard";` and `assertLocalSupabase();` at the top of:
- `src/lib/supabase/server.ts` — after imports, before `export`
- `src/lib/supabase/client.ts` — after imports, before `export`
- `src/lib/supabase/admin.ts` — after imports, before `export`
- `src/lib/supabase/middleware.ts` — after imports, before `export`

- [ ] **Step 6: Verify build passes**

Run: `npm run build`
Expected: Build succeeds (guard is no-op in production mode)

- [ ] **Step 7: Verify lint passes**

Run: `npm run lint`
Expected: 0 errors, 0 warnings

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase/env-guard.ts __tests__/unit/env-guard.test.ts \
  src/lib/supabase/server.ts src/lib/supabase/client.ts \
  src/lib/supabase/admin.ts src/lib/supabase/middleware.ts
git commit -m "feat: add runtime safety guard for dev ↔ production isolation"
```

---

### Task 2: Environment File Reorganization

**Files:**
- Create: `.env.remote.example`
- Modify: `.gitignore`
- Modify: `package.json`

**Prerequisites:** User must have production DB connection string ready (from Supabase Dashboard → Project Settings → Database → Connection string → URI, direct port 5432).

- [ ] **Step 1: Create `.env.remote.example`**

```bash
# .env.remote.example
# Production Supabase — used ONLY by sync/push scripts, never by Next.js
# IMPORTANT: Use direct connection (port 5432), NOT pooler (port 6543).
# pg_dump requires a direct Postgres session, not PgBouncer/Supavisor.
REMOTE_DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
REMOTE_SUPABASE_URL=https://your-project.supabase.co
REMOTE_SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
COINGECKO_API_KEY=
SENTRY_DSN=
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

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

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
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote. Copy .env.remote.example and fill in production credentials."
fi

# Source the env file to get variables
set -a
# shellcheck source=/dev/null
source "$ENV_REMOTE"
set +a

if [ -z "${REMOTE_DATABASE_URL:-}" ]; then
  error "REMOTE_DATABASE_URL not set in .env.remote"
fi

# ─── Step 4: pg_dump public data from production ─────────
info "Dumping public schema data from production..."
DUMP_FILE=$(mktemp /tmp/sync-public-XXXXXX.dump)

if ! pg_dump "$REMOTE_DATABASE_URL" \
  --data-only \
  --schema=public \
  --format=custom \
  --file="$DUMP_FILE" 2>/tmp/sync-pgdump-err.log; then
  cat /tmp/sync-pgdump-err.log >&2
  rm -f "$DUMP_FILE" /tmp/sync-pgdump-err.log
  error "Cannot connect to production database. Check network and .env.remote credentials."
fi

# ─── Step 5: pg_dump auth data from production ───────────
info "Dumping auth data from production..."
AUTH_DUMP_FILE=$(mktemp /tmp/sync-auth-XXXXXX.dump)

pg_dump "$REMOTE_DATABASE_URL" \
  --data-only \
  --table=auth.users \
  --table=auth.identities \
  --table=auth.mfa_factors \
  --table=auth.mfa_challenges \
  --format=custom \
  --file="$AUTH_DUMP_FILE" || {
    rm -f "$DUMP_FILE" "$AUTH_DUMP_FILE"
    error "Failed to dump auth data from production."
  }

# ─── Step 6: Get local DB connection ─────────────────────
LOCAL_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# ─── Step 7: Truncate local public tables ────────────────
info "Truncating local public tables..."
psql "$LOCAL_DB" -q -c "
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
" > /dev/null 2>&1

# ─── Step 8: Truncate local auth data ────────────────────
info "Truncating local auth data..."
psql "$LOCAL_DB" -q -c "
  TRUNCATE auth.mfa_challenges, auth.mfa_factors, auth.identities, auth.users CASCADE;
" > /dev/null 2>&1

# ─── Step 9: Restore public data ─────────────────────────
info "Restoring public data..."
if ! pg_restore "$DUMP_FILE" \
  --dbname="$LOCAL_DB" \
  --data-only \
  --no-owner \
  --disable-triggers \
  --schema=public \
  --single-transaction 2>/tmp/sync-restore-err.log; then
  cat /tmp/sync-restore-err.log >&2
  rm -f "$DUMP_FILE" "$AUTH_DUMP_FILE" /tmp/sync-restore-err.log
  error "Failed to restore public data. Local DB may be empty — run 'supabase db reset' then retry."
fi

# ─── Step 10: Restore auth data ──────────────────────────
info "Restoring auth data..."
if ! pg_restore "$AUTH_DUMP_FILE" \
  --dbname="$LOCAL_DB" \
  --data-only \
  --no-owner \
  --disable-triggers \
  --single-transaction 2>/tmp/sync-restore-err.log; then
  cat /tmp/sync-restore-err.log >&2
  rm -f "$DUMP_FILE" "$AUTH_DUMP_FILE" /tmp/sync-restore-err.log
  error "Failed to restore auth data."
fi

# ─── Step 11: Apply pending migrations (no-op if none pending) ──
supabase migration up || error "Failed to apply pending migrations. Fix the migration and retry."

# ─── Step 12: Write .env.local ───────────────────────────
info "Generating .env.local with local Supabase keys..."
STATUS_JSON=$(supabase status --output json 2>/dev/null)

# Parse JSON — uses grep+cut (no jq dependency). Assumes single-line JSON output
# from `supabase status --output json`, which has been stable across CLI versions.
API_URL=$(echo "$STATUS_JSON" | grep -o '"API_URL":"[^"]*"' | cut -d'"' -f4)
ANON_KEY=$(echo "$STATUS_JSON" | grep -o '"ANON_KEY":"[^"]*"' | cut -d'"' -f4)
SERVICE_ROLE_KEY=$(echo "$STATUS_JSON" | grep -o '"SERVICE_ROLE_KEY":"[^"]*"' | cut -d'"' -f4)

cat > .env.local << ENVEOF
NEXT_PUBLIC_SUPABASE_URL=${API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
COINGECKO_API_KEY=${COINGECKO_API_KEY:-}
NEXT_PUBLIC_SENTRY_DSN=${SENTRY_DSN:-}
SENTRY_DSN=${SENTRY_DSN:-}
ENVEOF

# ─── Step 13: Summary ────────────────────────────────────
TABLE_COUNT=$(psql "$LOCAL_DB" -t -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';" 2>/dev/null | tr -d ' ')
USER_COUNT=$(psql "$LOCAL_DB" -t -c "SELECT count(*) FROM auth.users;" 2>/dev/null | tr -d ' ')

# Cleanup temp files
rm -f "$DUMP_FILE" "$AUTH_DUMP_FILE" /tmp/sync-pgdump-err.log

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

# Read .env.remote
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote."
fi
set -a; source "$ENV_REMOTE"; set +a

if [ -z "${REMOTE_DATABASE_URL:-}" ]; then
  error "REMOTE_DATABASE_URL not set in .env.remote"
fi

# Dry run
echo -e "${YELLOW}Dry run — migrations that would be applied to PRODUCTION:${NC}"
echo ""
supabase db push --db-url "$REMOTE_DATABASE_URL" --dry-run 2>&1 || {
  info "No pending migrations."
  exit 0
}

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

# Read .env.remote
ENV_REMOTE=".env.remote"
if [ ! -f "$ENV_REMOTE" ]; then
  error "Missing .env.remote."
fi
set -a; source "$ENV_REMOTE"; set +a

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

if [[ "$MODE" == "push" ]]; then
  # Dump local → restore to production
  warn "Pushing local data to production..."
  pg_dump "$LOCAL_DB" --schema=public --data-only --format=custom | \
    pg_restore --dbname="$REMOTE_DATABASE_URL" --data-only --no-owner --disable-triggers --clean --single-transaction
  info "Production overwritten with local data. Backup at $BACKUP_DEST"
else
  # Restore from backup file (custom format)
  warn "Restoring from backup: $BACKUP_FILE..."
  pg_restore "$BACKUP_FILE" \
    --dbname="$REMOTE_DATABASE_URL" \
    --no-owner \
    --clean \
    --if-exists \
    --single-transaction
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
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Vercel CLI
        run: npm install -g vercel

      - name: Deploy preview
        run: |
          vercel deploy --token "$VERCEL_TOKEN" \
            --yes \
            > deployment-url.txt 2>&1
          echo "Preview URL: $(cat deployment-url.txt)"
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
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
          if git diff ${{ github.event.before }}..${{ github.sha }} --name-only | grep -q '^supabase/migrations/'; then
            echo "Migrations changed — pushing to production..."
            supabase db push
          else
            echo "No migration changes — skipping."
          fi
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Install Vercel CLI
        run: npm install -g vercel

      - name: Deploy to production
        run: vercel deploy --prod --token "$VERCEL_TOKEN" --yes
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}

      - name: Deploy Edge Functions (if changed)
        run: |
          if git diff ${{ github.event.before }}..${{ github.sha }} --name-only | grep -q '^supabase/functions/'; then
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
Select "Direct connection" (port 5432, NOT the pooler on 6543).
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

- [ ] **Step 5: Disable Vercel auto-deploy**

Vercel Dashboard → Project → Settings → Git → disconnect GitHub integration (or set Ignored Build Step to always skip).

- [ ] **Step 6: Verify CI pipeline**

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
Expected: All 4 tests pass (including "throws in development when URL points to supabase.co").

- [ ] **Step 6: Final commit if any remaining changes**

```bash
git status
# If clean, done. If changes, commit with appropriate message.
```
