-- Security follow-up 2026-11-01
-- 1. Leave guards must run BEFORE the encryption trigger (Postgres fires
--    same-timing triggers alphabetically), reject direct writes to encrypted
--    shadow columns, and protect created_at / study cost / import bookkeeping.
CREATE OR REPLACE FUNCTION public.enforce_leave_request_insert_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_coord boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF NEW.reason_enc IS NOT NULL OR NEW.decision_notes_enc IS NOT NULL OR NEW.conflict_notes_enc IS NOT NULL THEN
    RAISE EXCEPTION 'Encrypted fields are server-managed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := now();
  NEW.updated_at := now();
  v_coord := public.current_user_is_coordinator_or_admin();
  IF v_uid = NEW.staff_id OR NOT v_coord THEN
    IF COALESCE(NEW.status, 'pending') <> 'pending' THEN
      RAISE EXCEPTION 'New leave requests must start as pending.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.decision_notes IS NOT NULL
       OR NEW.reserve_listed_at IS NOT NULL OR NEW.clwrota_external_id IS NOT NULL OR NEW.study_cost_gbp IS NOT NULL THEN
      RAISE EXCEPTION 'Decision and import fields cannot be set when requesting leave.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.status := 'pending';
  ELSE
    IF NEW.clwrota_external_id IS NOT NULL THEN
      RAISE EXCEPTION 'Import identifiers are set by the rota sync only.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IN ('approved', 'rejected') THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
    ELSE
      NEW.decided_by := NULL;
      NEW.decided_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_leave_request_update_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_coord boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  -- This trigger runs before leave_requests_sync_encryption, so any change to
  -- a ciphertext column here came from the caller, not from the encryption sync.
  IF NEW.reason_enc IS DISTINCT FROM OLD.reason_enc
     OR NEW.decision_notes_enc IS DISTINCT FROM OLD.decision_notes_enc
     OR NEW.conflict_notes_enc IS DISTINCT FROM OLD.conflict_notes_enc THEN
    RAISE EXCEPTION 'Encrypted fields are server-managed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.clwrota_external_id IS DISTINCT FROM OLD.clwrota_external_id
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Record identity and import fields cannot be changed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_is_coord := public.current_user_is_coordinator_or_admin();

  IF v_uid = OLD.staff_id THEN
    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('pending','cancelled'))
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_notes IS DISTINCT FROM OLD.decision_notes
       OR NEW.reserve_listed_at IS DISTINCT FROM OLD.reserve_listed_at
       OR NEW.study_cost_gbp IS DISTINCT FROM OLD.study_cost_gbp
    THEN
      RAISE EXCEPTION 'You cannot approve, deny, or modify decision fields on your own leave request.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
      RAISE EXCEPTION 'Cannot reassign leave request to another staff member.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'pending' THEN
      IF NEW.status IS DISTINCT FROM 'cancelled'
         OR NEW.start_date IS DISTINCT FROM OLD.start_date
         OR NEW.end_date IS DISTINCT FROM OLD.end_date
         OR NEW.half_day_start IS DISTINCT FROM OLD.half_day_start
         OR NEW.half_day_end IS DISTINCT FROM OLD.half_day_end
         OR NEW.type IS DISTINCT FROM OLD.type
         OR NEW.reason IS DISTINCT FROM OLD.reason
      THEN
        RAISE EXCEPTION 'A decided leave request can only be cancelled by its owner.' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NOT v_is_coord AND NEW.conflict_notes IS DISTINCT FROM OLD.conflict_notes THEN
      RAISE EXCEPTION 'Conflict notes are maintained by coordinators.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF v_is_coord THEN
    IF NEW.staff_id IS DISTINCT FROM OLD.staff_id THEN
      RAISE EXCEPTION 'Cannot reassign leave request to another staff member.' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
      NEW.decided_by := v_uid;
      NEW.decided_at := now();
    ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Decision metadata is recorded automatically.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_leave_request_insert_rules ON public.leave_requests;
DROP TRIGGER IF EXISTS trg_enforce_leave_request_update_rules ON public.leave_requests;
DROP TRIGGER IF EXISTS a10_enforce_leave_request_insert_rules ON public.leave_requests;
DROP TRIGGER IF EXISTS a10_enforce_leave_request_update_rules ON public.leave_requests;
-- "a10_" sorts before "leave_requests_sync_encryption" and "leave_requests_updated_at".
CREATE TRIGGER a10_enforce_leave_request_insert_rules
  BEFORE INSERT ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_leave_request_insert_rules();
CREATE TRIGGER a10_enforce_leave_request_update_rules
  BEFORE UPDATE ON public.leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_leave_request_update_rules();

-- 2. Profiles: calendar_feed_token is server-owned (random, minted by the
--    server function with the service role). Owners may only change full_name.
CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR public.has_role(v_uid, 'admin') THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.email_enc IS DISTINCT FROM OLD.email_enc
     OR NEW.email_hash IS DISTINCT FROM OLD.email_hash
     OR NEW.grade IS DISTINCT FROM OLD.grade
     OR NEW.training_level IS DISTINCT FROM OLD.training_level
     OR NEW.gmc_number IS DISTINCT FROM OLD.gmc_number
     OR NEW.gmc_number_enc IS DISTINCT FROM OLD.gmc_number_enc
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.clwrota_external_id IS DISTINCT FROM OLD.clwrota_external_id
     OR NEW.rotation_end_date IS DISTINCT FROM OLD.rotation_end_date
     OR NEW.ltft_days_off IS DISTINCT FROM OLD.ltft_days_off
     OR NEW.left_at IS DISTINCT FROM OLD.left_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.calendar_feed_token IS DISTINCT FROM OLD.calendar_feed_token
  THEN
    RAISE EXCEPTION 'Only your display name can be changed from your own profile.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- 3. Audit SQL wrapper: bounded runtime, no config/search_path pivots, no
