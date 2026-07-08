-- Add explicit in-body access checks to the SECURITY DEFINER RPCs used by
-- rota and competency validation, and lock down their EXECUTE grants.
--
-- Defence in depth: even if a future migration accidentally regrants
-- EXECUTE to anon/PUBLIC, the function body itself rejects unauthorized
-- callers with insufficient_privilege.

-- 1) Competency eligibility: signed-in users only. Returns staff PII
-- (full_name, grade) so anonymous access is never allowed.
CREATE OR REPLACE FUNCTION public.get_competency_eligibility(p_on_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(specialty_id uuid, specialty_name text, staff_id uuid, full_name text, grade staff_grade, eligible_solo boolean, eligible_supervising boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Explicit access check: reject anonymous callers. auth.uid() is NULL
  -- when there is no signed-in user (anon role or missing JWT).
  IF auth.uid() IS NULL
     AND current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'get_competency_eligibility requires an authenticated caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH active_holdings AS (
    SELECT sc.staff_id, sc.competency_id, sc.level
      FROM public.staff_competencies sc
     WHERE sc.granted_at <= p_on_date
       AND (sc.revoked_at IS NULL OR sc.revoked_at > p_on_date)
       AND (sc.expires_at IS NULL OR sc.expires_at >= p_on_date)
  ),
  req_solo AS (
    SELECT specialty_id, competency_id FROM public.specialty_competency_requirements
     WHERE requirement = 'required' AND applies_to_role IN ('solo', 'any')
  ),
  req_sup AS (
    SELECT specialty_id, competency_id FROM public.specialty_competency_requirements
     WHERE requirement = 'required' AND applies_to_role IN ('supervising', 'any')
  ),
  staff_pool AS (
    SELECT p.id AS staff_id, p.full_name, p.grade
      FROM public.profiles p WHERE p.active = true
  ),
  solo_eligible AS (
    SELECT sp.staff_id, s.id AS specialty_id
      FROM staff_pool sp CROSS JOIN public.specialties s
     WHERE NOT EXISTS (
       SELECT 1 FROM req_solo r
        WHERE r.specialty_id = s.id
          AND NOT EXISTS (
            SELECT 1 FROM active_holdings h
             WHERE h.staff_id = sp.staff_id
               AND h.competency_id = r.competency_id
               AND (h.level IS NULL OR h.level <> 'supervised')
          )
     )
  ),
  sup_eligible AS (
    SELECT sp.staff_id, s.id AS specialty_id
      FROM staff_pool sp CROSS JOIN public.specialties s
     WHERE NOT EXISTS (
       SELECT 1 FROM req_sup r
        WHERE r.specialty_id = s.id
          AND NOT EXISTS (
            SELECT 1 FROM active_holdings h
             WHERE h.staff_id = sp.staff_id
               AND h.competency_id = r.competency_id
          )
     )
  )
  SELECT s.id, s.name, sp.staff_id, sp.full_name, sp.grade,
    EXISTS(SELECT 1 FROM solo_eligible e WHERE e.staff_id = sp.staff_id AND e.specialty_id = s.id),
    EXISTS(SELECT 1 FROM sup_eligible  e WHERE e.staff_id = sp.staff_id AND e.specialty_id = s.id)
  FROM public.specialties s CROSS JOIN staff_pool sp
  ORDER BY s.name, sp.full_name;

  PERFORM public.log_rpc_access('get_competency_eligibility', NULL,
    jsonb_build_object('p_on_date', p_on_date));
END $function$;

REVOKE ALL ON FUNCTION public.get_competency_eligibility(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_competency_eligibility(date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_competency_eligibility(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_competency_eligibility(date) TO service_role;

-- 2) CLWROTA sync triggers: admin-only, defence in depth.
CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync(p_step text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
BEGIN
  -- Explicit access check: admin or service_role only.
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER')
     AND NOT COALESCE(public.has_role(auth.uid(), 'admin'), false) THEN
    RAISE EXCEPTION 'trigger_clwrota_sync requires admin or service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_step NOT IN ('staff','rota','leave') THEN
    RAISE EXCEPTION 'p_step must be one of: staff, rota, leave (got %)', p_step;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'CLWROTA_WEBHOOK_SECRET' LIMIT 1;
  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'CLWROTA_WEBHOOK_SECRET is not present in vault.secrets';
  END IF;

  SELECT net.http_post(
    url := v_url || '?step=' || p_step,
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;
  RETURN v_request_id;
END $function$;

CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_rate_limited(p_step text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
  v_min_interval integer;
  v_last_attempt timestamptz;
  v_lock_key bigint;
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER')
     AND NOT COALESCE(public.has_role(auth.uid(), 'admin'), false) THEN
    RAISE EXCEPTION 'trigger_clwrota_sync_rate_limited requires admin or service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_step NOT IN ('staff','rota','leave') THEN
    RAISE EXCEPTION 'p_step must be one of: staff, rota, leave (got %)', p_step;
  END IF;

  SELECT min_interval_seconds, last_attempt_at INTO v_min_interval, v_last_attempt
  FROM public.clwrota_sync_rate_limit WHERE step = p_step FOR UPDATE;

  IF v_last_attempt IS NOT NULL
     AND now() - v_last_attempt < make_interval(secs => v_min_interval) THEN
    RETURN NULL;
  END IF;

  v_lock_key := hashtextextended('clwrota_sync_' || p_step, 0);
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'CLWROTA_WEBHOOK_SECRET' LIMIT 1;
  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'CLWROTA_WEBHOOK_SECRET is not present in vault.secrets';
  END IF;

  SELECT net.http_post(
    url := v_url || '?step=' || p_step,
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  UPDATE public.clwrota_sync_rate_limit
     SET last_attempt_at = now(), last_request_id = v_request_id, updated_at = now()
   WHERE step = p_step;

  RETURN v_request_id;
END $function$;

CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_with_query(p_step text, p_query text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'vault'
AS $function$
DECLARE
  v_secret text;
  v_url text := 'https://project--58d57e5a-3648-4d9e-b953-83e4bf950e52.lovable.app/api/public/hooks/clwrota-sync';
  v_request_id bigint;
  v_full_url text;
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER')
     AND NOT COALESCE(public.has_role(auth.uid(), 'admin'), false) THEN
    RAISE EXCEPTION 'trigger_clwrota_sync_with_query requires admin or service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_step NOT IN ('staff','rota','leave') THEN
    RAISE EXCEPTION 'p_step must be one of: staff, rota, leave (got %)', p_step;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'CLWROTA_WEBHOOK_SECRET' LIMIT 1;
  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE EXCEPTION 'CLWROTA_WEBHOOK_SECRET is not present in vault.secrets';
  END IF;

  v_full_url := v_url || '?step=' || p_step;
  IF p_query IS NOT NULL AND length(p_query) > 0 THEN
    v_full_url := v_full_url || '&' || p_query;
  END IF;

  SELECT net.http_post(
    url := v_full_url,
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN v_request_id;
END $function$;

CREATE OR REPLACE FUNCTION public.trigger_clwrota_sync_all_rate_limited()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff bigint;
  v_rota  bigint;
  v_leave bigint;
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER')
     AND NOT COALESCE(public.has_role(auth.uid(), 'admin'), false) THEN
    RAISE EXCEPTION 'trigger_clwrota_sync_all_rate_limited requires admin or service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_staff := public.trigger_clwrota_sync_rate_limited('staff');
  v_rota  := public.trigger_clwrota_sync_rate_limited('rota');
  v_leave := public.trigger_clwrota_sync_rate_limited('leave');
  RETURN jsonb_build_object(
    'staff_request_id', v_staff,
    'rota_request_id',  v_rota,
    'leave_request_id', v_leave,
    'fired_at', now()
  );
END $function$;

-- 3) Cron run history: admin-only.
CREATE OR REPLACE FUNCTION public.list_clwrota_cron_runs(p_limit integer DEFAULT 50)
 RETURNS TABLE(jobname text, schedule text, active boolean, runid bigint, start_time timestamp with time zone, end_time timestamp with time zone, status text, return_message text, command text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
BEGIN
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER')
     AND NOT COALESCE(public.has_role(auth.uid(), 'admin'), false) THEN
    RAISE EXCEPTION 'list_clwrota_cron_runs requires admin or service_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    j.jobname::text, j.schedule::text, j.active,
    r.runid, r.start_time, r.end_time,
    r.status::text, r.return_message::text, j.command::text
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT runid, start_time, end_time, status, return_message
    FROM cron.job_run_details d
    WHERE d.jobid = j.jobid
    ORDER BY d.start_time DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ) r ON TRUE
  WHERE j.jobname LIKE 'clwrota%'
  ORDER BY j.jobname, r.start_time DESC NULLS LAST;
END $function$;

-- Lock down EXECUTE grants: no PUBLIC, no anon, no authenticated on the
-- sync/cron RPCs. Only admins (who present as `authenticated` at the DB
-- level) are permitted, and the in-body has_role check enforces it.
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync_rate_limited(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trigger_clwrota_sync_all_rate_limited() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_clwrota_cron_runs(integer) FROM PUBLIC, anon;

-- Allow authenticated (needed so admin users can call them via PostgREST);
-- the in-body has_role check is the real gate.
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync_rate_limited(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync_with_query(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_clwrota_sync_all_rate_limited() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_clwrota_cron_runs(integer) TO authenticated, service_role;