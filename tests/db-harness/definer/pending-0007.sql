-- 0007: replace the SECURITY DEFINER "service exemption" that tested
-- current_user / pg_has_role(current_user,'service_role','MEMBER').
-- Inside a SECURITY DEFINER function current_user is the OWNER (postgres),
-- and postgres is a member of service_role, so that test was always true and
-- every caller was treated as the service role.
--
-- Caller identity now comes only from facts the definer switch does not
-- change: the signed request claims (auth.role()/auth.uid()), the role GUC
-- set by PostgREST's SET LOCAL ROLE, and session_user.

-- Signed service_role request: JWT role claim AND the switched role agree.
-- A forged claim under the authenticated role does not qualify.
CREATE OR REPLACE FUNCTION public._request_is_service_role()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT coalesce(auth.role(), '') = 'service_role'
     AND coalesce(current_setting('role', true), '') = 'service_role'
$$;

-- Signed-in user request: uid present, JWT role authenticated, switched role
-- authenticated.
CREATE OR REPLACE FUNCTION public._request_is_authenticated_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND coalesce(auth.role(), '') = 'authenticated'
     AND coalesce(current_setting('role', true), '') = 'authenticated'
$$;

CREATE OR REPLACE FUNCTION public._request_is_active_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT public._request_is_authenticated_user()
     AND coalesce(public.has_role(auth.uid(), 'admin'), false)
$$;

-- Verified pg_cron identity: live cron.job.username is postgres, so a
-- scheduled job runs with session_user = postgres, no SET ROLE and no
-- request claims. A PostgREST request (session_user = authenticator) or a
-- postgres session that switched to authenticated/anon/service_role does not
-- qualify.
CREATE OR REPLACE FUNCTION public._request_is_verified_scheduler()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT session_user = 'postgres'
     AND coalesce(current_setting('role', true), 'none') IN ('none', 'postgres')
     AND coalesce(current_setting('request.jwt.claims', true), '') = ''
     AND coalesce(current_setting('request.jwt.claim.sub', true), '') = ''
     AND coalesce(current_setting('request.jwt.claim.role', true), '') = ''
$$;

-- Audit label for the real caller (never the definer owner).
CREATE OR REPLACE FUNCTION public._request_caller_kind()
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT CASE
    WHEN public._request_is_service_role() THEN 'service_role'
    WHEN public._request_is_verified_scheduler() THEN 'scheduler:postgres'
    WHEN public._request_is_authenticated_user() THEN 'authenticated'
    ELSE 'unverified:' || coalesce(nullif(current_setting('role', true), ''), 'none')
         || '@' || session_user::text
  END
$$;

REVOKE ALL ON FUNCTION public._request_is_service_role(), public._request_is_authenticated_user(),
  public._request_is_active_admin(), public._request_is_verified_scheduler(),
  public._request_caller_kind() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._request_is_service_role(), public._request_is_authenticated_user(),
  public._request_is_active_admin(), public._request_is_verified_scheduler(),
  public._request_caller_kind() TO service_role;

