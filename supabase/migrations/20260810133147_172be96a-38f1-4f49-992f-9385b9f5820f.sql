DROP POLICY IF EXISTS "Authenticated can read practice preferences" ON public.staff_practice_preferences;
CREATE POLICY "Own or coordinator can read practice preferences"
  ON public.staff_practice_preferences FOR SELECT TO authenticated
  USING (staff_id = auth.uid() OR public.current_user_is_coordinator_or_admin());

DROP POLICY IF EXISTS "Authenticated can read specialty preferences" ON public.staff_specialty_preferences;
CREATE POLICY "Own or coordinator can read specialty preferences"
  ON public.staff_specialty_preferences FOR SELECT TO authenticated
  USING (staff_id = auth.uid() OR public.current_user_is_coordinator_or_admin());