-- 1) Extend session enum with evening and night slots for on-call duties
ALTER TYPE public.session_half ADD VALUE IF NOT EXISTS 'eve';
ALTER TYPE public.session_half ADD VALUE IF NOT EXISTS 'night';

-- 2) New enum for duty type (theatre vs. various on-call / supervisory roles)
DO $$ BEGIN
  CREATE TYPE public.duty_type AS ENUM (
    'theatre',
    'consultant_in_charge',
    'obstetrics',
    'obstetrics_2nd',
    'icu_trainee',
    'icu_ct2_plus',
    'icu_consultant_oncall',
    'general_consultant_oncall',
    'registrar_oncall',
    'sho_oncall'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Add duty_type column to rota_assignments (default 'theatre' for existing rows)
ALTER TABLE public.rota_assignments
  ADD COLUMN IF NOT EXISTS duty_type public.duty_type NOT NULL DEFAULT 'theatre';

CREATE INDEX IF NOT EXISTS idx_rota_assignments_duty
  ON public.rota_assignments(session_date, duty_type, session);

-- 4) Update late-change logger so non-theatre / eve / night duties don't compute bogus session start times
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
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD; v_action := 'delete';
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW; v_action := 'insert';
  ELSE
    v_row := NEW; v_action := 'update';
  END IF;

  -- Only log late changes for theatre AM/PM sessions (fixed start times).
  IF v_row.duty_type <> 'theatre' OR v_row.session NOT IN ('am','pm') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
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
$function$;