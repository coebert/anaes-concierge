
CREATE TABLE public.rpc_access_alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('threshold_exceeded', 'unexpected_user')),
  rpc_name TEXT NOT NULL,
  subject_user UUID,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  call_count INTEGER NOT NULL,
  threshold INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rpc_access_alerts_created_at_idx ON public.rpc_access_alerts (created_at DESC);
CREATE INDEX rpc_access_alerts_unack_idx ON public.rpc_access_alerts (created_at DESC) WHERE acknowledged_at IS NULL;
CREATE UNIQUE INDEX rpc_access_alerts_dedupe_idx
  ON public.rpc_access_alerts (alert_type, rpc_name, COALESCE(subject_user, '00000000-0000-0000-0000-000000000000'::uuid), window_start);

GRANT SELECT, UPDATE ON public.rpc_access_alerts TO authenticated;
GRANT ALL ON public.rpc_access_alerts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.rpc_access_alerts_id_seq TO service_role;

ALTER TABLE public.rpc_access_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view alerts"
  ON public.rpc_access_alerts FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can acknowledge alerts"
  ON public.rpc_access_alerts FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Detection function. Runs as service_role via the cron hook; also callable
-- by admins on demand. Returns the number of new alerts inserted.
CREATE OR REPLACE FUNCTION public.detect_rpc_access_anomalies(
  p_window_minutes INTEGER DEFAULT 10,
  p_threshold INTEGER DEFAULT 50
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_window_start TIMESTAMPTZ := now() - make_interval(mins => p_window_minutes);
  v_window_end TIMESTAMPTZ := now();
  v_inserted INTEGER := 0;
  v_bucket TIMESTAMPTZ := date_trunc('minute', v_window_start);
BEGIN
  -- Allow service_role or admins only.
  IF current_user <> 'service_role'
     AND NOT pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    SELECT public.has_role(auth.uid(), 'admin') INTO v_is_admin;
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
$$;

REVOKE ALL ON FUNCTION public.detect_rpc_access_anomalies(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_rpc_access_anomalies(INTEGER, INTEGER) TO authenticated, service_role;
