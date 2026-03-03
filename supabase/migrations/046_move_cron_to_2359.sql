-- Move daily snapshot cron from 23:55 to 23:59 UTC
-- Reduces the entity-creation-after-snapshot timing window from 5 min to 1 min.
-- Entities created in the last minute of the day are extremely rare.

SELECT cron.unschedule('daily-portfolio-snapshot');

SELECT cron.schedule(
  'daily-portfolio-snapshot',
  '59 23 * * *',
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
