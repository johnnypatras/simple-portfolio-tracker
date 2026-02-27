-- Schedule daily snapshot at 23:55 UTC (after all major market closes)
-- Uses pg_net to HTTP POST to the daily-snapshot Edge Function
SELECT cron.schedule(
  'daily-portfolio-snapshot',
  '55 23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://jaxjhmkehoyrkcxpbzay.supabase.co/functions/v1/daily-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer rnk55Hw7xkHQAgZoLcoLPa8e3Nn/5k8smmBpUkNVUbc='
    ),
    body := '{}'::jsonb
  );
  $$
);
