
-- Add reserve_listed_at to leave_requests
ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS reserve_listed_at timestamptz;

-- Rota change log
CREATE TABLE IF NOT EXISTS public.rota_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid,
  action text NOT NULL,
  session_date date NOT NULL,
  session session_half NOT NULL,
  staff_id uuid,
  session_start_ts timestamptz NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  hours_before_session numeric NOT NULL,
  changed_by uuid
);

ALTER TABLE public.rota_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coords/admins read rota change log"
ON public.rota_change_log FOR SELECT TO authenticated
USING (public.current_user_is_coordinator_or_admin());

CREATE INDEX IF NOT EXISTS idx_rota_change_log_changed_at
  ON public.rota_change_log(changed_at DESC);

-- helper: compute session start timestamp (Europe/London local 08:00 AM, 13:00 PM)
CREATE OR REPLACE FUNCTION public.session_start_ts(p_date date, p_session session_half)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_date::timestamp + CASE WHEN p_session = 'am'
            THEN time '08:00' ELSE time '13:00' END) AT TIME ZONE 'Europe/London'
$$;

-- trigger function: log when change happens within 24h of session start
CREATE OR REPLACE FUNCTION public.log_late_rota_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_action text;
  v_start timestamptz;
  v_hours numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_action := 'delete';
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_action := 'insert';
  ELSE
    v_row := NEW;
    v_action := 'update';
  END IF;

  v_start := public.session_start_ts(v_row.session_date, v_row.session);
  v_hours := EXTRACT(EPOCH FROM (v_start - now())) / 3600.0;

  IF v_hours <= 24 AND v_hours >= -24 THEN
    INSERT INTO public.rota_change_log
      (assignment_id, action, session_date, session, staff_id,
       session_start_ts, hours_before_session, changed_by)
    VALUES
      (v_row.id, v_action, v_row.session_date, v_row.session, v_row.staff_id,
       v_start, v_hours, auth.uid());
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_late_rota_change ON public.rota_assignments;
CREATE TRIGGER trg_log_late_rota_change
AFTER INSERT OR UPDATE OR DELETE ON public.rota_assignments
FOR EACH ROW EXECUTE FUNCTION public.log_late_rota_change();

REVOKE EXECUTE ON FUNCTION public.log_late_rota_change() FROM PUBLIC, anon, authenticated;
