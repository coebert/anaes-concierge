UPDATE public.clwrota_sync_state SET sync_days_ahead = GREATEST(sync_days_ahead, 380);

DO $$ BEGIN PERFORM cron.unschedule('clwrota-sync-rota-near-term'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'clwrota-sync-rota-near-term',
  '5 5-22 * * *',
  $$SELECT public.trigger_clwrota_sync_with_query('rota', 'mode=incremental');$$
);

DO $$ BEGIN PERFORM cron.unschedule('clwrota-sync-rota-evening'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'clwrota-sync-rota-evening',
  '20 23 * * *',
  $$SELECT public.trigger_clwrota_sync_with_query('rota', 'mode=full&sliceDays=14&maxSlices=3');$$
);