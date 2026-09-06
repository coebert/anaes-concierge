CREATE TABLE public.icu_detection_matches (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assignment_id uuid REFERENCES public.rota_assignments(id) ON DELETE SET NULL,
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_date date NOT NULL,
  session session_half NOT NULL,
  duty_type duty_type,
  clwrota_external_id text,
  matched_field text,
  matched_value text,
  place_name text,
  slot_titles text,
  role_label text,
  person_label text,
  pa_credit numeric,
  attending_consultant_ids uuid[] NOT NULL DEFAULT '{}',
  source_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_by text NOT NULL DEFAULT 'verify',
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, session_date, session)
);

GRANT SELECT ON public.icu_detection_matches TO authenticated;
GRANT ALL ON public.icu_detection_matches TO service_role;

ALTER TABLE public.icu_detection_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators view icu detection matches"
ON public.icu_detection_matches
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'rota_coordinator'::app_role));

CREATE INDEX idx_icu_detection_matches_date ON public.icu_detection_matches (session_date);