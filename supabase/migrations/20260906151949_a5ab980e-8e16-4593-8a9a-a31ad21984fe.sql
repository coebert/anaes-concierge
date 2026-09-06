CREATE TABLE public.icu_sync_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT true,
  days_back integer NOT NULL DEFAULT 365,
  days_ahead integer NOT NULL DEFAULT 60,
  slice_days integer NOT NULL DEFAULT 7,
  cursor_start date,
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.icu_sync_state TO authenticated;
GRANT ALL ON public.icu_sync_state TO service_role;

ALTER TABLE public.icu_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators view icu sync state"
ON public.icu_sync_state
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'rota_coordinator'::app_role));

INSERT INTO public.icu_sync_state (id) VALUES (1);

CREATE TABLE public.icu_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start date NOT NULL,
  window_end date NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  audit_count integer NOT NULL DEFAULT 0,
  traces_written integer NOT NULL DEFAULT 0,
  diverged boolean NOT NULL DEFAULT false,
  ok boolean NOT NULL DEFAULT true,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.icu_sync_runs TO authenticated;
GRANT ALL ON public.icu_sync_runs TO service_role;

ALTER TABLE public.icu_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators view icu sync runs"
ON public.icu_sync_runs
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'rota_coordinator'::app_role));

CREATE INDEX idx_icu_sync_runs_created ON public.icu_sync_runs (created_at DESC);