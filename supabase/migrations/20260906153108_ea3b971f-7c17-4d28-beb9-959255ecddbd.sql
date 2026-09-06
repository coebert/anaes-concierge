CREATE TABLE public.icu_audit_job_state (
  id integer PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  lease_until timestamptz,
  cursor_start date,
  horizon_end date,
  pass_started_at timestamptz,
  next_pass_at timestamptz NOT NULL DEFAULT now(),
  slice_days integer NOT NULL DEFAULT 14,
  last_run_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT icu_audit_job_state_single_row CHECK (id = 1)
);

GRANT SELECT ON public.icu_audit_job_state TO authenticated;
GRANT ALL ON public.icu_audit_job_state TO service_role;

ALTER TABLE public.icu_audit_job_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators and admins read ICU audit job state"
  ON public.icu_audit_job_state FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE TRIGGER icu_audit_job_state_set_updated_at
  BEFORE UPDATE ON public.icu_audit_job_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.icu_audit_job_state (id) VALUES (1);

CREATE TABLE public.icu_audit_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.icu_sync_runs(id) ON DELETE SET NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  audit_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX icu_audit_alerts_created_idx ON public.icu_audit_alerts (created_at DESC);

GRANT SELECT, UPDATE ON public.icu_audit_alerts TO authenticated;
GRANT ALL ON public.icu_audit_alerts TO service_role;

ALTER TABLE public.icu_audit_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coordinators and admins read ICU audit alerts"
  ON public.icu_audit_alerts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));

CREATE POLICY "Coordinators and admins acknowledge ICU audit alerts"
  ON public.icu_audit_alerts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'rota_coordinator'));