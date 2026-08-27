-- Daily full rota pass: bounded slices (3 x 50 days covers the 30-back/120-ahead window)
SELECT cron.unschedule('clwrota-sync-rota-daily');
SELECT cron.schedule(
  'clwrota-sync-rota-daily',
  '20 3 * * *',
  $$SELECT public.trigger_clwrota_sync_with_query('rota', 'mode=full&sliceDays=50&maxSlices=3');$$
);

-- Drop the redundant two-hourly incremental rota job: the hourly all-steps job
-- now performs an incremental rota sync by default, and running both at the
-- same minute put two heavy syncs in one worker.
SELECT cron.unschedule('clwrota-sync-rota-incremental');