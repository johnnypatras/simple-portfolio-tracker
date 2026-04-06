-- Allow same coingecko_id on different chains for the same user
-- Old constraint: (user_id, coingecko_id) WHERE deleted_at IS NULL
-- New constraint: (user_id, coingecko_id, COALESCE(chain, '')) WHERE deleted_at IS NULL
-- Existing rows with chain=null remain valid: COALESCE(null, '') = ''

DROP INDEX IF EXISTS "uq_crypto_assets_active";
CREATE UNIQUE INDEX "uq_crypto_assets_active" ON "public"."crypto_assets"
  USING btree ("user_id", "coingecko_id", COALESCE("chain", ''))
  WHERE ("deleted_at" IS NULL);
