-- =============================================================
-- Competency & credentialing register
-- =============================================================

-- 1. Catalogue of competencies
CREATE TABLE public.competencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  category text NOT NULL CHECK (category IN (
    'subspecialty','procedural','lead_role','transfer','training','other'
  )),
  applies_to_grades text[] NOT NULL DEFAULT ARRAY['consultant','sas','trainee']::text[],
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.competencies TO authenticated;
GRANT ALL ON public.competencies TO service_role;

ALTER TABLE public.competencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "competencies_select_authenticated"
  ON public.competencies FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "competencies_admin_insert"
  ON public.competencies FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "competencies_admin_update"
  ON public.competencies FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "competencies_admin_delete"
  ON public.competencies FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER competencies_set_updated_at
  BEFORE UPDATE ON public.competencies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX competencies_active_sort_idx
  ON public.competencies (active, sort_order, name);

-- 2. Staff -> competency holdings
CREATE TABLE public.staff_competencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  competency_id uuid NOT NULL REFERENCES public.competencies(id) ON DELETE CASCADE,
  level text CHECK (level IN ('independent','supervised','aware')),
  granted_at date NOT NULL DEFAULT CURRENT_DATE,
  expires_at date,
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  revoked_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, competency_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_competencies TO authenticated;
GRANT ALL ON public.staff_competencies TO service_role;

ALTER TABLE public.staff_competencies ENABLE ROW LEVEL SECURITY;

-- Staff see their own; coordinators/admins see all
CREATE POLICY "staff_competencies_select"
  ON public.staff_competencies FOR SELECT TO authenticated
  USING (
    staff_id = auth.uid()
    OR public.current_user_is_coordinator_or_admin()
  );

-- Only coordinators/admins can add/edit/remove competencies
CREATE POLICY "staff_competencies_coord_insert"
  ON public.staff_competencies FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "staff_competencies_coord_update"
  ON public.staff_competencies FOR UPDATE TO authenticated
  USING (public.current_user_is_coordinator_or_admin())
  WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "staff_competencies_coord_delete"
  ON public.staff_competencies FOR DELETE TO authenticated
  USING (public.current_user_is_coordinator_or_admin());

CREATE TRIGGER staff_competencies_set_updated_at
  BEFORE UPDATE ON public.staff_competencies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX staff_competencies_staff_idx
  ON public.staff_competencies (staff_id, revoked_at);
CREATE INDEX staff_competencies_competency_idx
  ON public.staff_competencies (competency_id, revoked_at);

-- 3. Specialty -> required/recommended competencies
CREATE TABLE public.specialty_competency_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specialty_id uuid NOT NULL REFERENCES public.specialties(id) ON DELETE CASCADE,
  competency_id uuid NOT NULL REFERENCES public.competencies(id) ON DELETE CASCADE,
  requirement text NOT NULL DEFAULT 'required'
    CHECK (requirement IN ('required','recommended')),
  applies_to_role text NOT NULL DEFAULT 'solo'
    CHECK (applies_to_role IN ('solo','supervising','any')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (specialty_id, competency_id, applies_to_role)
);

GRANT SELECT ON public.specialty_competency_requirements TO authenticated;
GRANT ALL ON public.specialty_competency_requirements TO service_role;

ALTER TABLE public.specialty_competency_requirements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spec_comp_req_select_authenticated"
  ON public.specialty_competency_requirements FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "spec_comp_req_admin_insert"
  ON public.specialty_competency_requirements FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "spec_comp_req_admin_update"
  ON public.specialty_competency_requirements FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "spec_comp_req_admin_delete"
  ON public.specialty_competency_requirements FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER spec_comp_req_set_updated_at
  BEFORE UPDATE ON public.specialty_competency_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX spec_comp_req_specialty_idx
  ON public.specialty_competency_requirements (specialty_id);

