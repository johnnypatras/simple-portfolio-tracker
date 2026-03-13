-- ==========================================================================
-- Baseline migration: full schema as of 2026-03-14
-- Replaces migrations 001-052 (archived in supabase/migrations-archive/)
--
-- Schema dump from pg_dump + runtime operations appended below.
-- No secrets in this file. Cron secret is auto-generated per database.
-- ==========================================================================


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE TYPE "public"."action_type" AS ENUM (
    'created',
    'updated',
    'removed',
    'undone'
);

ALTER TYPE "public"."action_type" OWNER TO "postgres";

CREATE TYPE "public"."asset_category" AS ENUM (
    'stock',
    'etf_non_ucits',
    'etf_ucits',
    'bond',
    'other',
    'individual_stock',
    'etf',
    'bond_fixed_income'
);

ALTER TYPE "public"."asset_category" OWNER TO "postgres";

CREATE TYPE "public"."currency_type" AS ENUM (
    'USD',
    'EUR'
);

ALTER TYPE "public"."currency_type" OWNER TO "postgres";

CREATE TYPE "public"."entity_type" AS ENUM (
    'crypto_asset',
    'stock_asset',
    'wallet',
    'broker',
    'bank_account',
    'exchange_deposit',
    'crypto_position',
    'stock_position',
    'diary_entry',
    'goal_price',
    'trade_entry',
    'broker_deposit',
    'institution'
);

ALTER TYPE "public"."entity_type" OWNER TO "postgres";

CREATE TYPE "public"."privacy_label" AS ENUM (
    'anon',
    'doxxed'
);

ALTER TYPE "public"."privacy_label" OWNER TO "postgres";

CREATE TYPE "public"."share_scope" AS ENUM (
    'overview',
    'full',
    'full_with_history'
);

ALTER TYPE "public"."share_scope" OWNER TO "postgres";

CREATE TYPE "public"."share_type" AS ENUM (
    'link',
    'user'
);

ALTER TYPE "public"."share_type" OWNER TO "postgres";

CREATE TYPE "public"."wallet_type" AS ENUM (
    'custodial',
    'non_custodial'
);

ALTER TYPE "public"."wallet_type" OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."call_daily_snapshot"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  bearer text;
  base_url text;
BEGIN
  SELECT value INTO bearer FROM cron_config WHERE key = 'cron_secret';
  SELECT value INTO base_url FROM cron_config WHERE key = 'supabase_url';

  PERFORM net.http_post(
    url := base_url || '/functions/v1/daily-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer
    ),
    body := '{}'::jsonb
  );
END;
$$;

ALTER FUNCTION "public"."call_daily_snapshot"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."cascade_soft_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Soft-delete cascade: parent → children
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    CASE TG_TABLE_NAME
      WHEN 'crypto_assets' THEN
        UPDATE crypto_positions SET deleted_at = NEW.deleted_at
          WHERE crypto_asset_id = NEW.id AND deleted_at IS NULL;
        UPDATE goal_prices SET deleted_at = NEW.deleted_at
          WHERE crypto_asset_id = NEW.id AND deleted_at IS NULL;
      WHEN 'stock_assets' THEN
        UPDATE stock_positions SET deleted_at = NEW.deleted_at
          WHERE stock_asset_id = NEW.id AND deleted_at IS NULL;
      WHEN 'wallets' THEN
        UPDATE crypto_positions SET deleted_at = NEW.deleted_at
          WHERE wallet_id = NEW.id AND deleted_at IS NULL;
        UPDATE exchange_deposits SET deleted_at = NEW.deleted_at
          WHERE wallet_id = NEW.id AND deleted_at IS NULL;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
        UPDATE broker_deposits SET deleted_at = NEW.deleted_at
          WHERE broker_id = NEW.id AND deleted_at IS NULL;
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE brokers SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
        UPDATE bank_accounts SET deleted_at = NEW.deleted_at
          WHERE institution_id = NEW.id AND deleted_at IS NULL;
      ELSE
        -- No children for other tables
        NULL;
    END CASE;
  END IF;

  -- Restore cascade: parent restored → restore children
  -- Only restores children that were cascade-deleted at the same time
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    CASE TG_TABLE_NAME
      WHEN 'crypto_assets' THEN
        UPDATE crypto_positions SET deleted_at = NULL
          WHERE crypto_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE goal_prices SET deleted_at = NULL
          WHERE crypto_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'stock_assets' THEN
        UPDATE stock_positions SET deleted_at = NULL
          WHERE stock_asset_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'wallets' THEN
        UPDATE crypto_positions SET deleted_at = NULL
          WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE exchange_deposits SET deleted_at = NULL
          WHERE wallet_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'brokers' THEN
        UPDATE stock_positions SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE broker_deposits SET deleted_at = NULL
          WHERE broker_id = NEW.id AND deleted_at = OLD.deleted_at;
      WHEN 'institutions' THEN
        UPDATE wallets SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE brokers SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
        UPDATE bank_accounts SET deleted_at = NULL
          WHERE institution_id = NEW.id AND deleted_at = OLD.deleted_at;
      ELSE
        NULL;
    END CASE;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."cascade_soft_delete"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."sync_institution_name"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE wallets SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE brokers SET name = NEW.name WHERE institution_id = NEW.id;
    UPDATE bank_accounts SET bank_name = NEW.name WHERE institution_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."sync_institution_name"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "action" "public"."action_type" NOT NULL,
    "entity_type" "public"."entity_type" NOT NULL,
    "entity_name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "entity_id" "uuid",
    "entity_table" "text",
    "before_snapshot" "jsonb",
    "after_snapshot" "jsonb",
    "undone_at" timestamp with time zone,
    "is_adjustment" boolean DEFAULT false NOT NULL,
    "delta_usd" numeric(18,2),
    "delta_eur" numeric(18,2),
    "transfer_group_id" "uuid",
    "compensates_for" "uuid"
);

