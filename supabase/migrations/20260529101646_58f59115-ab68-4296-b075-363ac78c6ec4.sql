
CREATE TABLE public.duty_type_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_type duty_type NOT NULL,
  pattern text NOT NULL,
  match_type text NOT NULL DEFAULT 'substring',
  grade_filter text,
  trainee_seniority_filter text,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duty_type_mappings_match_type_chk
    CHECK (match_type IN ('substring','word','regex')),
  CONSTRAINT duty_type_mappings_grade_chk
    CHECK (grade_filter IS NULL OR grade_filter IN ('consultant','sas','trainee')),
  CONSTRAINT duty_type_mappings_seniority_chk
    CHECK (trainee_seniority_filter IS NULL OR trainee_seniority_filter IN ('junior','senior'))
);

GRANT SELECT ON public.duty_type_mappings TO authenticated;
GRANT ALL ON public.duty_type_mappings TO service_role;

ALTER TABLE public.duty_type_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read duty type mappings"
  ON public.duty_type_mappings FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage duty type mappings"
  ON public.duty_type_mappings FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_duty_type_mappings_updated_at
  BEFORE UPDATE ON public.duty_type_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_duty_type_mappings_active_priority
  ON public.duty_type_mappings (active, priority);

INSERT INTO public.duty_type_mappings (duty_type, pattern, match_type, grade_filter, trainee_seniority_filter, priority, notes) VALUES
  ('spa', 'spa', 'word', NULL, NULL, 10, 'SPA token'),
  ('spa', 'supporting professional', 'substring', NULL, NULL, 11, NULL),
  ('teaching', 'teach', 'substring', NULL, NULL, 20, NULL),
  ('teaching', 'education', 'substring', NULL, NULL, 21, NULL),
  ('teaching', 'training session', 'substring', NULL, NULL, 22, NULL),
  ('admin', 'admin', 'substring', NULL, NULL, 30, NULL),
  ('admin', 'management', 'substring', NULL, NULL, 31, NULL),
  ('admin', 'audit', 'substring', NULL, NULL, 32, NULL),
  ('admin', 'appraisal', 'substring', NULL, NULL, 33, NULL),
  ('admin', 'governance', 'substring', NULL, NULL, 34, NULL),
  ('consultant_in_charge', 'consultant in charge', 'substring', NULL, NULL, 40, NULL),
  ('consultant_in_charge', 'cic', 'word', NULL, NULL, 41, NULL),
  ('obstetrics_2nd', 'obstet.*\b(2nd|second)\b', 'regex', NULL, NULL, 50, '2nd-on obstetrics'),
  ('obstetrics', 'obstet', 'substring', NULL, NULL, 51, NULL),
  ('icu_consultant_oncall', 'icu', 'substring', 'consultant', NULL, 60, NULL),
  ('icu_consultant_oncall', 'intensive', 'substring', 'consultant', NULL, 61, NULL),
  ('icu_consultant_oncall', 'critical care', 'substring', 'consultant', NULL, 62, NULL),
  ('icu_trainee', 'icu', 'substring', 'trainee', 'junior', 63, NULL),
  ('icu_trainee', 'intensive', 'substring', 'trainee', 'junior', 64, NULL),
  ('icu_trainee', 'critical care', 'substring', 'trainee', 'junior', 65, NULL),
  ('icu_ct2_plus', 'icu', 'substring', NULL, NULL, 66, 'fallback for SAS / senior trainees / unknown'),
  ('icu_ct2_plus', 'intensive', 'substring', NULL, NULL, 67, NULL),
  ('icu_ct2_plus', 'critical care', 'substring', NULL, NULL, 68, NULL),
  ('general_consultant_oncall', 'on call', 'substring', 'consultant', NULL, 70, NULL),
  ('general_consultant_oncall', 'on-call', 'substring', 'consultant', NULL, 71, NULL),
  ('general_consultant_oncall', 'oncall', 'substring', 'consultant', NULL, 72, NULL),
  ('registrar_oncall', 'on call', 'substring', 'sas', NULL, 73, NULL),
  ('registrar_oncall', 'on-call', 'substring', 'sas', NULL, 74, NULL),
  ('registrar_oncall', 'oncall', 'substring', 'sas', NULL, 75, NULL),
  ('sho_oncall', 'on call', 'substring', 'trainee', 'junior', 76, NULL),
  ('sho_oncall', 'on-call', 'substring', 'trainee', 'junior', 77, NULL),
  ('sho_oncall', 'oncall', 'substring', 'trainee', 'junior', 78, NULL),
  ('registrar_oncall', 'on call', 'substring', 'trainee', 'senior', 79, NULL),
  ('registrar_oncall', 'on-call', 'substring', 'trainee', 'senior', 80, NULL),
  ('registrar_oncall', 'oncall', 'substring', 'trainee', 'senior', 81, NULL),
  ('registrar_oncall', 'on call', 'substring', NULL, NULL, 82, 'fallback for unknown grade'),
  ('registrar_oncall', 'on-call', 'substring', NULL, NULL, 83, NULL),
  ('registrar_oncall', 'oncall', 'substring', NULL, NULL, 84, NULL),
  ('non_clinical', 'non clinical', 'substring', NULL, NULL, 90, NULL),
  ('non_clinical', 'non-clinical', 'substring', NULL, NULL, 91, NULL),
  ('non_clinical', 'study', 'substring', NULL, NULL, 92, NULL);
