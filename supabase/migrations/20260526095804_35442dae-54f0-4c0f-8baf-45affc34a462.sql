
CREATE OR REPLACE FUNCTION public.enforce_trainee_rotation_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
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

REVOKE EXECUTE ON FUNCTION public.enforce_trainee_rotation_end() FROM PUBLIC, anon, authenticated;
