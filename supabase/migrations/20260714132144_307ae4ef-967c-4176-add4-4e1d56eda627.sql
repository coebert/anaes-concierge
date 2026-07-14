ALTER TABLE public.rota_assignments ADD COLUMN IF NOT EXISTS extra_type text;
COMMENT ON COLUMN public.rota_assignments.extra_type IS 'CLWRota extra_type marker (e.g. extra, locum, WLI). NULL = part of the job-planned rota.';
CREATE INDEX IF NOT EXISTS rota_assignments_extra_type_idx ON public.rota_assignments(extra_type) WHERE extra_type IS NOT NULL;