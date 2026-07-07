
CREATE TABLE public.educational_supervisor_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  supervisor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  valid_from date NOT NULL,
  valid_to date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX esa_trainee_idx ON public.educational_supervisor_assignments(trainee_id);
CREATE INDEX esa_supervisor_idx ON public.educational_supervisor_assignments(supervisor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.educational_supervisor_assignments TO authenticated;
GRANT ALL ON public.educational_supervisor_assignments TO service_role;

ALTER TABLE public.educational_supervisor_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators manage supervisor assignments"
ON public.educational_supervisor_assignments FOR ALL TO authenticated
USING (public.current_user_is_coordinator_or_admin())
WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "Trainee or supervisor reads own pairing"
ON public.educational_supervisor_assignments FOR SELECT TO authenticated
USING (auth.uid() = trainee_id OR auth.uid() = supervisor_id);

CREATE TRIGGER trg_esa_updated_at BEFORE UPDATE ON public.educational_supervisor_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
CREATE TABLE public.arcp_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_level text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'other',
  target_value numeric NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'count',
  sort_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(training_level, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.arcp_requirements TO authenticated;
GRANT ALL ON public.arcp_requirements TO service_role;

ALTER TABLE public.arcp_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in can read requirements"
ON public.arcp_requirements FOR SELECT TO authenticated USING (true);

CREATE POLICY "Coordinators manage requirements"
ON public.arcp_requirements FOR ALL TO authenticated
USING (public.current_user_is_coordinator_or_admin())
WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE TRIGGER trg_arcp_req_updated_at BEFORE UPDATE ON public.arcp_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
CREATE TABLE public.arcp_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES public.arcp_requirements(id) ON DELETE CASCADE,
  current_value numeric NOT NULL DEFAULT 0,
  arcp_date date,
  notes text,
  last_reviewed_at timestamptz,
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trainee_id, requirement_id)
);
CREATE INDEX arcp_progress_trainee_idx ON public.arcp_progress(trainee_id);
CREATE INDEX arcp_progress_arcp_date_idx ON public.arcp_progress(arcp_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.arcp_progress TO authenticated;
GRANT ALL ON public.arcp_progress TO service_role;

ALTER TABLE public.arcp_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators manage progress"
ON public.arcp_progress FOR ALL TO authenticated
USING (public.current_user_is_coordinator_or_admin())
WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "Trainee reads own progress"
ON public.arcp_progress FOR SELECT TO authenticated
USING (auth.uid() = trainee_id);

CREATE POLICY "Supervisor reads assigned trainee progress"
ON public.arcp_progress FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.educational_supervisor_assignments a
  WHERE a.trainee_id = arcp_progress.trainee_id
    AND a.supervisor_id = auth.uid()
    AND a.valid_from <= CURRENT_DATE
    AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)
));

CREATE TRIGGER trg_arcp_prog_updated_at BEFORE UPDATE ON public.arcp_progress
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =====================================================================
-- Seed a set of common RCoA ARCP requirements per training level. These
-- are indicative defaults; coordinators can edit them in the admin UI.
INSERT INTO public.arcp_requirements (training_level, code, label, category, target_value, unit, sort_order) VALUES
  ('CT1', 'iac',   'Initial Assessment of Competence (IAC)',        'assessment', 1,   'completed', 10),
  ('CT1', 'wbas',  'Workplace-based assessments',                    'assessment', 40,  'count',     20),
  ('CT1', 'mtr',   'Multiple Trainer Reports',                       'feedback',   3,   'count',     30),
  ('CT1', 'cases', 'Logbook cases',                                  'cases',      300, 'count',     40),

  ('CT2', 'iaco',  'IAC in Obstetrics',                              'assessment', 1,   'completed', 10),
  ('CT2', 'wbas',  'Workplace-based assessments',                    'assessment', 40,  'count',     20),
  ('CT2', 'mtr',   'Multiple Trainer Reports',                       'feedback',   3,   'count',     30),
  ('CT2', 'cases', 'Logbook cases',                                  'cases',      300, 'count',     40),
  ('CT2', 'primary_frca', 'Primary FRCA passed',                     'exam',       1,   'completed', 5),

  ('ST3', 'wbas',  'Workplace-based assessments',                    'assessment', 50,  'count',     20),
  ('ST3', 'mtr',   'Multiple Trainer Reports',                       'feedback',   3,   'count',     30),
  ('ST3', 'audit', 'Quality improvement / audit project',            'qi',         1,   'completed', 50),
  ('ST3', 'final_frca_written', 'Final FRCA written',                'exam',       1,   'completed', 5),

  ('ST4', 'wbas',  'Workplace-based assessments',                    'assessment', 50,  'count',     20),
  ('ST4', 'final_frca', 'Final FRCA completed',                      'exam',       1,   'completed', 5),
  ('ST4', 'audit', 'Quality improvement / audit project',            'qi',         1,   'completed', 50),

  ('ST5', 'wbas',  'Workplace-based assessments',                    'assessment', 50,  'count',     20),
  ('ST5', 'higher_units', 'Higher training units completed',         'module',     4,   'count',     40),

  ('ST6', 'wbas',  'Workplace-based assessments',                    'assessment', 50,  'count',     20),
  ('ST6', 'higher_units', 'Higher / advanced units completed',       'module',     6,   'count',     40),

  ('ST7', 'consultant_prep', 'Transition-to-consultant module',      'module',     1,   'completed', 70),
  ('ST7', 'advanced_units',  'Advanced units completed',             'module',     2,   'count',     40)
ON CONFLICT DO NOTHING;
