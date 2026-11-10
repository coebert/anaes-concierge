-- 0009 clwrota_week_status — PENDING. NOT applied to the live database.
--
-- One row per ISO week (Monday) whose rota status the CLWRota import has
-- OBSERVED in the Central API assignments feed (`rota_status`: "Published",
-- "Setup", "Not setup"). Rows are written only for weeks the feed returned
-- rows for; an absent week means "not observed", never a status.
-- Holds no personal data: status code, the feed's own short status words,
-- aggregate row counts and the app's observation times (not publication
-- times; no publication actor).
--   * signed-in active members may read (same predicate as theatre_sessions);
--   * only service_role (the import) writes.
-- Additive only. Proven in tests/db-harness/source-labels/run.sh (synthetic).

CREATE TABLE IF NOT EXISTS public.clwrota_week_status (
  week_start date PRIMARY KEY,
  status_code text NOT NULL,
  source_values text[] NOT NULL DEFAULT '{}'::text[],
  rows_seen integer NOT NULL DEFAULT 0,
  dates_seen integer NOT NULL DEFAULT 0,
  planned_rows integer NOT NULL DEFAULT 0,
  actual_rows integer NOT NULL DEFAULT 0,
  other_state_rows integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  status_since timestamptz NOT NULL DEFAULT now(),
  previous_status_code text,
  CONSTRAINT clwrota_week_status_monday CHECK (extract(isodow FROM week_start) = 1),
  CONSTRAINT clwrota_week_status_code CHECK (
    status_code IN ('published','setup','not_setup','mixed','unknown','other')),
  CONSTRAINT clwrota_week_status_prev_code CHECK (
    previous_status_code IS NULL OR previous_status_code IN ('published','setup','not_setup','mixed','unknown','other')),
  CONSTRAINT clwrota_week_status_counts CHECK (
    rows_seen >= 1 AND dates_seen BETWEEN 1 AND 7 AND planned_rows >= 0 AND actual_rows >= 0
    AND other_state_rows >= 0 AND planned_rows + actual_rows + other_state_rows = rows_seen),
  CONSTRAINT clwrota_week_status_values CHECK (cardinality(source_values) <= 5)
);

COMMENT ON TABLE public.clwrota_week_status IS
  'Week rota status as observed by the CLWRota import (feed rota_status). observed_at/status_since are app observation times, not publication times. Absent week = not observed.';

-- Per-value check: short plain words only (CHECK cannot inspect elements).
CREATE OR REPLACE FUNCTION public._validate_clwrota_week_status()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.source_values) AS v(val)
             WHERE v.val IS NULL OR v.val !~ '^[A-Za-z][A-Za-z _-]{0,39}$') THEN
    RAISE EXCEPTION 'source status values must be short plain words' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._validate_clwrota_week_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS clwrota_week_status_validate ON public.clwrota_week_status;
CREATE TRIGGER clwrota_week_status_validate
  BEFORE INSERT OR UPDATE ON public.clwrota_week_status
  FOR EACH ROW EXECUTE FUNCTION public._validate_clwrota_week_status();

REVOKE ALL ON TABLE public.clwrota_week_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.clwrota_week_status TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clwrota_week_status TO service_role;
ALTER TABLE public.clwrota_week_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Active members read week status" ON public.clwrota_week_status;
CREATE POLICY "Active members read week status" ON public.clwrota_week_status
  FOR SELECT TO authenticated USING (public.is_app_member(auth.uid()));