-- 4. Starter catalogue seed (only if the table is empty)
INSERT INTO public.competencies (code, name, description, category, applies_to_grades, sort_order)
SELECT * FROM (VALUES
  ('paeds_all_ages',      'Paediatric anaesthesia — all ages',   'Any child, including neonates',                       'subspecialty', ARRAY['consultant','sas'],                     10),
  ('paeds_over_3',        'Paediatric anaesthesia — >3 years',   'Children older than 3, excluding infants/neonates',   'subspecialty', ARRAY['consultant','sas','trainee'],           11),
  ('cardiac',             'Cardiac anaesthesia',                  'Adult cardiac theatre list',                          'subspecialty', ARRAY['consultant','sas'],                     20),
  ('thoracic',            'Thoracic anaesthesia',                 'One-lung ventilation, thoracotomy',                    'subspecialty', ARRAY['consultant','sas'],                     21),
  ('neuro',               'Neuroanaesthesia',                     'Elective neurosurgery lists',                          'subspecialty', ARRAY['consultant','sas'],                     22),
  ('obs_high_risk',       'Obstetric high-risk',                  'Complex obstetric cases, cardiac obs, prem sections', 'subspecialty', ARRAY['consultant','sas'],                     30),
  ('vascular_major',      'Major vascular',                       'Open AAA, carotid, complex endovascular',              'subspecialty', ARRAY['consultant','sas'],                     23),
  ('regional_advanced',   'Advanced regional anaesthesia',        'Interfascial plane blocks, catheters',                 'procedural',   ARRAY['consultant','sas','trainee'],           40),
  ('difficult_airway_lead','Difficult airway lead',               'Awake fibreoptic, front-of-neck access competent',     'procedural',   ARRAY['consultant','sas'],                     41),
  ('poac_lead',           'POAC lead',                            'Pre-op assessment clinic sign-off',                    'lead_role',    ARRAY['consultant','sas'],                     50),
  ('mtp_activator',       'Major haemorrhage protocol activator', 'Trained to lead MHP activation',                       'lead_role',    ARRAY['consultant','sas','trainee'],           51),
  ('halo_lead',           'HALO / trauma team lead',              'Hospital Advanced Life-support Officer competent',     'lead_role',    ARRAY['consultant','sas'],                     52),
  ('consultant_in_charge','Consultant in charge',                 'Signed off to be COW / duty consultant',               'lead_role',    ARRAY['consultant','sas'],                     53),
  ('transfer_adult',      'Adult inter-hospital transfer',        'Competent to transfer intubated adult patients',       'transfer',     ARRAY['consultant','sas','trainee'],           60),
  ('transfer_paediatric', 'Paediatric transfer',                  'Competent for paediatric transfers pending retrieval', 'transfer',     ARRAY['consultant','sas'],                     61),
  ('ect',                 'ECT anaesthesia',                      'Electroconvulsive therapy list competent',             'procedural',   ARRAY['consultant','sas','trainee'],           42),
  ('icu_consultant',      'ICU consultant',                       'Signed off as ICU consultant of the week',             'lead_role',    ARRAY['consultant','sas'],                     54),
  ('solo_ortho',          'Solo — Orthopaedics',                  'Trainee: cleared to run an ortho list solo',           'training',     ARRAY['trainee'],                              70),
  ('solo_gen_surg',       'Solo — General surgery',               'Trainee: cleared to run a gen-surg list solo',         'training',     ARRAY['trainee'],                              71),
  ('solo_gynae',          'Solo — Gynaecology',                   'Trainee: cleared to run a gynae list solo',            'training',     ARRAY['trainee'],                              72),
  ('solo_urology',        'Solo — Urology',                       'Trainee: cleared to run a urology list solo',          'training',     ARRAY['trainee'],                              73),
  ('solo_ent',            'Solo — ENT',                           'Trainee: cleared to run an ENT list solo',             'training',     ARRAY['trainee'],                              74),
  ('solo_ophthalmology',  'Solo — Ophthalmology',                 'Trainee: cleared to run an ophthalmology list solo',   'training',     ARRAY['trainee'],                              75),
  ('solo_dental',         'Solo — Dental/OMFS',                   'Trainee: cleared to run a dental list solo',           'training',     ARRAY['trainee'],                              76)
) AS v(code,name,description,category,applies_to_grades,sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.competencies);
