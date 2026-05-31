CREATE TABLE IF NOT EXISTS public.rota_reclassification_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_run_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  from_role public.rota_role NOT NULL,
  to_role public.rota_role NOT NULL,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rota_reclassification_log_run
  ON public.rota_reclassification_log (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_rota_reclassification_log_assignment
  ON public.rota_reclassification_log (assignment_id);

GRANT SELECT, DELETE ON public.rota_reclassification_log TO authenticated;
GRANT ALL ON public.rota_reclassification_log TO service_role;

ALTER TABLE public.rota_reclassification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read reclassification log"
  ON public.rota_reclassification_log
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins delete reclassification log"
  ON public.rota_reclassification_log
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));