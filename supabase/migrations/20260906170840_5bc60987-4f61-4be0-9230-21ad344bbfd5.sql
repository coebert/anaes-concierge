SELECT cron.unschedule('clwrota-icu-sync-daily');

SELECT cron.schedule(
  'clwrota-icu-sync-4hourly',
  '10 */4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/icu-sync?maxSlices=2&sliceDays=14',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);