ALTER TABLE "public"."activity_log" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."bank_accounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "bank_name" "text" NOT NULL,
    "region" "text" DEFAULT 'EU'::"text",
    "currency" "public"."currency_type" DEFAULT 'EUR'::"public"."currency_type",
    "balance" numeric(18,2) DEFAULT 0,
    "apy" numeric(6,4) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "institution_id" "uuid",
    "deleted_at" timestamp with time zone,
    "last_was_adjustment" boolean DEFAULT false NOT NULL,
    "last_was_transfer" boolean DEFAULT false NOT NULL
);

ALTER TABLE "public"."bank_accounts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."broker_deposits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "broker_id" "uuid" NOT NULL,
    "currency" "public"."currency_type" DEFAULT 'USD'::"public"."currency_type",
    "amount" numeric(18,2) DEFAULT 0,
    "apy" numeric(6,4) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    "last_was_adjustment" boolean DEFAULT false NOT NULL,
    "last_was_transfer" boolean DEFAULT false NOT NULL
);

ALTER TABLE "public"."broker_deposits" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."brokers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "institution_id" "uuid",
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."brokers" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."cron_config" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL
);

ALTER TABLE "public"."cron_config" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."crypto_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "name" "text" NOT NULL,
    "coingecko_id" "text" NOT NULL,
    "chain" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "subcategory" "text",
    "deleted_at" timestamp with time zone,
    "image_url" "text"
);

ALTER TABLE "public"."crypto_assets" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."crypto_positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crypto_asset_id" "uuid" NOT NULL,
    "wallet_id" "uuid" NOT NULL,
    "quantity" numeric(28,18) DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "acquisition_method" "text" DEFAULT 'bought'::"text",
    "apy" numeric(6,4) DEFAULT 0,
    "deleted_at" timestamp with time zone,
    "last_was_adjustment" boolean DEFAULT false NOT NULL,
    "last_was_transfer" boolean DEFAULT false NOT NULL
);

ALTER TABLE "public"."crypto_positions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."diary_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "entry_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."diary_entries" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."exchange_deposits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "wallet_id" "uuid" NOT NULL,
    "currency" "public"."currency_type" DEFAULT 'USD'::"public"."currency_type",
    "amount" numeric(18,2) DEFAULT 0,
    "apy" numeric(6,4) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    "last_was_adjustment" boolean DEFAULT false NOT NULL,
    "last_was_transfer" boolean DEFAULT false NOT NULL
);

ALTER TABLE "public"."exchange_deposits" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."goal_prices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "crypto_asset_id" "uuid" NOT NULL,
    "target_price" numeric(18,8) NOT NULL,
    "weight" numeric(4,2) DEFAULT 0.25,
    "label" "text",
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."goal_prices" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."institutions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."institutions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."invite_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "created_by" "uuid",
    "used_by" "uuid",
    "used_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);

