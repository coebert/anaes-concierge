SELECT cron.unschedule('clwrota-icu-sync-4hourly');

SELECT cron.schedule(
  'clwrota-icu-sync-2hourly',
  '10 */2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/icu-sync?maxSlices=2&sliceDays=7',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CLWROTA_WEBHOOK_SECRET' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

UPDATE public.icu_sync_state
  SET slice_days = 7, last_error = NULL, consecutive_failures = 0, updated_at = now()
  WHERE id = 1;