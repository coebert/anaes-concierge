
-- 1) Audit table
CREATE TABLE public.rpc_access_audit (
  id BIGSERIAL PRIMARY KEY,
  rpc_name TEXT NOT NULL,
  called_by UUID,
  db_role TEXT NOT NULL DEFAULT current_user,
  row_count INTEGER,
  args JSONB,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rpc_access_audit_called_at_idx
  ON public.rpc_access_audit (called_at DESC);
CREATE INDEX rpc_access_audit_rpc_name_idx
  ON public.rpc_access_audit (rpc_name, called_at DESC);
CREATE INDEX rpc_access_audit_called_by_idx
  ON public.rpc_access_audit (called_by, called_at DESC);

-- Client roles cannot touch the table directly; SECURITY DEFINER
-- functions insert on their behalf. service_role keeps full access
-- for server-side admin reads.
GRANT SELECT ON public.rpc_access_audit TO authenticated;
GRANT ALL ON public.rpc_access_audit TO service_role;

ALTER TABLE public.rpc_access_audit ENABLE ROW LEVEL SECURITY;

-- Only admins can read audit rows via PostgREST.
CREATE POLICY "Admins can read rpc access audit"
  ON public.rpc_access_audit
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 2) Helper: insert an audit row. SECURITY DEFINER so RPC callers
--    don't need direct INSERT privileges on the table.
CREATE OR REPLACE FUNCTION public.log_rpc_access(
  p_rpc_name TEXT,
  p_row_count INTEGER,
  p_args JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.rpc_access_audit
    (rpc_name, called_by, db_role, row_count, args)
  VALUES
    (p_rpc_name, auth.uid(), current_user, p_row_count, p_args);
EXCEPTION WHEN OTHERS THEN
  -- Auditing must never break the underlying RPC. Swallow errors
  -- but leave a NOTICE in the Postgres logs for observability.
  RAISE NOTICE 'log_rpc_access failed: %', SQLERRM;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_rpc_access(TEXT, INTEGER, JSONB)
  FROM PUBLIC, anon, authenticated;
-- Only other SECURITY DEFINER functions (running as owner) need to
-- call this; no direct client access.

-- 3) Rewrap the four decryption functions to log every invocation.

CREATE OR REPLACE FUNCTION public.get_profiles_decrypted()
 RETURNS TABLE(id uuid, email text, full_name text, grade staff_grade,
   training_level text, gmc_number text, start_date date, active boolean,
   clwrota_external_id text, rotation_end_date date, ltft_days_off text[],
   left_at date, calendar_feed_token text,
   created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT p.id,
    public.decrypt_owner_or_coord(p.email_enc, p.id),
    p.full_name, p.grade, p.training_level,
    public.decrypt_owner_or_coord(p.gmc_number_enc, p.id),
    p.start_date, p.active, p.clwrota_external_id, p.rotation_end_date,
    p.ltft_days_off, p.left_at, p.calendar_feed_token,
    p.created_at, p.updated_at
  FROM public.profiles p;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_profiles_decrypted', v_rows, NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_profile_decrypted(p_id uuid)
 RETURNS TABLE(id uuid, email text, full_name text, grade staff_grade,
   training_level text, gmc_number text, start_date date, active boolean,
   clwrota_external_id text, rotation_end_date date, ltft_days_off text[],
   left_at date, calendar_feed_token text,
   created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT p.id,
    public.decrypt_owner_or_coord(p.email_enc, p.id),
    p.full_name, p.grade, p.training_level,
    public.decrypt_owner_or_coord(p.gmc_number_enc, p.id),
    p.start_date, p.active, p.clwrota_external_id, p.rotation_end_date,
    p.ltft_days_off, p.left_at, p.calendar_feed_token,
    p.created_at, p.updated_at
  FROM public.profiles p
  WHERE p.id = p_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access(
    'get_profile_decrypted',
    v_rows,
    jsonb_build_object('p_id', p_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_access_requests_decrypted()
 RETURNS TABLE(id uuid, email text, full_name text, message text,
   status access_request_status, decided_at timestamp with time zone,
   decided_by uuid, decision_notes text,
   created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT a.id,
    public.decrypt_coord_only(a.email_enc),
    a.full_name, a.message, a.status,
    a.decided_at, a.decided_by, a.decision_notes, a.created_at
  FROM public.access_requests a;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_access_requests_decrypted', v_rows, NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_leave_requests_decrypted()
 RETURNS TABLE(id uuid, staff_id uuid, type leave_type, start_date date,
   end_date date, half_day_start session_half, half_day_end session_half,
   reason text, status leave_status, decided_by uuid,
   decided_at timestamp with time zone, decision_notes text,
   conflict_notes text, reserve_listed_at timestamp with time zone,
   clwrota_external_id text,
   created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  RETURN QUERY
  SELECT l.id, l.staff_id, l.type, l.start_date, l.end_date,
    l.half_day_start, l.half_day_end,
    public.decrypt_owner_or_coord(l.reason_enc, l.staff_id),
    l.status, l.decided_by, l.decided_at,
    public.decrypt_coord_only(l.decision_notes_enc),
    public.decrypt_coord_only(l.conflict_notes_enc),
    l.reserve_listed_at, l.clwrota_external_id,
    l.created_at, l.updated_at
  FROM public.leave_requests l;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public.log_rpc_access('get_leave_requests_decrypted', v_rows, NULL);
END;
$function$;

-- Keep the previously-tightened grants: only service_role can call these.
REVOKE EXECUTE ON FUNCTION public.get_access_requests_decrypted()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_leave_requests_decrypted()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_profiles_decrypted()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_profile_decrypted(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_access_requests_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_requests_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_profiles_decrypted() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_decrypted(uuid) TO service_role;
