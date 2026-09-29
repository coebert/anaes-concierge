CREATE OR REPLACE FUNCTION public.preserve_rota_pa_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.pa_credit IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.pa_credit IS NOT NULL THEN
      NEW.pa_credit := OLD.pa_credit;
    ELSIF NEW.duty_type IN ('icu_consultant_oncall','icu_ct2_plus','icu_trainee') THEN
      SELECT m.pa_credit INTO NEW.pa_credit
      FROM public.icu_detection_matches m
      WHERE m.staff_id = NEW.staff_id AND m.session_date = NEW.session_date
        AND m.session = NEW.session AND m.pa_credit IS NOT NULL
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.preserve_rota_pa_credit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_preserve_rota_pa_credit ON public.rota_assignments;
CREATE TRIGGER trg_preserve_rota_pa_credit BEFORE INSERT OR UPDATE ON public.rota_assignments
FOR EACH ROW EXECUTE FUNCTION public.preserve_rota_pa_credit();

UPDATE public.rota_assignments r
SET pa_credit = m.pa_credit
FROM public.icu_detection_matches m
WHERE r.pa_credit IS NULL
  AND r.duty_type IN ('icu_consultant_oncall','icu_ct2_plus','icu_trainee')
  AND m.staff_id = r.staff_id AND m.session_date = r.session_date
  AND m.session = r.session AND m.pa_credit IS NOT NULL;