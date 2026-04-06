-- Add network column to crypto_positions for tracking which L2/chain a position lives on.
-- This is position-level metadata (e.g., "Linea", "Arbitrum", "Base") — distinct from
-- the asset-level chain field on crypto_assets which identifies the token's native chain.

ALTER TABLE "public"."crypto_positions" ADD COLUMN "network" TEXT;
