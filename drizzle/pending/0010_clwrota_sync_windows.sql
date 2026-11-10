-- 0010 clwrota_sync_windows — PENDING. NOT applied to the live database.
--
-- One row per rota import run (each slice of a chunked import is its own
-- run), recording WHICH DATES the run asked the feed for, which dates its
-- returned rows actually spanned, and the run's outcome. This is the only
-- per-date record of import freshness; nothing is back-filled, so dates before
-- this migration is applied read as "not tracked", never as imported.
--   outcome  ok       every row in the window was processed with no write error
--            partial  some rows failed to write — the whole window is suspect
--            empty    the feed returned no rows for the window
--            failed   the fetch/parse/import threw — nothing usable
-- covered_from/to = requested window ∩ [first, last] row date the feed
-- returned (ok/partial only). A date inside requested but outside covered was
-- asked for but not evidenced, so it never counts as imported.
-- Holds no personal data: dates, an outcome code and aggregate counts. No
-- error text (import errors can contain names) is stored here.
--   * table: service_role only (the import writes; no browser access);
--   * get_rota_sync_week_coverage(): derived per-week summary for active
--     members / service role, identity from the signed request (0007 helpers).
-- Additive only. Proven in tests/db-harness/source-labels/run.sh (synthetic).

CREATE TABLE IF NOT EXISTS public.clwrota_sync_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  requested_from date NOT NULL,
  requested_to date NOT NULL,
  covered_from date,
  covered_to date,
  outcome text NOT NULL,
  explicit_window boolean NOT NULL DEFAULT false,
  rows_in_window integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  write_errors integer NOT NULL DEFAULT 0,
  CONSTRAINT clwrota_sync_windows_outcome CHECK (outcome IN ('ok','partial','empty','failed')),
  CONSTRAINT clwrota_sync_windows_requested CHECK (
    requested_to >= requested_from AND requested_to - requested_from <= 800),
  CONSTRAINT clwrota_sync_windows_covered CHECK (
    (outcome IN ('ok','partial')
      AND covered_from IS NOT NULL AND covered_to IS NOT NULL
      AND covered_from >= requested_from AND covered_to <= requested_to AND covered_to >= covered_from)
    OR (outcome IN ('empty','failed') AND covered_from IS NULL AND covered_to IS NULL)),
  CONSTRAINT clwrota_sync_windows_counts CHECK (
    rows_in_window >= 0 AND rows_skipped >= 0 AND write_errors >= 0
    AND (outcome <> 'ok' OR write_errors = 0)
    AND (outcome <> 'partial' OR write_errors > 0)
    AND (outcome <> 'empty' OR rows_in_window = 0)),
  CONSTRAINT clwrota_sync_windows_times CHECK (finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS clwrota_sync_windows_requested_idx
  ON public.clwrota_sync_windows (requested_from, requested_to);
CREATE INDEX IF NOT EXISTS clwrota_sync_windows_started_idx
  ON public.clwrota_sync_windows (started_at);

COMMENT ON TABLE public.clwrota_sync_windows IS
  'Per-run CLWRota rota import date windows and outcome (no error text). Tracking starts when applied; earlier dates are not tracked. Browsers use get_rota_sync_week_coverage().';

REVOKE ALL ON TABLE public.clwrota_sync_windows FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clwrota_sync_windows TO service_role;
ALTER TABLE public.clwrota_sync_windows ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies.

-- Derived per-ISO-week import coverage for every week touching [p_from, p_to]
-- (whole weeks, Monday–Sunday).
CREATE OR REPLACE FUNCTION public.get_rota_sync_week_coverage(p_from date, p_to date)
RETURNS TABLE (
  week_start date,
  days_total integer,
  days_ok integer,
  days_partial_only integer,
  days_latest_not_ok integer,
  last_full_ok_at timestamptz,
  newest_ok_at timestamptz,
  latest_attempt_at timestamptz,
  latest_attempt_outcome text,
  tracking_since timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
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
  SELECT min(w.started_at) INTO v_since FROM public.clwrota_sync_windows w;
  RETURN QUERY
  WITH days AS (
    SELECT g::date AS d
    FROM generate_series(date_trunc('week', p_from)::date,
                         (date_trunc('week', p_to)::date + 6), interval '1 day') AS g
  ),
  per_day AS (
    SELECT days.d,
      (SELECT max(w.started_at) FROM public.clwrota_sync_windows w
        WHERE w.outcome = 'ok' AND days.d BETWEEN w.covered_from AND w.covered_to) AS last_ok,
      (SELECT max(w.started_at) FROM public.clwrota_sync_windows w
        WHERE w.outcome = 'partial' AND days.d BETWEEN w.covered_from AND w.covered_to) AS last_partial,
      la.started_at AS latest_at,
      la.outcome AS latest_outcome
    FROM days
    LEFT JOIN LATERAL (
      SELECT w.started_at, w.outcome FROM public.clwrota_sync_windows w
      WHERE days.d BETWEEN w.requested_from AND w.requested_to
      -- Same start time: the less complete outcome wins (conservative).
      ORDER BY w.started_at DESC,
               CASE w.outcome WHEN 'failed' THEN 0 WHEN 'partial' THEN 1 WHEN 'empty' THEN 2 ELSE 3 END,
               w.id
      LIMIT 1
    ) la ON true
  )
  SELECT date_trunc('week', p.d)::date AS week_start,
         count(*)::integer,
         count(p.last_ok)::integer,
         count(*) FILTER (WHERE p.last_ok IS NULL AND p.last_partial IS NOT NULL)::integer,
         count(*) FILTER (WHERE p.latest_outcome IS NOT NULL AND p.latest_outcome <> 'ok')::integer,
         CASE WHEN count(p.last_ok) = count(*) THEN min(p.last_ok) END,
         max(p.last_ok),
         max(p.latest_at),
         (array_agg(p.latest_outcome ORDER BY p.latest_at DESC NULLS LAST,
            CASE p.latest_outcome WHEN 'failed' THEN 0 WHEN 'partial' THEN 1 WHEN 'empty' THEN 2 ELSE 3 END))[1],
         v_since
  FROM per_day p
  GROUP BY 1
  ORDER BY 1;
END $$;

REVOKE ALL ON FUNCTION public.get_rota_sync_week_coverage(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rota_sync_week_coverage(date, date) TO authenticated, service_role;
