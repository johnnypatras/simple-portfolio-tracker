-- Portfolio Sharing: share links + future user invitations
-- Allows owners to generate read-only share links with customizable scope and optional expiry.

BEGIN;

-- ─── Enums ────────────────────────────────────────────────
CREATE TYPE share_type AS ENUM ('link', 'user');
CREATE TYPE share_scope AS ENUM ('overview', 'full', 'full_with_history');

-- ─── Portfolio Shares ─────────────────────────────────────
CREATE TABLE portfolio_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  share_type share_type NOT NULL,

  -- For 'link' shares: a unique unguessable token (nanoid)
  token TEXT UNIQUE,

  -- For 'user' shares (Phase 2): the invited registered user
  viewer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- What sections the viewer can access
  scope share_scope NOT NULL DEFAULT 'full',

  -- Optional label set by owner (e.g., "For my accountant")
  label TEXT,

  -- Expiry (null = never expires)
  expires_at TIMESTAMPTZ,

  -- Revocation timestamp (null = active)
  revoked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT share_link_has_token CHECK (
    share_type != 'link' OR token IS NOT NULL
  ),
  CONSTRAINT share_user_has_viewer CHECK (
    share_type != 'user' OR viewer_id IS NOT NULL
  ),
  CONSTRAINT no_self_share CHECK (owner_id != viewer_id)
);

-- One user-share per viewer per owner (Phase 2)
CREATE UNIQUE INDEX idx_portfolio_shares_owner_viewer
  ON portfolio_shares(owner_id, viewer_id) WHERE viewer_id IS NOT NULL;

-- Fast token lookups for share link validation
CREATE INDEX idx_portfolio_shares_token
  ON portfolio_shares(token) WHERE token IS NOT NULL;

-- Owner lookups for listing shares
CREATE INDEX idx_portfolio_shares_owner
  ON portfolio_shares(owner_id);

-- ─── RLS ──────────────────────────────────────────────────
ALTER TABLE portfolio_shares ENABLE ROW LEVEL SECURITY;

-- Owners can manage their own shares (CRUD)
CREATE POLICY "owners_manage_shares" ON portfolio_shares
  FOR ALL USING ((select auth.uid()) = owner_id);

-- Viewers (registered users, Phase 2) can read shares directed at them
CREATE POLICY "viewers_read_shares" ON portfolio_shares
  FOR SELECT USING (
    (select auth.uid()) = viewer_id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
  );

-- ─── Updated-at trigger ───────────────────────────────────
-- Reuse the existing update_updated_at() trigger function
CREATE TRIGGER update_portfolio_shares_updated_at
  BEFORE UPDATE ON portfolio_shares
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