ALTER TABLE "public"."invite_codes" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."portfolio_shares" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "share_type" "public"."share_type" NOT NULL,
    "token" "text",
    "viewer_id" "uuid",
    "scope" "public"."share_scope" DEFAULT 'full'::"public"."share_scope" NOT NULL,
    "label" "text",
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "no_self_share" CHECK (("owner_id" <> "viewer_id")),
    CONSTRAINT "share_link_has_token" CHECK ((("share_type" <> 'link'::"public"."share_type") OR ("token" IS NOT NULL))),
    CONSTRAINT "share_user_has_viewer" CHECK ((("share_type" <> 'user'::"public"."share_type") OR ("viewer_id" IS NOT NULL)))
);

ALTER TABLE "public"."portfolio_shares" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."portfolio_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "total_value_usd" numeric(18,2),
    "total_value_eur" numeric(18,2),
    "crypto_value_usd" numeric(18,2),
    "stocks_value_usd" numeric(18,2),
    "cash_value_usd" numeric(18,2),
    "snapshot_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "crypto_value_eur" numeric(20,2),
    "stocks_value_eur" numeric(20,2),
    "cash_value_eur" numeric(20,2),
    "stocks_eur_denominated_value" numeric(20,2),
    "cash_eur_denominated_value" numeric(20,2)
);

ALTER TABLE "public"."portfolio_snapshots" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "display_name" "text",
    "primary_currency" "public"."currency_type" DEFAULT 'EUR'::"public"."currency_type",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "theme" "text" DEFAULT 'zinc-dark'::"text",
    "role" "text" DEFAULT 'user'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "first_name" "text",
    "last_name" "text"
);

ALTER TABLE "public"."profiles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."stock_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "ticker" "text" NOT NULL,
    "name" "text" NOT NULL,
    "isin" "text",
    "category" "public"."asset_category" DEFAULT 'stock'::"public"."asset_category",
    "currency" "text" DEFAULT 'USD'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "yahoo_ticker" "text",
    "subcategory" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."stock_assets" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."stock_positions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stock_asset_id" "uuid" NOT NULL,
    "broker_id" "uuid" NOT NULL,
    "quantity" numeric(18,8) DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    "last_was_adjustment" boolean DEFAULT false NOT NULL,
    "last_was_transfer" boolean DEFAULT false NOT NULL
);

ALTER TABLE "public"."stock_positions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."trade_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trade_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "asset_type" "text" NOT NULL,
    "asset_name" "text" NOT NULL,
    "action" "text" NOT NULL,
    "quantity" numeric(28,18) NOT NULL,
    "price" numeric(18,8) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "total_value" numeric(18,2) NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "deleted_at" timestamp with time zone,
    CONSTRAINT "trade_entries_action_check" CHECK (("action" = ANY (ARRAY['buy'::"text", 'sell'::"text"]))),
    CONSTRAINT "trade_entries_asset_type_check" CHECK (("asset_type" = ANY (ARRAY['crypto'::"text", 'stock'::"text", 'cash'::"text", 'other'::"text"])))
);

ALTER TABLE "public"."trade_entries" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."wallets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "wallet_type" "public"."wallet_type" NOT NULL,
    "privacy_label" "public"."privacy_label",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "chain" "text",
    "institution_id" "uuid",
    "deleted_at" timestamp with time zone
);

ALTER TABLE "public"."wallets" OWNER TO "postgres";

ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."broker_deposits"
    ADD CONSTRAINT "broker_deposits_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."brokers"
    ADD CONSTRAINT "brokers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."cron_config"
    ADD CONSTRAINT "cron_config_pkey" PRIMARY KEY ("key");

ALTER TABLE ONLY "public"."crypto_assets"
    ADD CONSTRAINT "crypto_assets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."crypto_positions"
    ADD CONSTRAINT "crypto_positions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."diary_entries"
    ADD CONSTRAINT "diary_entries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."exchange_deposits"
    ADD CONSTRAINT "exchange_deposits_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."goal_prices"
    ADD CONSTRAINT "goal_prices_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."institutions"
    ADD CONSTRAINT "institutions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_code_key" UNIQUE ("code");

ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."portfolio_shares"
    ADD CONSTRAINT "portfolio_shares_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."portfolio_shares"
    ADD CONSTRAINT "portfolio_shares_token_key" UNIQUE ("token");

