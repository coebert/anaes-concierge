ALTER TABLE public.rota_assignments
  ADD COLUMN IF NOT EXISTS locally_modified boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_rota_assignments_locally_modified
  ON public.rota_assignments (locally_modified)
  WHERE locally_modified = true;