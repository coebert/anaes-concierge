CREATE TABLE public.clwrota_sync_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_kind text NOT NULL CHECK (sync_kind IN ('leave','rota','staff')),
  run_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  duration_ms integer,
  rows_pulled integer NOT NULL DEFAULT 0,
  rows_drafted integer NOT NULL DEFAULT 0,
  rows_upserted integer NOT NULL DEFAULT 0,
  rows_failed integer NOT NULL DEFAULT 0,
  rows_skipped_validation integer NOT NULL DEFAULT 0,
  chunks_total integer NOT NULL DEFAULT 0,
  chunks_succeeded_first_try integer NOT NULL DEFAULT 0,
  chunks_succeeded_after_retry integer NOT NULL DEFAULT 0,
  chunks_fell_back_to_per_row integer NOT NULL DEFAULT 0,
  per_row_attempts integer NOT NULL DEFAULT 0,
  per_row_succeeded integer NOT NULL DEFAULT 0,
  per_row_failed integer NOT NULL DEFAULT 0,
  upsert_attempts_total integer NOT NULL DEFAULT 0,
  upsert_retries_total integer NOT NULL DEFAULT 0,
  errors_count integer NOT NULL DEFAULT 0,
  notes text
);

CREATE INDEX clwrota_sync_metrics_run_at_idx ON public.clwrota_sync_metrics (run_at DESC);
CREATE INDEX clwrota_sync_metrics_kind_run_at_idx ON public.clwrota_sync_metrics (sync_kind, run_at DESC);

GRANT SELECT ON public.clwrota_sync_metrics TO authenticated;
GRANT ALL ON public.clwrota_sync_metrics TO service_role;

ALTER TABLE public.clwrota_sync_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read sync metrics"
  ON public.clwrota_sync_metrics
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));