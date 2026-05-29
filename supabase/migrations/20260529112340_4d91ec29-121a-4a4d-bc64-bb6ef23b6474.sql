-- Settings table letting admins decide how each duty_type affects the
-- robustness/headroom pool. Replaces the hard-coded sets in
-- src/lib/audit/robustness.ts so POAC, pain clinic, and any future
-- clinical activities can be classified without a code change.
--
-- Categories:
--   clinical_list — person is already covering a list this session
--                   (theatre, POAC, pain clinic, etc.); excluded from pool
--   excluded      — person is unavailable all day (ICU, obstetrics, on-call,
--                   teaching, admin, CIC, …); excluded from pool
--   flex          — flexible cover for that half-day (SPA); counted only in
--                   headroomWithSpa
--   ignored       — does not affect the pool

CREATE TABLE public.duty_type_pool_rules (
  duty_type public.duty_type PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('clinical_list','excluded','flex','ignored')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.duty_type_pool_rules TO authenticated;
GRANT ALL ON public.duty_type_pool_rules TO service_role;

ALTER TABLE public.duty_type_pool_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read duty_type pool rules"
  ON public.duty_type_pool_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins manage duty_type pool rules"
  ON public.duty_type_pool_rules
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER duty_type_pool_rules_set_updated_at
  BEFORE UPDATE ON public.duty_type_pool_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Seed defaults matching the current hard-coded behaviour.
INSERT INTO public.duty_type_pool_rules (duty_type, category, notes) VALUES
  ('theatre',                   'clinical_list', 'Theatre / POAC / pain clinic — anything booked against a theatre_session counts as already covering a list.'),
  ('spa',                       'flex',          'SPA time — counted only in headroom-with-SPA, not the baseline.'),
  ('icu_consultant_oncall',     'excluded',      'ICU consultant on-call.'),
  ('general_consultant_oncall', 'excluded',      'General consultant on-call.'),
  ('registrar_oncall',          'excluded',      'Registrar on-call.'),
  ('sho_oncall',                'excluded',      'SHO on-call.'),
  ('icu_trainee',               'excluded',      'ICU trainee rotation.'),
  ('icu_ct2_plus',              'excluded',      'ICU CT2+ rotation.'),
  ('obstetrics',                'excluded',      'Obstetric anaesthesia.'),
  ('obstetrics_2nd',            'excluded',      'Obstetric 2nd-on.'),
  ('consultant_in_charge',      'excluded',      'Consultant in charge.'),
  ('teaching',                  'excluded',      'Teaching commitment.'),
  ('non_clinical',              'excluded',      'Non-clinical session.'),
  ('admin',                     'excluded',      'Admin session.')
ON CONFLICT (duty_type) DO NOTHING;