ALTER TABLE ONLY "public"."portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_user_id_snapshot_date_key" UNIQUE ("user_id", "snapshot_date");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."stock_assets"
    ADD CONSTRAINT "stock_assets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."stock_positions"
    ADD CONSTRAINT "stock_positions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."trade_entries"
    ADD CONSTRAINT "trade_entries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("id");

CREATE INDEX "idx_activity_log_adjustments" ON "public"."activity_log" USING "btree" ("user_id") WHERE (("is_adjustment" = true) AND ("undone_at" IS NULL) AND ("delta_usd" IS NOT NULL));

CREATE INDEX "idx_activity_log_cashflows" ON "public"."activity_log" USING "btree" ("user_id", "created_at" DESC) WHERE (("is_adjustment" = false) AND ("undone_at" IS NULL));

CREATE INDEX "idx_activity_log_compensates_for" ON "public"."activity_log" USING "btree" ("compensates_for") WHERE ("compensates_for" IS NOT NULL);

CREATE INDEX "idx_activity_log_entity" ON "public"."activity_log" USING "btree" ("entity_id") WHERE ("entity_id" IS NOT NULL);

CREATE INDEX "idx_activity_log_transfer_group" ON "public"."activity_log" USING "btree" ("transfer_group_id") WHERE ("transfer_group_id" IS NOT NULL);

CREATE INDEX "idx_activity_log_user_date" ON "public"."activity_log" USING "btree" ("user_id", "created_at" DESC);

CREATE INDEX "idx_bank_accounts_active" ON "public"."bank_accounts" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_bank_accounts_institution" ON "public"."bank_accounts" USING "btree" ("institution_id");

CREATE INDEX "idx_brokers_active" ON "public"."brokers" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_brokers_institution" ON "public"."brokers" USING "btree" ("institution_id");

CREATE INDEX "idx_crypto_assets_active" ON "public"."crypto_assets" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_diary_entries_active" ON "public"."diary_entries" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_portfolio_shares_owner" ON "public"."portfolio_shares" USING "btree" ("owner_id");

CREATE UNIQUE INDEX "idx_portfolio_shares_owner_viewer" ON "public"."portfolio_shares" USING "btree" ("owner_id", "viewer_id") WHERE ("viewer_id" IS NOT NULL);

CREATE INDEX "idx_portfolio_shares_token" ON "public"."portfolio_shares" USING "btree" ("token") WHERE ("token" IS NOT NULL);

CREATE INDEX "idx_stock_assets_active" ON "public"."stock_assets" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_stock_assets_tags" ON "public"."stock_assets" USING "gin" ("tags");

CREATE INDEX "idx_trade_entries_active" ON "public"."trade_entries" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_trade_entries_user_date" ON "public"."trade_entries" USING "btree" ("user_id", "trade_date" DESC);

