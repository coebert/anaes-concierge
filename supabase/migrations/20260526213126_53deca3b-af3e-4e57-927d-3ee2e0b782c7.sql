
CREATE OR REPLACE FUNCTION public.log_late_rota_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_action text;
  v_start timestamptz;
  v_hours numeric;
  v_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD; v_action := 'delete'; v_changed := true;
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW; v_action := 'insert'; v_changed := true;
  ELSE
    v_row := NEW; v_action := 'update';
    -- Only treat as a real change if the allocation actually differs.
    v_changed :=
      (OLD.staff_id        IS DISTINCT FROM NEW.staff_id) OR
      (OLD.supervisor_id   IS DISTINCT FROM NEW.supervisor_id) OR
      (OLD.role_on_list    IS DISTINCT FROM NEW.role_on_list) OR
      (OLD.duty_type       IS DISTINCT FROM NEW.duty_type) OR
      (OLD.session         IS DISTINCT FROM NEW.session) OR
      (OLD.session_date    IS DISTINCT FROM NEW.session_date) OR
      (OLD.theatre_session_id IS DISTINCT FROM NEW.theatre_session_id);
  END IF;

  IF NOT v_changed THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Only log late changes for theatre AM/PM sessions (fixed start times).
  IF v_row.duty_type <> 'theatre' OR v_row.session NOT IN ('am','pm') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_start := public.session_start_ts(v_row.session_date, v_row.session);
  v_hours := EXTRACT(EPOCH FROM (v_start - now())) / 3600.0;

  -- Only log changes made within 24 hours of the session start time.
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
$function$;
