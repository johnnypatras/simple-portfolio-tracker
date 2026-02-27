-- Enable pg_cron for scheduled jobs
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Enable pg_net for HTTP requests from SQL
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Grant usage to postgres role (needed for cron job scheduling)
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
