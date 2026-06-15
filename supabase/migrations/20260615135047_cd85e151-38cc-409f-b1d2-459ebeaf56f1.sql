CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_with_query(p_step text, p_query text DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'extensions', 'vault'
AS $function$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
  v_full_url text;
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

  v_full_url := v_url || '?step=' || p_step;
  IF p_query IS NOT NULL AND length(p_query) > 0 THEN
    v_full_url := v_full_url || '&' || p_query;
  END IF;

  SELECT net.http_post(
    url     := v_full_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$function$;

-- Lock down: only postgres/service_role (cron runs as postgres), never signed-in users.
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) TO service_role;