--    pg_net references (net has PUBLIC USAGE granted by the platform owner,
--    which project migrations cannot revoke). Read-only remains forced.
CREATE OR REPLACE FUNCTION public.admin_run_readonly_sql(p_query text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_q text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admin role required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('transaction_read_only', 'on', true);
  PERFORM set_config('statement_timeout', '8000', true);
  PERFORM set_config('lock_timeout', '1000', true);
  PERFORM set_config('idle_in_transaction_session_timeout', '10000', true);
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'admin_run_readonly_sql must run in a read-only transaction' USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  v_q := regexp_replace(btrim(coalesce(p_query, '')), '[;\s]+$', '');
  IF v_q = '' THEN RAISE EXCEPTION 'Empty query'; END IF;
  IF length(v_q) > 8000 THEN RAISE EXCEPTION 'Query too long'; END IF;
  IF position(';' in v_q) > 0 THEN RAISE EXCEPTION 'Multiple statements are not permitted'; END IF;
  -- Defense in depth only; role privileges + forced read-only are the boundary.
  IF v_q ~* '(set_config|pg_sleep|dblink|lo_import|lo_export|pg_notify|"?net"?\s*\.|worker_restart|\mwake\M|pg_terminate|pg_cancel|pg_reload)' THEN
    RAISE EXCEPTION 'Query uses a function that is not available to audit reports';
  END IF;
  RETURN audit_ro.exec_select(v_q);
END $$;
REVOKE ALL ON FUNCTION public.admin_run_readonly_sql(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_run_readonly_sql(text) TO authenticated, service_role;

-- 4. Passkeys: bind each ceremony to a random challenge row id, consumed once.
CREATE OR REPLACE FUNCTION public.consume_passkey_challenge_by_id(p_id uuid, p_purpose text)
RETURNS TABLE(challenge text, user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.passkey_challenges c
   WHERE c.id = p_id AND c.purpose = p_purpose AND c.expires_at > now()
  RETURNING c.challenge, c.user_id;
$$;
REVOKE ALL ON FUNCTION public.consume_passkey_challenge_by_id(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_passkey_challenge_by_id(uuid, text) TO service_role;
-- Credentials are only written by the server after WebAuthn verification.
DROP POLICY IF EXISTS "Users insert own passkeys" ON public.passkey_credentials;
DROP POLICY IF EXISTS "Users update own passkeys" ON public.passkey_credentials;
REVOKE INSERT, UPDATE ON public.passkey_credentials FROM authenticated, anon;

-- 5. Durable quotas (access requests, chat). Server-only.
CREATE TABLE IF NOT EXISTS public.request_quota_buckets (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
GRANT ALL ON public.request_quota_buckets TO service_role;
ALTER TABLE public.request_quota_buckets ENABLE ROW LEVEL SECURITY;

-- Atomically add one hit (and bytes) to every bucket; returns false (and adds
-- nothing) if any bucket would exceed its limit. Buckets: text[] of
-- 'key|window_seconds|max_hits|max_bytes'.
CREATE OR REPLACE FUNCTION public.take_request_quota(p_buckets text[], p_bytes bigint DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b text; parts text[]; v_key text; v_win int; v_max int; v_maxb bigint; v_start timestamptz; v_hits int; v_bytes bigint;
BEGIN
  IF p_buckets IS NULL OR array_length(p_buckets, 1) IS NULL OR array_length(p_buckets, 1) > 8 THEN
    RAISE EXCEPTION 'invalid buckets';
  END IF;
  FOREACH b IN ARRAY p_buckets LOOP
    parts := string_to_array(b, '|');
    v_key := parts[1]; v_win := parts[2]::int; v_max := parts[3]::int; v_maxb := coalesce(nullif(parts[4], '')::bigint, 0);
    v_start := to_timestamp(floor(extract(epoch FROM now()) / v_win) * v_win);
    INSERT INTO request_quota_buckets(bucket, window_start) VALUES (v_key, v_start) ON CONFLICT DO NOTHING;
    SELECT hits, bytes INTO v_hits, v_bytes FROM request_quota_buckets WHERE bucket = v_key AND window_start = v_start FOR UPDATE;
    IF v_hits + 1 > v_max OR (v_maxb > 0 AND v_bytes + p_bytes > v_maxb) THEN
      RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0429';
    END IF;
    UPDATE request_quota_buckets SET hits = hits + 1, bytes = bytes + p_bytes WHERE bucket = v_key AND window_start = v_start;
  END LOOP;
  DELETE FROM request_quota_buckets WHERE window_start < now() - interval '2 days';
  RETURN true;
EXCEPTION WHEN SQLSTATE 'P0429' THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.take_request_quota(text[], bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_request_quota(text[], bigint) TO service_role;
