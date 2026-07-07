CREATE TABLE public.leave_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  action text NOT NULL,
  prev_status text,
  new_status text,
  prev_start_date date,
  new_start_date date,
  prev_end_date date,
  new_end_date date,
  prev_type text,
  new_type text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leave_change_log_staff_idx ON public.leave_change_log(staff_id);
CREATE INDEX leave_change_log_changed_at_idx ON public.leave_change_log(changed_at DESC);

GRANT SELECT ON public.leave_change_log TO authenticated;
GRANT ALL ON public.leave_change_log TO service_role;

ALTER TABLE public.leave_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own leave change log"
  ON public.leave_change_log FOR SELECT
  TO authenticated
  USING (auth.uid() = staff_id OR public.current_user_is_coordinator_or_admin());

CREATE OR REPLACE FUNCTION public.log_leave_request_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_row record;
  v_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_action := 'delete';
    v_row := OLD;
    v_changed := true;
  ELSIF TG_OP = 'INSERT' THEN
    v_action := 'insert';
    v_row := NEW;
    v_changed := true;
  ELSE
    v_action := 'update';
    v_row := NEW;
    v_changed :=
      (OLD.status         IS DISTINCT FROM NEW.status)         OR
      (OLD.start_date     IS DISTINCT FROM NEW.start_date)     OR
      (OLD.end_date       IS DISTINCT FROM NEW.end_date)       OR
      (OLD.half_day_start IS DISTINCT FROM NEW.half_day_start) OR
      (OLD.half_day_end   IS DISTINCT FROM NEW.half_day_end)   OR
      (OLD.type           IS DISTINCT FROM NEW.type)           OR
      (OLD.decision_notes IS DISTINCT FROM NEW.decision_notes);
  END IF;

  IF NOT v_changed THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO public.leave_change_log (
    leave_request_id, staff_id, action,
    prev_status, new_status,
    prev_start_date, new_start_date,
    prev_end_date, new_end_date,
    prev_type, new_type,
    changed_by
  ) VALUES (
    v_row.id, v_row.staff_id, v_action,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.status::text END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.status::text END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.start_date END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.start_date END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.end_date END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.end_date END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.type::text END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.type::text END,
    auth.uid()
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER leave_requests_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.leave_requests
FOR EACH ROW EXECUTE FUNCTION public.log_leave_request_change();

-- Extend push_notification_log so it can reference leave changes instead of rota changes.
ALTER TABLE public.push_notification_log
  ALTER COLUMN change_log_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS leave_change_log_id uuid REFERENCES public.leave_change_log(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS push_notification_log_leave_unique
  ON public.push_notification_log(leave_change_log_id, subscription_id)
  WHERE leave_change_log_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_notification_log_leave_idx
  ON public.push_notification_log(leave_change_log_id);