CREATE OR REPLACE FUNCTION public.decrypt_ai_message_parts(p_cipher bytea, p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF public._request_is_service_role() THEN
    RETURN public.decrypt_jsonb(p_cipher);
  END IF;
  IF NOT public._request_is_authenticated_user() THEN RETURN NULL; END IF;
  SELECT user_id INTO v_owner FROM public.ai_conversations WHERE id = p_conversation_id;
  IF (v_owner IS NOT NULL AND auth.uid() = v_owner AND public.is_app_member(auth.uid()))
     OR public.current_user_is_coordinator_or_admin() THEN
    RETURN public.decrypt_jsonb(p_cipher);
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.decrypt_owner_or_coord(p_cipher bytea, p_owner uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF public._request_is_service_role()
     OR (public._request_is_authenticated_user()
         AND ((p_owner IS NOT NULL AND auth.uid() = p_owner AND public.is_app_member(auth.uid()))
              OR public.current_user_is_coordinator_or_admin())) THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.decrypt_coord_only(p_cipher bytea)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  IF public._request_is_service_role()
     OR (public._request_is_authenticated_user()
         AND public.current_user_is_coordinator_or_admin()) THEN
    RETURN public.decrypt_text(p_cipher);
  END IF;
  RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.admin_decrypt_text(p_cipher bytea)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._request_is_service_role() THEN
    RAISE EXCEPTION 'admin_decrypt_text requires service_role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.decrypt_text(p_cipher);
END $function$;
CREATE OR REPLACE FUNCTION public.admin_decrypt_jsonb(p_cipher bytea)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public._request_is_service_role() THEN
    RAISE EXCEPTION 'admin_decrypt_jsonb requires service_role' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.decrypt_jsonb(p_cipher);
END $function$;

CREATE OR REPLACE FUNCTION public.detect_rpc_access_anomalies(p_window_minutes integer DEFAULT 10, p_threshold integer DEFAULT 50)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin BOOLEAN;
  v_window_start TIMESTAMPTZ := now() - make_interval(mins => p_window_minutes);
  v_window_end TIMESTAMPTZ := now();
  v_inserted INTEGER := 0;
  v_bucket TIMESTAMPTZ := date_trunc('minute', v_window_start);
BEGIN
  -- Allow service_role or admins only.
  IF NOT public._request_is_service_role() THEN
    SELECT public._request_is_active_admin() INTO v_is_admin;
    IF NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'detect_rpc_access_anomalies requires admin or service_role'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- 1) Threshold-exceeded alerts (per caller, per RPC).
  WITH counts AS (
    SELECT rpc_name, called_by, COUNT(*)::int AS calls,
           MIN(called_at) AS first_call, MAX(called_at) AS last_call
      FROM public.rpc_access_audit
     WHERE called_at >= v_window_start
     GROUP BY rpc_name, called_by
    HAVING COUNT(*) > p_threshold
  ),
  ins AS (
    INSERT INTO public.rpc_access_alerts
      (alert_type, rpc_name, subject_user, window_start, window_end, call_count, threshold, details)
    SELECT 'threshold_exceeded', c.rpc_name, c.called_by,
           v_bucket, v_window_end, c.calls, p_threshold,
           jsonb_build_object('first_call', c.first_call, 'last_call', c.last_call,
                              'window_minutes', p_window_minutes)
      FROM counts c
    ON CONFLICT (alert_type, rpc_name, COALESCE(subject_user, '00000000-0000-0000-0000-000000000000'::uuid), window_start)
    DO NOTHING
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*), 0)::int INTO v_inserted FROM ins;

  -- 2) Unexpected-user alerts: caller lacks admin/rota_coordinator role and
  -- is not service_role (called_by IS NULL means the DB role was
  -- service_role/postgres — safe).
  WITH offenders AS (
    SELECT DISTINCT a.rpc_name, a.called_by,
           MIN(a.called_at) AS first_call, MAX(a.called_at) AS last_call,
           COUNT(*)::int AS calls
      FROM public.rpc_access_audit a
     WHERE a.called_at >= v_window_start
       AND a.called_by IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.user_roles r
          WHERE r.user_id = a.called_by
            AND r.role IN ('admin','rota_coordinator')
       )
     GROUP BY a.rpc_name, a.called_by
  ),
  ins2 AS (
    INSERT INTO public.rpc_access_alerts
      (alert_type, rpc_name, subject_user, window_start, window_end, call_count, threshold, details)
    SELECT 'unexpected_user', o.rpc_name, o.called_by,
           v_bucket, v_window_end, o.calls, NULL,
           jsonb_build_object('first_call', o.first_call, 'last_call', o.last_call,
                              'reason', 'caller lacks admin or rota_coordinator role',
                              'window_minutes', p_window_minutes)
      FROM offenders o
    ON CONFLICT (alert_type, rpc_name, COALESCE(subject_user, '00000000-0000-0000-0000-000000000000'::uuid), window_start)
    DO NOTHING
    RETURNING 1
  )
  SELECT v_inserted + COALESCE(COUNT(*), 0)::int INTO v_inserted FROM ins2;

  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_ai_messages_decrypted(p_conversation_id uuid)
 RETURNS TABLE(id uuid, conversation_id uuid, user_id uuid, role chat_role, parts jsonb, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT m.id, m.conversation_id, m.user_id, m.role,
    public.decrypt_ai_message_parts(m.parts_enc, m.conversation_id),
    m.created_at
  FROM public.ai_messages m
  JOIN public.ai_conversations c ON c.id = m.conversation_id
  WHERE m.conversation_id = p_conversation_id
    AND (public._request_is_service_role()
         OR (public._request_is_authenticated_user()
             AND ((c.user_id = auth.uid() AND public.is_app_member(auth.uid()))
                  OR public.current_user_is_coordinator_or_admin())))
  ORDER BY m.created_at ASC
$function$;

CREATE OR REPLACE FUNCTION public.get_competency_eligibility(p_on_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(specialty_id uuid, specialty_name text, staff_id uuid, full_name text, grade staff_grade, eligible_solo boolean, eligible_supervising boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- 0007: signed service_role request, or a signed-in ACTIVE member.
  IF NOT (public._request_is_service_role()
          OR (public._request_is_authenticated_user() AND public.is_app_member(auth.uid()))) THEN
    RAISE EXCEPTION 'get_competency_eligibility requires an active member'
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

CREATE OR REPLACE FUNCTION public.get_rtw_interviews_decrypted()
 RETURNS TABLE(id uuid, leave_request_id uuid, staff_id uuid, conducted_by uuid, conducted_at timestamp with time zone, fitness_confirmed boolean, reasonable_adjustments text, follow_up_required boolean, follow_up_date date, notes text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT r.id, r.leave_request_id, r.staff_id, r.conducted_by, r.conducted_at,
    r.fitness_confirmed,
    public.decrypt_owner_or_coord(r.reasonable_adjustments_enc, r.staff_id),
    r.follow_up_required, r.follow_up_date,
    public.decrypt_owner_or_coord(r.notes_enc, r.staff_id),
    r.created_at, r.updated_at
  FROM public.return_to_work_interviews r
  WHERE public._request_is_service_role()
     OR (public._request_is_authenticated_user()
         AND ((r.staff_id = auth.uid() AND public.is_app_member(auth.uid()))
              OR public.current_user_is_coordinator_or_admin()));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_rtw_interviews_decrypted', v_rows, NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_clwrota_cron_runs(p_limit integer DEFAULT 50)
 RETURNS TABLE(jobname text, schedule text, active boolean, runid bigint, start_time timestamp with time zone, end_time timestamp with time zone, status text, return_message text, command text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
BEGIN
  -- 0007: service path = signed service_role request; user path = active admin.
  IF NOT (public._request_is_service_role() OR public._request_is_active_admin()) THEN
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

CREATE OR REPLACE FUNCTION public.log_rpc_access(p_rpc_name text, p_row_count integer, p_args jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.rpc_access_audit
    (rpc_name, called_by, db_role, row_count, args)
  VALUES
    (p_rpc_name, auth.uid(), public._request_caller_kind(), p_row_count, p_args);
EXCEPTION WHEN OTHERS THEN
  -- Auditing must never break the underlying RPC. Swallow errors
  -- but leave a NOTICE in the Postgres logs for observability.
  RAISE NOTICE 'log_rpc_access failed: %', SQLERRM;
END;
$function$;

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
  -- 0007: service path = signed service_role request; scheduled path = verified
  -- pg_cron identity (session_user postgres, no role switch, no request claims);
  -- user path = active admin.
  IF NOT (public._request_is_service_role()
          OR public._request_is_verified_scheduler()
          OR public._request_is_active_admin()) THEN
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
  -- 0007: service path = signed service_role request; scheduled path = verified
  -- pg_cron identity (session_user postgres, no role switch, no request claims);
  -- user path = active admin.
  IF NOT (public._request_is_service_role()
          OR public._request_is_verified_scheduler()
          OR public._request_is_active_admin()) THEN
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
  -- 0007: service path = signed service_role request; user path = active admin.
  IF NOT (public._request_is_service_role() OR public._request_is_active_admin()) THEN
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
  -- 0007: service path = signed service_role request; user path = active admin.
  IF NOT (public._request_is_service_role() OR public._request_is_active_admin()) THEN
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

-- Grants (restated; CREATE OR REPLACE keeps ACLs, this makes them explicit).
REVOKE ALL ON FUNCTION
  public.decrypt_ai_message_parts(bytea, uuid), public.decrypt_owner_or_coord(bytea, uuid),
  public.decrypt_coord_only(bytea), public.admin_decrypt_text(bytea), public.admin_decrypt_jsonb(bytea),
  public.log_rpc_access(text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.decrypt_ai_message_parts(bytea, uuid), public.decrypt_owner_or_coord(bytea, uuid),
  public.decrypt_coord_only(bytea), public.admin_decrypt_text(bytea), public.admin_decrypt_jsonb(bytea),
  public.log_rpc_access(text, integer, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION
  public.detect_rpc_access_anomalies(integer, integer), public.get_ai_messages_decrypted(uuid),
  public.get_competency_eligibility(date), public.get_rtw_interviews_decrypted(),
  public.list_clwrota_cron_runs(integer), public.trigger_clwrota_sync(text),
  public.trigger_clwrota_sync_with_query(text, text), public.trigger_clwrota_sync_rate_limited(text),
  public.trigger_clwrota_sync_all_rate_limited()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.detect_rpc_access_anomalies(integer, integer), public.get_ai_messages_decrypted(uuid),
  public.get_competency_eligibility(date), public.get_rtw_interviews_decrypted(),
  public.list_clwrota_cron_runs(integer), public.trigger_clwrota_sync(text),
  public.trigger_clwrota_sync_with_query(text, text), public.trigger_clwrota_sync_rate_limited(text),
  public.trigger_clwrota_sync_all_rate_limited()
  TO authenticated, service_role;
