-- 0008 theatre_session_source_labels — PENDING. NOT applied to the live database.
--
-- Keeps the ORIGINAL CLWRota list titles (slot_titles), list notes
-- (slot_notes) and place notes (place.additional_info) per theatre session,
-- separately and as supplied, on a restricted relation. Raw values are
-- potentially sensitive:
--   * only service_role (the import) may read or write the table;
--   * anon / authenticated have no table privileges and there are no RLS
--     policies (RLS enabled = deny for every non-bypass role);
--   * signed-in active members (same predicate as the theatre_sessions
--     SELECT policy: is_app_member) get DERIVED signals only through
--     get_theatre_session_label_signals(): booleans, known tag names, a
--     per-(date, theatre) title-equality group and import completeness —
--     never the text.
-- Additive only: no existing table, column, policy or row is changed.
-- Proven in tests/db-harness/source-labels/run.sh (synthetic data only).

CREATE TABLE IF NOT EXISTS public.theatre_session_source_labels (
  theatre_session_id uuid PRIMARY KEY REFERENCES public.theatre_sessions(id) ON DELETE CASCADE,
  list_titles text[] NOT NULL DEFAULT '{}'::text[],
  list_notes text[] NOT NULL DEFAULT '{}'::text[],
  place_notes text[] NOT NULL DEFAULT '{}'::text[],
  title_tags text[] NOT NULL DEFAULT '{}'::text[],
  note_tags text[] NOT NULL DEFAULT '{}'::text[],
  scan_truncated boolean NOT NULL DEFAULT false,
  source_rows_seen integer NOT NULL DEFAULT 0,
  evidence_complete boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT theatre_session_source_labels_value_counts CHECK (
    cardinality(list_titles) <= 20 AND cardinality(list_notes) <= 20 AND cardinality(place_notes) <= 20),
  CONSTRAINT theatre_session_source_labels_known_tags CHECK (
    title_tags <@ ARRAY['VRAM','DIEP','Robotic']::text[] AND note_tags <@ ARRAY['VRAM','DIEP','Robotic']::text[]),
  CONSTRAINT theatre_session_source_labels_rows_seen CHECK (source_rows_seen >= 0)
);

COMMENT ON TABLE public.theatre_session_source_labels IS
  'Original CLWRota list titles/notes per theatre session as supplied by the import. Potentially sensitive: service_role only. Browser callers use get_theatre_session_label_signals() (derived output only).';

REVOKE ALL ON TABLE public.theatre_session_source_labels FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.theatre_session_source_labels TO service_role;
ALTER TABLE public.theatre_session_source_labels ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies.

-- Per-value validation (CHECK cannot inspect array elements) + updated_at.
CREATE OR REPLACE FUNCTION public._validate_theatre_session_source_labels()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.list_titles || NEW.list_notes || NEW.place_notes) AS v(val)
    WHERE v.val IS NULL OR btrim(v.val) = '' OR length(v.val) > 2000
  ) THEN
    RAISE EXCEPTION 'source label values must be non-empty and at most 2000 characters'
      USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._validate_theatre_session_source_labels() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS theatre_session_source_labels_validate ON public.theatre_session_source_labels;
CREATE TRIGGER theatre_session_source_labels_validate
  BEFORE INSERT OR UPDATE ON public.theatre_session_source_labels
  FOR EACH ROW EXECUTE FUNCTION public._validate_theatre_session_source_labels();

-- Derived, text-free signals for the forecast. Caller identity comes from the
-- signed request (0007 helpers), never current_user.
CREATE OR REPLACE FUNCTION public.get_theatre_session_label_signals(p_from date, p_to date)
RETURNS TABLE (
  theatre_session_id uuid,
  has_title boolean,
  has_note boolean,
  has_place_note boolean,
  title_tags text[],
  note_tags text[],
  title_group integer,
  scan_truncated boolean,
  source_rows_seen integer,
  evidence_complete boolean,
  last_seen_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (
    public._request_is_service_role()
    OR (public._request_is_authenticated_user() AND public.is_app_member(auth.uid()))
  ) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'invalid window' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT l.theatre_session_id AS sid, s.session_date AS d, s.theatre_id AS tid,
           l.list_titles AS lt, l.list_notes AS ln, l.place_notes AS pn,
           l.title_tags AS tt, l.note_tags AS nt, l.scan_truncated AS st,
           l.source_rows_seen AS rs, l.evidence_complete AS ec, l.last_seen_at AS ls,
           CASE WHEN cardinality(l.list_titles) > 0 THEN
             array_to_string(ARRAY(
               SELECT DISTINCT btrim(regexp_replace(lower(t.val), '[^a-z0-9]+', ' ', 'g'))
               FROM unnest(l.list_titles) AS t(val) ORDER BY 1), '|')
           END AS tkey
    FROM public.theatre_session_source_labels l
    JOIN public.theatre_sessions s ON s.id = l.theatre_session_id
    WHERE s.session_date BETWEEN p_from AND p_to
  )
  SELECT b.sid, cardinality(b.lt) > 0, cardinality(b.ln) > 0, cardinality(b.pn) > 0,
         b.tt, b.nt,
         CASE WHEN b.tkey IS NULL THEN NULL
              ELSE (dense_rank() OVER (PARTITION BY b.d, b.tid ORDER BY b.tkey NULLS LAST))::integer END,
         b.st, b.rs, b.ec, b.ls
  FROM base b
  ORDER BY b.sid;
END $$;

REVOKE ALL ON FUNCTION public.get_theatre_session_label_signals(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_theatre_session_label_signals(date, date) TO authenticated, service_role;