CREATE INDEX "idx_wallets_active" ON "public"."wallets" USING "btree" ("user_id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_wallets_institution" ON "public"."wallets" USING "btree" ("institution_id");

CREATE UNIQUE INDEX "uq_broker_deposits_active" ON "public"."broker_deposits" USING "btree" ("user_id", "broker_id", "currency") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_crypto_assets_active" ON "public"."crypto_assets" USING "btree" ("user_id", "coingecko_id") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_crypto_positions_active" ON "public"."crypto_positions" USING "btree" ("crypto_asset_id", "wallet_id") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_exchange_deposits_active" ON "public"."exchange_deposits" USING "btree" ("user_id", "wallet_id", "currency") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_goal_prices_active" ON "public"."goal_prices" USING "btree" ("crypto_asset_id", "label") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_institutions_active" ON "public"."institutions" USING "btree" ("user_id", "name") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "uq_stock_assets_ticker_active" ON "public"."stock_assets" USING "btree" ("user_id", "ticker") WHERE (("yahoo_ticker" IS NULL) AND ("deleted_at" IS NULL));

CREATE UNIQUE INDEX "uq_stock_assets_yahoo_active" ON "public"."stock_assets" USING "btree" ("user_id", "yahoo_ticker") WHERE (("yahoo_ticker" IS NOT NULL) AND ("deleted_at" IS NULL));

CREATE UNIQUE INDEX "uq_stock_positions_active" ON "public"."stock_positions" USING "btree" ("stock_asset_id", "broker_id") WHERE ("deleted_at" IS NULL);

CREATE OR REPLACE TRIGGER "on_institution_name_change" AFTER UPDATE ON "public"."institutions" FOR EACH ROW EXECUTE FUNCTION "public"."sync_institution_name"();

CREATE OR REPLACE TRIGGER "soft_delete_cascade_brokers" AFTER UPDATE OF "deleted_at" ON "public"."brokers" FOR EACH ROW EXECUTE FUNCTION "public"."cascade_soft_delete"();

CREATE OR REPLACE TRIGGER "soft_delete_cascade_crypto_assets" AFTER UPDATE OF "deleted_at" ON "public"."crypto_assets" FOR EACH ROW EXECUTE FUNCTION "public"."cascade_soft_delete"();

CREATE OR REPLACE TRIGGER "soft_delete_cascade_institutions" AFTER UPDATE OF "deleted_at" ON "public"."institutions" FOR EACH ROW EXECUTE FUNCTION "public"."cascade_soft_delete"();

CREATE OR REPLACE TRIGGER "soft_delete_cascade_stock_assets" AFTER UPDATE OF "deleted_at" ON "public"."stock_assets" FOR EACH ROW EXECUTE FUNCTION "public"."cascade_soft_delete"();

CREATE OR REPLACE TRIGGER "soft_delete_cascade_wallets" AFTER UPDATE OF "deleted_at" ON "public"."wallets" FOR EACH ROW EXECUTE FUNCTION "public"."cascade_soft_delete"();

CREATE OR REPLACE TRIGGER "update_bank_accounts_updated_at" BEFORE UPDATE ON "public"."bank_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_broker_deposits_updated_at" BEFORE UPDATE ON "public"."broker_deposits" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_crypto_positions_updated_at" BEFORE UPDATE ON "public"."crypto_positions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_diary_entries_updated_at" BEFORE UPDATE ON "public"."diary_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_exchange_deposits_updated_at" BEFORE UPDATE ON "public"."exchange_deposits" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_institutions_updated_at" BEFORE UPDATE ON "public"."institutions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_portfolio_shares_updated_at" BEFORE UPDATE ON "public"."portfolio_shares" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_profiles_role_status" BEFORE UPDATE OF "role", "status" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_stock_positions_updated_at" BEFORE UPDATE ON "public"."stock_positions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

CREATE OR REPLACE TRIGGER "update_trade_entries_updated_at" BEFORE UPDATE ON "public"."trade_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();

ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_compensates_for_fkey" FOREIGN KEY ("compensates_for") REFERENCES "public"."activity_log"("id");

ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."broker_deposits"
    ADD CONSTRAINT "broker_deposits_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."broker_deposits"
    ADD CONSTRAINT "broker_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."brokers"
    ADD CONSTRAINT "brokers_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."brokers"
    ADD CONSTRAINT "brokers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."crypto_assets"
    ADD CONSTRAINT "crypto_assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."crypto_positions"
    ADD CONSTRAINT "crypto_positions_crypto_asset_id_fkey" FOREIGN KEY ("crypto_asset_id") REFERENCES "public"."crypto_assets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."crypto_positions"
    ADD CONSTRAINT "crypto_positions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."diary_entries"
    ADD CONSTRAINT "diary_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."exchange_deposits"
    ADD CONSTRAINT "exchange_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."exchange_deposits"
    ADD CONSTRAINT "exchange_deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."goal_prices"
    ADD CONSTRAINT "goal_prices_crypto_asset_id_fkey" FOREIGN KEY ("crypto_asset_id") REFERENCES "public"."crypto_assets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."institutions"
    ADD CONSTRAINT "institutions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."portfolio_shares"
    ADD CONSTRAINT "portfolio_shares_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."portfolio_shares"
    ADD CONSTRAINT "portfolio_shares_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."portfolio_snapshots"
    ADD CONSTRAINT "portfolio_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."stock_assets"
    ADD CONSTRAINT "stock_assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."stock_positions"
    ADD CONSTRAINT "stock_positions_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "public"."brokers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."stock_positions"
    ADD CONSTRAINT "stock_positions_stock_asset_id_fkey" FOREIGN KEY ("stock_asset_id") REFERENCES "public"."stock_assets"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."trade_entries"
    ADD CONSTRAINT "trade_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."broker_deposits" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."brokers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."cron_config" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."crypto_assets" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."crypto_positions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."diary_entries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."exchange_deposits" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."goal_prices" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."institutions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."invite_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_delete_shares" ON "public"."portfolio_shares" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "owner_id"));

CREATE POLICY "owners_insert_shares" ON "public"."portfolio_shares" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "owner_id"));

