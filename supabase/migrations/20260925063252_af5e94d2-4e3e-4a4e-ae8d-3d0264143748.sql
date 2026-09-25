CREATE OR REPLACE FUNCTION public.is_app_member(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id)
$$;
REVOKE EXECUTE ON FUNCTION public.is_app_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_member(uuid) TO authenticated, service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('fixed_sessions','Authenticated can read fixed sessions'),
    ('theatre_name_aliases','Authenticated can view theatre name aliases'),
    ('duty_type_pool_rules','Authenticated can read duty_type pool rules'),
    ('theatres','Authenticated can read theatres'),
    ('specialty_competency_requirements','spec_comp_req_select_authenticated'),
    ('theatre_sessions','Authenticated can read theatre sessions'),
    ('arcp_requirements','Signed-in can read requirements'),
    ('specialties','Authenticated can read specialties'),
    ('trainee_targets','Authenticated can read trainee targets'),
    ('competencies','competencies_select_authenticated'),
    ('validation_custom_non_working_labels','Authenticated can read custom non-working labels'),
    ('rota_assignments','Authenticated can read rota'),
    ('duty_type_mappings','Authenticated can read duty type mappings'),
    ('rota_rules','Authenticated read rota rules'),
    ('pulse_survey_cycles','Anyone signed-in reads cycles')
  ) AS t(tbl, pol)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.pol, r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_app_member(auth.uid()))', r.pol, r.tbl);
  END LOOP;
END $$;