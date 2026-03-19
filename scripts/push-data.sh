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
