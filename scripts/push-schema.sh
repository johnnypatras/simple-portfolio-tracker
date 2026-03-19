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
