CREATE OR REPLACE FUNCTION public.enforce_specialty_preference_offered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  SELECT name INTO v_name FROM public.specialties WHERE id = NEW.specialty_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Unknown specialty_id %', NEW.specialty_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_name ~* '(vascular|cardiac|cardio-?thoracic)' THEN
    RAISE EXCEPTION 'Specialty "%" is not offered at SDH and cannot be saved as a practice preference.', v_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_specialty_preference_offered ON public.staff_specialty_preferences;
CREATE TRIGGER enforce_specialty_preference_offered
BEFORE INSERT OR UPDATE ON public.staff_specialty_preferences
FOR EACH ROW
EXECUTE FUNCTION public.enforce_specialty_preference_offered();

-- Clean up any pre-existing preference rows for filtered-out specialties.
DELETE FROM public.staff_specialty_preferences
 WHERE specialty_id IN (
   SELECT id FROM public.specialties
    WHERE name ~* '(vascular|cardiac|cardio-?thoracic)'
 );