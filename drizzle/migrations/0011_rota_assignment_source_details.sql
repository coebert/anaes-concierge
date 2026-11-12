CREATE TABLE IF NOT EXISTS public.rota_assignment_source_details (
  clwrota_external_id text PRIMARY KEY
    REFERENCES public.rota_assignments(clwrota_external_id) ON DELETE CASCADE ON UPDATE CASCADE,
  slot_titles text[] NOT NULL DEFAULT '{}'::text[],
  slot_notes text[] NOT NULL DEFAULT '{}'::text[],
  slot_speciality text,
  place_name text,
  place_local_id text,
  place_category text,
  place_notes text[] NOT NULL DEFAULT '{}'::text[],
  session_label text,
  role_name text,
  role_category text,
  assignment_type text,
  extra_type_name text,
  extra_type_description text,
  source_state text,
  source_rota_status text,
  start_time timestamptz,
  end_time timestamptz,
  duration interval,
  pa_value numeric,
  values_truncated boolean NOT NULL DEFAULT false,
  collapsed_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rota_assignment_source_details_value_counts CHECK (
    cardinality(slot_titles) <= 20 AND cardinality(slot_notes) <= 20 AND cardinality(place_notes) <= 20),
  CONSTRAINT rota_assignment_source_details_collapsed CHECK (
    jsonb_typeof(collapsed_rows) = 'array' AND jsonb_array_length(collapsed_rows) <= 20),
  CONSTRAINT rota_assignment_source_details_times CHECK (
    end_time IS NULL OR start_time IS NULL OR end_time >= start_time),
  CONSTRAINT rota_assignment_source_details_pa CHECK (pa_value IS NULL OR (pa_value >= 0 AND pa_value <= 100)),
  CONSTRAINT rota_assignment_source_details_scalar_len CHECK (
    coalesce(length(slot_speciality), 0) <= 2000 AND coalesce(length(place_name), 0) <= 2000
    AND coalesce(length(place_local_id), 0) <= 2000 AND coalesce(length(place_category), 0) <= 2000
    AND coalesce(length(session_label), 0) <= 2000 AND coalesce(length(role_name), 0) <= 2000
    AND coalesce(length(role_category), 0) <= 2000 AND coalesce(length(assignment_type), 0) <= 2000
    AND coalesce(length(extra_type_name), 0) <= 2000 AND coalesce(length(extra_type_description), 0) <= 2000
    AND coalesce(length(source_state), 0) <= 2000 AND coalesce(length(source_rota_status), 0) <= 2000)
);

COMMENT ON TABLE public.rota_assignment_source_details IS
  'Original CLWRota values per stored assignment (titles, notes, place notes, typed times, collapsed same-half rows) as supplied by the import. Potentially sensitive: service_role only.';

REVOKE ALL ON TABLE public.rota_assignment_source_details FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rota_assignment_source_details TO service_role;
ALTER TABLE public.rota_assignment_source_details ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public._validate_rota_assignment_source_details()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.slot_titles || NEW.slot_notes || NEW.place_notes) AS v(val)
    WHERE v.val IS NULL OR btrim(v.val) = '' OR length(v.val) > 2000
  ) THEN
    RAISE EXCEPTION 'source detail values must be non-empty and at most 2000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(NEW.collapsed_rows) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.collapsed_rows) AS e(el)
    WHERE jsonb_typeof(e.el) <> 'object' OR length(e.el::text) > 20000
  ) THEN
    RAISE EXCEPTION 'collapsed rows must be objects of bounded size' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._validate_rota_assignment_source_details() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rota_assignment_source_details_validate ON public.rota_assignment_source_details;
CREATE TRIGGER rota_assignment_source_details_validate
  BEFORE INSERT OR UPDATE ON public.rota_assignment_source_details
  FOR EACH ROW EXECUTE FUNCTION public._validate_rota_assignment_source_details();