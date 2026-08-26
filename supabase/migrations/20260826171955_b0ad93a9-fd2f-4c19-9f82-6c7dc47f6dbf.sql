CREATE TABLE public.tutorial_detection_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid REFERENCES public.rota_assignments(id) ON DELETE SET NULL,
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_date date NOT NULL,
  session session_half NOT NULL,
  clwrota_external_id text,
  matched_field text,
  matched_value text,
  place_name text,
  slot_titles text,
  role_label text,
  person_label text,
  source_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_by text NOT NULL DEFAULT 'verify',
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tutorial_detection_matches_key_uidx
  ON public.tutorial_detection_matches (staff_id, session_date, session);
CREATE INDEX tutorial_detection_matches_date_idx
  ON public.tutorial_detection_matches (session_date);
CREATE INDEX tutorial_detection_matches_assignment_idx
  ON public.tutorial_detection_matches (assignment_id);

GRANT SELECT ON public.tutorial_detection_matches TO authenticated;
GRANT ALL ON public.tutorial_detection_matches TO service_role;
ALTER TABLE public.tutorial_detection_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators view tutorial detection matches"
  ON public.tutorial_detection_matches FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE TRIGGER tutorial_detection_matches_updated_at
  BEFORE UPDATE ON public.tutorial_detection_matches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();