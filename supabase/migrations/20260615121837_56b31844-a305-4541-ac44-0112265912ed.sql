
CREATE TABLE public.theatre_name_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias text NOT NULL,
  theatre_id uuid NOT NULL REFERENCES public.theatres(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX theatre_name_aliases_alias_norm_uniq
  ON public.theatre_name_aliases (lower(btrim(alias)));

CREATE INDEX theatre_name_aliases_theatre_idx
  ON public.theatre_name_aliases (theatre_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.theatre_name_aliases TO authenticated;
GRANT ALL ON public.theatre_name_aliases TO service_role;

ALTER TABLE public.theatre_name_aliases ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read aliases (used by sync diagnostics surfaced to staff).
CREATE POLICY "Authenticated can view theatre name aliases"
  ON public.theatre_name_aliases
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admins/rota coordinators can manage aliases.
CREATE POLICY "Coordinators can insert theatre name aliases"
  ON public.theatre_name_aliases
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "Coordinators can update theatre name aliases"
  ON public.theatre_name_aliases
  FOR UPDATE
  TO authenticated
  USING (public.current_user_is_coordinator_or_admin())
  WITH CHECK (public.current_user_is_coordinator_or_admin());

CREATE POLICY "Coordinators can delete theatre name aliases"
  ON public.theatre_name_aliases
  FOR DELETE
  TO authenticated
  USING (public.current_user_is_coordinator_or_admin());

CREATE TRIGGER theatre_name_aliases_set_updated_at
  BEFORE UPDATE ON public.theatre_name_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
