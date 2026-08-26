CREATE TABLE public.tutorial_audit_job_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  lease_until timestamptz,
  cursor_start date,
  horizon_end date,
  pass_started_at timestamptz,
  next_pass_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tutorial_audit_job_state TO authenticated;
GRANT ALL ON public.tutorial_audit_job_state TO service_role;
ALTER TABLE public.tutorial_audit_job_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Coordinators view tutorial audit job state"
  ON public.tutorial_audit_job_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE TABLE public.tutorial_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start date NOT NULL,
  window_end date NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  audit_count integer NOT NULL DEFAULT 0,
  promoted_to_teaching integer NOT NULL DEFAULT 0,
  notes_updated integer NOT NULL DEFAULT 0,
  diverged boolean NOT NULL DEFAULT false,
  ok boolean NOT NULL DEFAULT true,
  error text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tutorial_audit_runs_created_idx ON public.tutorial_audit_runs (created_at DESC);
CREATE INDEX tutorial_audit_runs_window_idx ON public.tutorial_audit_runs (window_start, window_end);

GRANT SELECT ON public.tutorial_audit_runs TO authenticated;
GRANT ALL ON public.tutorial_audit_runs TO service_role;
ALTER TABLE public.tutorial_audit_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Coordinators view tutorial audit runs"
  ON public.tutorial_audit_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE TABLE public.tutorial_audit_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.tutorial_audit_runs(id) ON DELETE SET NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  audit_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tutorial_audit_alerts_open_idx
  ON public.tutorial_audit_alerts (created_at DESC) WHERE acknowledged_at IS NULL;

GRANT SELECT, UPDATE ON public.tutorial_audit_alerts TO authenticated;
GRANT ALL ON public.tutorial_audit_alerts TO service_role;
ALTER TABLE public.tutorial_audit_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Coordinators view tutorial audit alerts"
  ON public.tutorial_audit_alerts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));
CREATE POLICY "Coordinators acknowledge tutorial audit alerts"
  ON public.tutorial_audit_alerts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE TRIGGER tutorial_audit_job_state_updated_at
  BEFORE UPDATE ON public.tutorial_audit_job_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.tutorial_audit_job_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;