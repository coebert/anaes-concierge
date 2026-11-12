-- Synthetic rota_assignments in the live shape used by 0011 (unique CLWRota
-- key, live read/manage policies). Run as postgres so postgres OWNS it.
-- Never run against a real database. All data are synthetic.
CREATE TABLE public.rota_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date date NOT NULL,
  staff_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'clwrota',
  clwrota_external_id text UNIQUE,
  notes text,
  locally_modified boolean NOT NULL DEFAULT false
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rota_assignments TO authenticated;
GRANT ALL ON public.rota_assignments TO service_role;
ALTER TABLE public.rota_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read rota" ON public.rota_assignments FOR SELECT TO authenticated USING (public.is_app_member(auth.uid()));
CREATE POLICY "Coords/admins manage rota" ON public.rota_assignments FOR ALL TO authenticated
  USING (public.current_user_is_coordinator_or_admin()) WITH CHECK (public.current_user_is_coordinator_or_admin());
GRANT SELECT ON public.profiles, public.user_roles TO authenticated;
CREATE POLICY self_read_profile ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY self_read_roles ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
INSERT INTO public.rota_assignments (id, session_date, staff_id, clwrota_external_id, notes) VALUES
 ('90000000-0000-0000-0000-000000000001','2030-01-07','00000000-0000-0000-0000-0000000000a1','k1','legacy note'),
 ('90000000-0000-0000-0000-000000000002','2030-01-07','00000000-0000-0000-0000-0000000000b2','k2',NULL),
 ('90000000-0000-0000-0000-000000000003','2030-01-08','00000000-0000-0000-0000-0000000000a1','k3',NULL);
