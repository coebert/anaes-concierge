CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Unschedule any prior run of this job (safe if it doesn't exist)
DO $$
BEGIN
  PERFORM cron.unschedule('clwrota-hourly-resync');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'clwrota-hourly-resync',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlweGh0ZmxjbmZzYWRjYWN5d3d4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3ODAzODgsImV4cCI6MjA5NTM1NjM4OH0.eB9pXgYJjYaPeGsmbboiulaoBWEvp1pZhKK1igosVlc"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);