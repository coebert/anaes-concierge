
-- Shared rate-limiter table for CLWRota sync steps.
CREATE TABLE IF NOT EXISTS public.clwrota_sync_rate_limit (
  step text PRIMARY KEY CHECK (step IN ('staff','rota','leave')),
  min_interval_seconds integer NOT NULL DEFAULT 3300,
  last_attempt_at timestamptz,
  last_request_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.clwrota_sync_rate_limit TO authenticated;
GRANT ALL ON public.clwrota_sync_rate_limit TO service_role;

ALTER TABLE public.clwrota_sync_rate_limit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read rate limit" ON public.clwrota_sync_rate_limit;
CREATE POLICY "Admins read rate limit"
  ON public.clwrota_sync_rate_limit FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.clwrota_sync_rate_limit (step, min_interval_seconds)
VALUES ('staff', 3300), ('rota', 3300), ('leave', 3300)
ON CONFLICT (step) DO NOTHING;

-- Rate-limited trigger: only fires net.http_post if the configured minimum
-- interval has elapsed since the last attempt for that step, and an
-- advisory lock prevents concurrent overlap from manual + cron callers.
CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_rate_limited(p_step text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $function$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
  v_min_interval integer;
  v_last_attempt timestamptz;
  v_lock_key bigint;
BEGIN
  IF p_step NOT IN ('staff','rota','leave') THEN
    RAISE EXCEPTION 'p_step must be one of: staff, rota, leave (got %)', p_step;
  END IF;

  SELECT min_interval_seconds, last_attempt_at
    INTO v_min_interval, v_last_attempt
  FROM public.clwrota_sync_rate_limit
  WHERE step = p_step
  FOR UPDATE;

  IF v_last_attempt IS NOT NULL
     AND now() - v_last_attempt < make_interval(secs => v_min_interval) THEN
    RETURN NULL; -- rate-limited; skip silently
  END IF;

  v_lock_key := hashtextextended('clwrota_sync_' || p_step, 0);
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN NULL; -- another sync of this step is in flight
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

  UPDATE public.clwrota_sync_rate_limit
     SET last_attempt_at = now(),
         last_request_id = v_request_id,
         updated_at = now()
   WHERE step = p_step;

  RETURN v_request_id;
END;
$function$;

-- Consolidated entrypoint: fires all three steps through the rate-limiter.
CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_all_rate_limited()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_staff bigint;
  v_rota  bigint;
  v_leave bigint;
BEGIN
  v_staff := public.trigger_clwrota_sync_rate_limited('staff');
  v_rota  := public.trigger_clwrota_sync_rate_limited('rota');
  v_leave := public.trigger_clwrota_sync_rate_limited('leave');
  RETURN jsonb_build_object(
    'staff_request_id', v_staff,
    'rota_request_id',  v_rota,
    'leave_request_id', v_leave,
    'fired_at', now()
  );
END;
$function$;
