-- Scheduling + HTTP-from-Postgres
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Helper: POST to the public CLWRota sync hook for one step.
-- Reads the webhook secret from vault, so the cron.job.command never
-- contains the raw secret value.
CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync(p_step text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $fn$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
BEGIN
  IF p_step NOT IN ('staff','rota','leave') THEN
    RAISE EXCEPTION 'p_step must be one of: staff, rota, leave (got %)', p_step;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'CLWROTA_WEBHOOK_SECRET'
  LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'CLWROTA_WEBHOOK_SECRET is not present in vault.secrets';
  END IF;

  SELECT net.http_post(
    url     := v_url || '?step=' || p_step,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$fn$;

-- Restrict execution to the cron job runner / superuser context.
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync(text) TO postgres, service_role;