-- Preference level enum
CREATE TYPE public.specialty_preference AS ENUM ('preferred', 'willing', 'none');

-- Per-staff practice flags (obstetrics, paediatrics, cleft palate)
CREATE TABLE public.staff_practice_preferences (
  staff_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  covers_obstetrics boolean NOT NULL DEFAULT false,
  covers_paediatrics boolean NOT NULL DEFAULT false,
  covers_cleft_palate boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.staff_practice_preferences TO authenticated;
GRANT ALL ON public.staff_practice_preferences TO service_role;

ALTER TABLE public.staff_practice_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read practice preferences"
  ON public.staff_practice_preferences FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Admins can insert practice preferences"
  ON public.staff_practice_preferences FOR INSERT
  TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update practice preferences"
  ON public.staff_practice_preferences FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete practice preferences"
  ON public.staff_practice_preferences FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_staff_practice_prefs_updated
  BEFORE UPDATE ON public.staff_practice_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Per-staff, per-specialty preference level
CREATE TABLE public.staff_specialty_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  specialty_id uuid NOT NULL REFERENCES public.specialties(id) ON DELETE CASCADE,
  preference public.specialty_preference NOT NULL DEFAULT 'willing',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, specialty_id)
);

GRANT SELECT ON public.staff_specialty_preferences TO authenticated;
GRANT ALL ON public.staff_specialty_preferences TO service_role;

ALTER TABLE public.staff_specialty_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read specialty preferences"
  ON public.staff_specialty_preferences FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Admins can insert specialty preferences"
  ON public.staff_specialty_preferences FOR INSERT
  TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update specialty preferences"
  ON public.staff_specialty_preferences FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete specialty preferences"
  ON public.staff_specialty_preferences FOR DELETE
  TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_staff_specialty_prefs_updated
  BEFORE UPDATE ON public.staff_specialty_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_staff_specialty_prefs_staff ON public.staff_specialty_preferences(staff_id);
CREATE INDEX idx_staff_specialty_prefs_specialty ON public.staff_specialty_preferences(specialty_id);