CREATE POLICY "owners_update_shares" ON "public"."portfolio_shares" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "owner_id"));

ALTER TABLE "public"."portfolio_shares" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."portfolio_snapshots" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_shares" ON "public"."portfolio_shares" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "owner_id") OR ((( SELECT "auth"."uid"() AS "uid") = "viewer_id") AND ("revoked_at" IS NULL) AND (("expires_at" IS NULL) OR ("expires_at" > "now"())))));

ALTER TABLE "public"."stock_assets" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."stock_positions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."trade_entries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_create_invites" ON "public"."invite_codes" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "created_by"));

CREATE POLICY "users_delete_own_activity" ON "public"."activity_log" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_delete_own_profile" ON "public"."profiles" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "id"));

CREATE POLICY "users_delete_own_snapshots" ON "public"."portfolio_snapshots" FOR DELETE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_insert_own_activity" ON "public"."activity_log" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_insert_own_snapshots" ON "public"."portfolio_snapshots" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_banks" ON "public"."bank_accounts" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_broker_deposits" ON "public"."broker_deposits" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_brokers" ON "public"."brokers" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_crypto" ON "public"."crypto_assets" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_crypto_positions" ON "public"."crypto_positions" USING ((EXISTS ( SELECT 1
   FROM "public"."crypto_assets"
  WHERE (("crypto_assets"."id" = "crypto_positions"."crypto_asset_id") AND ("crypto_assets"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "users_manage_own_deposits" ON "public"."exchange_deposits" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_diary" ON "public"."diary_entries" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_goals" ON "public"."goal_prices" USING ((EXISTS ( SELECT 1
   FROM "public"."crypto_assets"
  WHERE (("crypto_assets"."id" = "goal_prices"."crypto_asset_id") AND ("crypto_assets"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "users_manage_own_institutions" ON "public"."institutions" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_stock_positions" ON "public"."stock_positions" USING ((EXISTS ( SELECT 1
   FROM "public"."stock_assets"
  WHERE (("stock_assets"."id" = "stock_positions"."stock_asset_id") AND ("stock_assets"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "users_manage_own_stocks" ON "public"."stock_assets" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_trades" ON "public"."trade_entries" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_manage_own_wallets" ON "public"."wallets" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_read_own_activity" ON "public"."activity_log" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_read_own_invites" ON "public"."invite_codes" FOR SELECT USING (((( SELECT "auth"."uid"() AS "uid") = "created_by") OR (( SELECT "auth"."uid"() AS "uid") = "used_by")));

CREATE POLICY "users_read_own_profile" ON "public"."profiles" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "id"));

CREATE POLICY "users_read_own_snapshots" ON "public"."portfolio_snapshots" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_update_own_activity" ON "public"."activity_log" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

CREATE POLICY "users_update_own_profile" ON "public"."profiles" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "id"));

CREATE POLICY "users_update_own_snapshots" ON "public"."portfolio_snapshots" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "user_id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

ALTER TABLE "public"."wallets" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

SET SESSION AUTHORIZATION "postgres";
RESET SESSION AUTHORIZATION;

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

REVOKE ALL ON FUNCTION "public"."call_daily_snapshot"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."call_daily_snapshot"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."call_daily_snapshot"() FROM "authenticated";
GRANT ALL ON FUNCTION "public"."call_daily_snapshot"() TO "service_role";

GRANT ALL ON FUNCTION "public"."cascade_soft_delete"() TO "anon";
GRANT ALL ON FUNCTION "public"."cascade_soft_delete"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cascade_soft_delete"() TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";

GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";

GRANT ALL ON FUNCTION "public"."sync_institution_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_institution_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_institution_name"() TO "service_role";

GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";

SET SESSION AUTHORIZATION "postgres";
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION "postgres";
RESET SESSION AUTHORIZATION;

GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";

GRANT ALL ON TABLE "public"."bank_accounts" TO "anon";
GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";

GRANT ALL ON TABLE "public"."broker_deposits" TO "anon";
GRANT ALL ON TABLE "public"."broker_deposits" TO "authenticated";
GRANT ALL ON TABLE "public"."broker_deposits" TO "service_role";

GRANT ALL ON TABLE "public"."brokers" TO "anon";
GRANT ALL ON TABLE "public"."brokers" TO "authenticated";
GRANT ALL ON TABLE "public"."brokers" TO "service_role";

GRANT ALL ON TABLE "public"."cron_config" TO "anon";
GRANT ALL ON TABLE "public"."cron_config" TO "authenticated";
GRANT ALL ON TABLE "public"."cron_config" TO "service_role";

GRANT ALL ON TABLE "public"."crypto_assets" TO "anon";
GRANT ALL ON TABLE "public"."crypto_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."crypto_assets" TO "service_role";

GRANT ALL ON TABLE "public"."crypto_positions" TO "anon";
GRANT ALL ON TABLE "public"."crypto_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."crypto_positions" TO "service_role";

GRANT ALL ON TABLE "public"."diary_entries" TO "anon";
GRANT ALL ON TABLE "public"."diary_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."diary_entries" TO "service_role";

GRANT ALL ON TABLE "public"."exchange_deposits" TO "anon";
GRANT ALL ON TABLE "public"."exchange_deposits" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_deposits" TO "service_role";

GRANT ALL ON TABLE "public"."goal_prices" TO "anon";
GRANT ALL ON TABLE "public"."goal_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."goal_prices" TO "service_role";

GRANT ALL ON TABLE "public"."institutions" TO "anon";
GRANT ALL ON TABLE "public"."institutions" TO "authenticated";
GRANT ALL ON TABLE "public"."institutions" TO "service_role";

GRANT ALL ON TABLE "public"."invite_codes" TO "anon";
GRANT ALL ON TABLE "public"."invite_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."invite_codes" TO "service_role";

GRANT ALL ON TABLE "public"."portfolio_shares" TO "anon";
GRANT ALL ON TABLE "public"."portfolio_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."portfolio_shares" TO "service_role";

GRANT ALL ON TABLE "public"."portfolio_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."portfolio_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."portfolio_snapshots" TO "service_role";

GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";

GRANT ALL ON TABLE "public"."stock_assets" TO "anon";
GRANT ALL ON TABLE "public"."stock_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_assets" TO "service_role";

GRANT ALL ON TABLE "public"."stock_positions" TO "anon";
GRANT ALL ON TABLE "public"."stock_positions" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_positions" TO "service_role";

GRANT ALL ON TABLE "public"."trade_entries" TO "anon";
GRANT ALL ON TABLE "public"."trade_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."trade_entries" TO "service_role";

GRANT ALL ON TABLE "public"."wallets" TO "anon";
GRANT ALL ON TABLE "public"."wallets" TO "authenticated";
GRANT ALL ON TABLE "public"."wallets" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


-- ==========================================================================
-- Runtime operations not captured by pg_dump
-- ==========================================================================

-- 1. Auth trigger: create profile row when a new user signs up.
--    The trigger fires on auth.users (managed by Supabase), so pg_dump
--    doesn't include it since auth schema is excluded from the dump.
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Event trigger: auto-enable RLS on any new table created in public schema.
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- 3a. Store Supabase project URL (read by call_daily_snapshot at runtime).
--     UPDATE this value if you migrate to a different Supabase project.
INSERT INTO public.cron_config (key, value)
VALUES ('supabase_url', 'https://jaxjhmkehoyrkcxpbzay.supabase.co')
ON CONFLICT (key) DO NOTHING;

-- 3. Generate a random cron secret (unique per database instance, never in git).
INSERT INTO public.cron_config (key, value)
VALUES ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (key) DO UPDATE SET value = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

-- 4. Schedule daily portfolio snapshot cron job (23:59 UTC).
--    Uses call_daily_snapshot() wrapper which reads the secret from cron_config.
SELECT cron.schedule(
  'daily-portfolio-snapshot',
  '59 23 * * *',
  'SELECT call_daily_snapshot()'
);
