
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS rotation_end_date date;

CREATE OR REPLACE FUNCTION public.enforce_trainee_rotation_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grade text;
  v_end date;
  v_name text;
BEGIN
  SELECT grade::text, rotation_end_date, full_name
    INTO v_grade, v_end, v_name
  FROM public.profiles
  WHERE id = NEW.staff_id;

  IF v_grade = 'trainee' AND v_end IS NOT NULL AND NEW.session_date > v_end THEN
    RAISE EXCEPTION 'Cannot assign trainee % to %: after their rotation end date (%).',
      COALESCE(v_name, NEW.staff_id::text), NEW.session_date, v_end
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_trainee_rotation_end ON public.rota_assignments;
CREATE TRIGGER trg_enforce_trainee_rotation_end
  BEFORE INSERT OR UPDATE OF staff_id, session_date
  ON public.rota_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trainee_rotation_end();
